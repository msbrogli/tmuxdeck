"""Main bridge agent — connects to TmuxDeck backend and manages terminal sessions."""

from __future__ import annotations

import asyncio
import glob
import hashlib
import json
import logging
import os
import socket
import struct
from datetime import UTC, datetime
from pathlib import Path

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
        self._host_socket_broken = False
        # Session source lookup caches (rebuilt on each _collect_sessions)
        self._name_to_source: dict[str, str] = {}  # session_name → source
        self._id_to_source: dict[str, str] = {}  # session_id → source

    def _configured_sources(self) -> list[str]:
        """Return the list of configured session sources.

        Only includes sources that map 1:1 to sidebar containers.
        Docker sources are excluded here because they are discovered
        dynamically as "docker:<container_id>" during session collection.
        """
        sources = []
        if self.config.local:
            sources.append("local")
        if self.config.host_tmux_socket and not self._host_socket_broken:
            sources.append("host")
        return sources

    def _test_socket_connectable(self, path: str) -> bool:
        """Try to connect to a Unix domain socket. Returns True if connectable."""
        import socket as _socket

        try:
            sock = _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM)
            sock.settimeout(2)
            sock.connect(path)
            sock.close()
            return True
        except (OSError, _socket.error):
            return False

    def _log_startup_info(self) -> None:
        """Log configured sources and scan for tmux sockets."""
        logger.info("=== Bridge startup diagnostics ===")
        logger.info("Bridge name: %s", self.config.name)

        # Configured sources
        sources = []
        if self.config.local:
            sources.append("local")
        if self.config.host_tmux_socket:
            sources.append(f"host ({self.config.host_tmux_socket})")
        if self.config.docker_socket:
            sources.append(f"docker ({self.config.docker_socket})")
        logger.info("Configured sources: %s", ", ".join(sources) if sources else "NONE")

        # Check host tmux socket
        if self.config.host_tmux_socket:
            sock_path = Path(self.config.host_tmux_socket)
            try:
                exists = sock_path.exists()
            except OSError:
                # stat() fails on some Docker-mounted Unix sockets — path is there
                logger.info("Host tmux socket FOUND (stat failed, likely mounted socket): %s", sock_path)
                exists = True
            if exists:
                logger.info("Host tmux socket EXISTS: %s", sock_path)
                if self._test_socket_connectable(str(sock_path)):
                    logger.info("Host tmux socket CONNECTABLE: %s", sock_path)
                else:
                    logger.warning(
                        "Host tmux socket EXISTS but NOT CONNECTABLE: %s — "
                        "this typically happens on Docker Desktop (macOS/Windows) where "
                        "Unix domain sockets cannot cross the VM boundary. "
                        "The host source will be disabled. "
                        "Run the bridge natively to use host tmux sockets.",
                        sock_path,
                    )
                    self._host_socket_broken = True
            else:
                logger.warning("Host tmux socket NOT FOUND: %s", sock_path)
                # Check parent directory
                parent = sock_path.parent
                try:
                    parent_exists = parent.exists()
                except OSError:
                    parent_exists = False
                if parent_exists:
                    try:
                        contents = list(parent.iterdir())
                    except OSError:
                        contents = []
                    logger.info("  Parent dir %s contains: %s",
                                parent, [f.name for f in contents])
                else:
                    logger.warning("  Parent dir %s does NOT exist", parent)

        # Scan for tmux sockets in common locations
        found_sockets: list[str] = []
        for pattern in ["/tmp/tmux-*/", "/tmp/tmux-host/", "/run/tmux/*/",
                        "/tmp/tmux-*/default", "/tmp/tmux-host/default"]:
            found_sockets.extend(glob.glob(pattern))
        if found_sockets:
            logger.info("Tmux sockets/dirs found on filesystem:")
            for s in sorted(set(found_sockets)):
                p = Path(s)
                try:
                    kind = "socket" if p.is_socket() else "dir" if p.is_dir() else "file"
                except OSError:
                    kind = "stat-error"
                logger.info("  %s [%s]", s, kind)
        else:
            logger.info("No tmux sockets found in /tmp/tmux-* or /run/tmux/")

        # Check docker socket
        if self.config.docker_socket:
            try:
                docker_exists = Path(self.config.docker_socket).exists()
            except OSError:
                docker_exists = True  # stat failed but path is mounted
            if docker_exists:
                logger.info("Docker socket EXISTS: %s", self.config.docker_socket)
            else:
                logger.warning("Docker socket NOT FOUND: %s", self.config.docker_socket)

        logger.info("=== End diagnostics ===")

    async def run(self) -> None:
        """Auto-reconnect loop with exponential backoff."""
        self._log_startup_info()
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
                    family=socket.AF_INET6 if self.config.ipv6 else socket.AF_INET,
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
                        "sources": self._configured_sources(),
                    }))
                except Exception as e:
                    logger.debug("Session report failed: %s", e)

        # Send initial session list
        try:
            sessions = await self._collect_sessions()
            # Log per-source summary at INFO level for visibility
            by_src: dict[str, int] = {}
            for s in sessions:
                src = s.get("source", "local")
                by_src[src] = by_src.get(src, 0) + 1
            logger.info("Initial session report: %d total %s",
                        len(sessions),
                        ", ".join(f"{k}={v}" for k, v in sorted(by_src.items()))
                        if by_src else "(no sessions)")
            await ws.send(json.dumps({
                "type": "sessions",
                "sessions": sessions,
                "sources": self._configured_sources(),
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
                "sources": self._configured_sources(),
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

        source = self._resolve_source(msg, session_name)
        cmd = self._build_cmd_for_source(
            ["tmux", "attach-session", "-t", target],
            source,
            interactive=source.startswith("docker:"),
        )

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
            logger.info("Attached ch %d to %s (source=%s)", channel_id, target, source)
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

        session_name = self._extract_session_name_from_cmd(cmd)
        source = self._resolve_source(msg, session_name)
        cmd = self._build_cmd_for_source(cmd, source)

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

    # --- Source-aware command routing ---

    def _build_cmd_for_source(
        self, cmd: list[str], source: str, interactive: bool = False,
    ) -> list[str]:
        """Build a command routed to the correct tmux source.

        source: "local", "host", or "docker:<container_short_id>"
        interactive: if True, adds -it flags for docker exec (needed for attach)
        """
        if source == "local":
            return cmd

        if source == "host":
            if cmd and cmd[0] == "tmux":
                return [cmd[0], "-S", self.config.host_tmux_socket] + cmd[1:]
            return cmd

        if source.startswith("docker:"):
            container_id = source.split(":", 1)[1]
            docker_cmd = ["docker"]
            if self.config.docker_socket:
                docker_cmd += ["-H", f"unix://{self.config.docker_socket}"]
            docker_cmd.append("exec")
            if interactive:
                docker_cmd.append("-it")
            docker_cmd.append(container_id)
            docker_cmd.extend(cmd)
            return docker_cmd

        # Fallback: treat as local
        logger.warning("Unknown source '%s', falling back to local", source)
        return cmd

    def _resolve_source(self, msg: dict, session_name: str = "") -> str:
        """Determine the source from the message or by looking up the session cache.

        Priority: explicit source in message > session name lookup > config default.
        """
        # Explicit source from protocol (sent by new backends)
        source = msg.get("source")
        if source:
            return source

        # Try name lookup (works when session names are unique across sources)
        if session_name and session_name in self._name_to_source:
            return self._name_to_source[session_name]

        # Config-based fallback (single-source bridges)
        if self.config.local:
            return "local"
        if self.config.host_tmux_socket:
            return "host"
        return "local"

    @staticmethod
    def _extract_session_name_from_cmd(cmd: list[str]) -> str:
        """Try to extract a session name from a tmux command for source lookup."""
        for flag in ("-t", "-s"):
            if flag in cmd:
                try:
                    idx = cmd.index(flag)
                    if idx + 1 < len(cmd):
                        target = cmd[idx + 1]
                        return target.split(":")[0]
                except (ValueError, IndexError):
                    pass
        return ""

    # --- Session collection ---

    async def _collect_sessions(self) -> list[dict]:
        """Collect tmux sessions from all configured sources.

        Mirrors the backend's approach: local, host socket, docker containers.
        Each session is tagged with a 'source' field for routing.
        """
        all_sessions: list[dict] = []

        # Local tmux sessions
        if self.config.local:
            local = await self._list_tmux_sessions([], source="local")
            all_sessions.extend(local)
            logger.info("Local: %d sessions", len(local))

        # Host tmux socket sessions
        if self.config.host_tmux_socket and not self._host_socket_broken:
            host = await self._list_tmux_sessions(
                ["-S", self.config.host_tmux_socket],
                source="host",
            )
            all_sessions.extend(host)
            logger.info("Host: %d sessions", len(host))

        # Docker container tmux sessions
        if self.config.docker_socket:
            docker = await self._collect_docker_sessions()
            all_sessions.extend(docker)
            logger.info("Docker: %d sessions", len(docker))

        # Rebuild session→source lookup caches
        self._id_to_source = {}
        self._name_to_source = {}
        for s in all_sessions:
            src = s.get("source", "local")
            self._id_to_source[s["id"]] = src
            self._name_to_source[s["name"]] = src

        return all_sessions

    async def _list_tmux_sessions(
        self, extra_args: list[str], source: str = "local",
    ) -> list[dict]:
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
        except (asyncio.TimeoutError, FileNotFoundError, OSError) as e:
            logger.warning("tmux list-sessions failed (source=%s): %s", source, e)
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

            session_id = hashlib.md5(
                f"bridge:{source}:{name}".encode()
            ).hexdigest()[:12]

            sessions.append({
                "id": session_id,
                "name": name,
                "source": source,
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

        Uses docker-py to list containers and run tmux commands.
        """
        if not self.config.docker_socket:
            return []

        try:
            import docker as docker_lib
        except ImportError:
            # Only warn once — this method is called every report interval
            if not getattr(self, "_docker_import_warned", False):
                logger.warning("docker package not installed — install with: "
                               "uv pip install docker")
                self._docker_import_warned = True
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
            source = f"docker:{container.short_id}"
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

                    session_id = hashlib.md5(
                        f"bridge:{source}:{name}".encode()
                    ).hexdigest()[:12]

                    all_sessions.append({
                        "id": session_id,
                        "name": name,
                        "source": source,
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
