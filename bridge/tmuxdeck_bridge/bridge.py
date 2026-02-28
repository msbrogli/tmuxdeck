"""Main bridge agent — connects to TmuxDeck backend and manages terminal sessions."""

from __future__ import annotations

import asyncio
import json
import logging
import struct
from datetime import UTC, datetime

import websockets

from .config import BridgeConfig
from .terminal import TerminalSession

logger = logging.getLogger(__name__)


class Bridge:
    """Bridge agent that connects to TmuxDeck backend via WebSocket."""

    def __init__(self, config: BridgeConfig) -> None:
        self.config = config
        self._ws: websockets.ClientConnection | None = None
        self._terminals: dict[int, TerminalSession] = {}  # channel_id → session
        self._running = False

    async def run(self) -> None:
        """Auto-reconnect loop with exponential backoff."""
        self._running = True
        delay = self.config.reconnect_min

        while self._running:
            try:
                logger.info("Connecting to %s ...", self.config.url)
                async with websockets.connect(
                    self.config.url,
                    max_size=2**20,
                    ping_interval=30,
                    ping_timeout=10,
                ) as ws:
                    self._ws = ws
                    delay = self.config.reconnect_min  # reset on success

                    if not await self._authenticate(ws):
                        logger.error("Authentication failed, stopping")
                        return  # auth failure is permanent

                    logger.info("Connected and authenticated as '%s'", self.config.name)
                    await self._session_loop(ws)

            except websockets.ConnectionClosed as e:
                logger.warning("Connection closed: %s", e)
            except (OSError, ConnectionRefusedError) as e:
                logger.warning("Connection failed: %s", e)
            except Exception as e:
                logger.error("Unexpected error: %s", e)
            finally:
                self._ws = None
                await self._cleanup_terminals()

            if not self._running:
                break

            logger.info("Reconnecting in %.0fs...", delay)
            await asyncio.sleep(delay)
            delay = min(delay * 2, self.config.reconnect_max)

    def stop(self) -> None:
        self._running = False

    async def _authenticate(self, ws: websockets.ClientConnection) -> bool:
        """Send auth message and wait for response."""
        await ws.send(json.dumps({
            "type": "auth",
            "token": self.config.token,
            "name": self.config.name,
        }))

        raw = await asyncio.wait_for(ws.recv(), timeout=10)
        msg = json.loads(raw)

        if msg.get("type") == "auth_ok":
            return True
        elif msg.get("type") == "auth_error":
            logger.error("Auth rejected: %s", msg.get("reason", "unknown"))
            return False
        else:
            logger.error("Unexpected auth response: %s", msg)
            return False

    async def _session_loop(self, ws: websockets.ClientConnection) -> None:
        """Main loop: handle messages + periodically report sessions."""

        async def message_handler():
            async for message in ws:
                if isinstance(message, bytes):
                    await self._handle_binary(message)
                else:
                    await self._handle_json(json.loads(message))

        async def session_reporter():
            while True:
                await asyncio.sleep(self.config.session_report_interval)
                try:
                    sessions = await self._collect_sessions()
                    await ws.send(json.dumps({
                        "type": "sessions",
                        "sessions": sessions,
                    }))
                except Exception as e:
                    logger.debug("Session report failed: %s", e)

        # Send initial session list
        try:
            sessions = await self._collect_sessions()
            await ws.send(json.dumps({
                "type": "sessions",
                "sessions": sessions,
            }))
        except Exception as e:
            logger.debug("Initial session report failed: %s", e)

        reporter = asyncio.create_task(session_reporter())
        try:
            await message_handler()
        finally:
            reporter.cancel()
            try:
                await reporter
            except asyncio.CancelledError:
                pass

    async def _handle_binary(self, data: bytes) -> None:
        """Route binary frame to the correct terminal session."""
        if len(data) < 2:
            return
        channel_id = struct.unpack(">H", data[:2])[0]
        payload = data[2:]
        terminal = self._terminals.get(channel_id)
        if terminal:
            terminal.write(payload)

    async def _handle_json(self, msg: dict) -> None:
        """Handle a JSON control message from backend."""
        msg_type = msg.get("type", "")

        if msg_type == "attach":
            await self._handle_attach(msg)
        elif msg_type == "detach":
            await self._handle_detach(msg)
        elif msg_type == "resize":
            self._handle_resize(msg)
        elif msg_type == "tmux_cmd":
            await self._handle_tmux_cmd(msg)
        elif msg_type == "list_sessions":
            sessions = await self._collect_sessions()
            await self._ws.send(json.dumps({
                "type": "sessions",
                "sessions": sessions,
            }))
        elif msg_type == "ping":
            await self._ws.send(json.dumps({"type": "pong"}))
        else:
            logger.debug("Unknown message type: %s", msg_type)

    async def _handle_attach(self, msg: dict) -> None:
        """Attach to a tmux session and start a PTY."""
        req_id = msg.get("id", "")
        session_name = msg.get("session_name", "")
        window_index = msg.get("window_index", 0)
        channel_id = msg.get("channel_id", 0)
        cols = msg.get("cols", 80)
        rows = msg.get("rows", 24)
        target = f"{session_name}:{window_index}"

        cmd = self._build_tmux_cmd(["tmux", "attach-session", "-t", target])

        try:
            terminal = TerminalSession(channel_id, self._ws, cmd)
            await terminal.start()
            terminal.resize(cols, rows)
            self._terminals[channel_id] = terminal
            await self._ws.send(json.dumps({
                "type": "attach_ok",
                "id": req_id,
                "channel_id": channel_id,
            }))
            logger.info("Attached ch %d to %s", channel_id, target)
        except Exception as e:
            logger.error("Attach failed for %s: %s", target, e)
            await self._ws.send(json.dumps({
                "type": "attach_error",
                "id": req_id,
                "channel_id": channel_id,
                "reason": str(e),
            }))

    async def _handle_detach(self, msg: dict) -> None:
        """Detach a terminal session."""
        channel_id = msg.get("channel_id", 0)
        terminal = self._terminals.pop(channel_id, None)
        if terminal:
            await terminal.stop()
            logger.info("Detached ch %d", channel_id)

    def _handle_resize(self, msg: dict) -> None:
        """Resize a terminal session."""
        channel_id = msg.get("channel_id", 0)
        cols = msg.get("cols", 80)
        rows = msg.get("rows", 24)
        terminal = self._terminals.get(channel_id)
        if terminal:
            terminal.resize(cols, rows)

    async def _handle_tmux_cmd(self, msg: dict) -> None:
        """Run a tmux command and return the result."""
        req_id = msg.get("id", "")
        cmd = msg.get("cmd", [])
        if not cmd:
            await self._ws.send(json.dumps({
                "type": "cmd_result",
                "id": req_id,
                "output": "",
                "error": "Empty command",
            }))
            return

        cmd = self._build_tmux_cmd(cmd)

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=10)
            output = stdout.decode("utf-8", errors="replace")
            error = stderr.decode("utf-8", errors="replace") if proc.returncode != 0 else None
            await self._ws.send(json.dumps({
                "type": "cmd_result",
                "id": req_id,
                "output": output,
                "error": error,
            }))
        except asyncio.TimeoutError:
            await self._ws.send(json.dumps({
                "type": "cmd_result",
                "id": req_id,
                "output": "",
                "error": "Command timed out",
            }))
        except Exception as e:
            await self._ws.send(json.dumps({
                "type": "cmd_result",
                "id": req_id,
                "output": "",
                "error": str(e),
            }))

    def _build_tmux_cmd(self, cmd: list[str]) -> list[str]:
        """Apply host socket to tmux command if configured.

        If host_tmux_socket is set, inserts -S <socket> after 'tmux'.
        """
        if self.config.host_tmux_socket and cmd and cmd[0] == "tmux":
            return [cmd[0], "-S", self.config.host_tmux_socket] + cmd[1:]
        return cmd

    async def _collect_sessions(self) -> list[dict]:
        """Collect tmux sessions from all configured sources.

        Mirrors the backend's approach: local, host socket, docker containers.
        """
        all_sessions: list[dict] = []

        # Local tmux sessions
        if self.config.local:
            local = await self._list_tmux_sessions([])
            all_sessions.extend(local)

        # Host tmux socket sessions
        if self.config.host_tmux_socket:
            host = await self._list_tmux_sessions(
                ["-S", self.config.host_tmux_socket]
            )
            all_sessions.extend(host)

        # Docker container tmux sessions
        if self.config.docker_socket:
            docker = await self._collect_docker_sessions()
            all_sessions.extend(docker)

        return all_sessions

    async def _list_tmux_sessions(self, extra_args: list[str]) -> list[dict]:
        """List tmux sessions using tmux list-sessions + list-windows."""
        cmd = ["tmux"] + extra_args + [
            "list-sessions", "-F",
            "#{session_name}|#{session_windows}|#{session_created}|#{session_attached}",
        ]
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
        except (asyncio.TimeoutError, FileNotFoundError, OSError):
            return []

        sessions = []
        for line in stdout.decode("utf-8", errors="replace").strip().splitlines():
            line = line.strip()
            if not line or "|" not in line:
                continue
            parts = line.split("|")
            if len(parts) < 4:
                continue
            name = parts[0]
            try:
                created_ts = int(parts[2])
                created = datetime.fromtimestamp(created_ts, tz=UTC).isoformat()
            except (ValueError, OSError):
                created = datetime.now(UTC).isoformat()
            attached = parts[3] == "1"

            windows = await self._list_tmux_windows(extra_args, name)

            import hashlib
            session_id = hashlib.md5(
                f"bridge:{name}".encode()
            ).hexdigest()[:12]

            sessions.append({
                "id": session_id,
                "name": name,
                "windows": windows,
                "created": created,
                "attached": attached,
            })
        return sessions

    async def _list_tmux_windows(self, extra_args: list[str], session_name: str) -> list[dict]:
        """List windows for a tmux session."""
        cmd = ["tmux"] + extra_args + [
            "list-windows", "-t", session_name, "-F",
            "#{window_index}|#{window_name}|#{window_active}|#{window_panes}|#{window_bell_flag}|#{window_activity_flag}|#{pane_current_command}|#{@pane_status}",
        ]
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
        except (asyncio.TimeoutError, FileNotFoundError, OSError):
            return []

        windows = []
        for line in stdout.decode("utf-8", errors="replace").strip().splitlines():
            line = line.strip()
            if not line or "|" not in line:
                continue
            parts = line.split("|")
            if len(parts) < 4:
                continue
            windows.append({
                "index": int(parts[0]) if parts[0].isdigit() else 0,
                "name": parts[1],
                "active": parts[2] == "1",
                "panes": int(parts[3]) if parts[3].isdigit() else 1,
                "bell": parts[4] == "1" if len(parts) > 4 else False,
                "activity": parts[5] == "1" if len(parts) > 5 else False,
                "command": parts[6] if len(parts) > 6 else "",
                "pane_status": parts[7] if len(parts) > 7 else "",
            })
        return windows

    async def _collect_docker_sessions(self) -> list[dict]:
        """Collect tmux sessions from Docker containers.

        Uses docker exec to run tmux commands in running containers.
        """
        if not self.config.docker_socket:
            return []

        try:
            import docker as docker_lib
        except ImportError:
            logger.warning("docker package not installed, skipping Docker container tmux")
            return []

        try:
            client = docker_lib.DockerClient(
                base_url=f"unix://{self.config.docker_socket}"
            )
            filters = {}
            if self.config.docker_label:
                filters["label"] = self.config.docker_label
            containers = client.containers.list(filters=filters)
        except Exception as e:
            logger.debug("Docker list failed: %s", e)
            return []

        all_sessions: list[dict] = []
        for container in containers:
            try:
                result = container.exec_run(
                    ["tmux", "list-sessions", "-F",
                     "#{session_name}|#{session_windows}|#{session_created}|#{session_attached}"],
                    demux=True,
                )
                if result.exit_code != 0:
                    continue
                stdout = result.output[0] if result.output[0] else b""
                for line in stdout.decode("utf-8", errors="replace").strip().splitlines():
                    line = line.strip()
                    if not line or "|" not in line:
                        continue
                    parts = line.split("|")
                    if len(parts) < 4:
                        continue
                    name = parts[0]
                    try:
                        created_ts = int(parts[2])
                        created = datetime.fromtimestamp(created_ts, tz=UTC).isoformat()
                    except (ValueError, OSError):
                        created = datetime.now(UTC).isoformat()
                    attached = parts[3] == "1"

                    import hashlib
                    session_id = hashlib.md5(
                        f"bridge:{container.short_id}:{name}".encode()
                    ).hexdigest()[:12]

                    all_sessions.append({
                        "id": session_id,
                        "name": name,
                        "windows": [],  # skip windows for docker discovery to keep it fast
                        "created": created,
                        "attached": attached,
                    })
            except Exception as e:
                logger.debug("Docker container %s tmux list failed: %s", container.short_id, e)

        return all_sessions

    async def _cleanup_terminals(self) -> None:
        """Stop all terminal sessions."""
        for channel_id, terminal in list(self._terminals.items()):
            await terminal.stop()
        self._terminals.clear()
