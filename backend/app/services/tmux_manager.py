from __future__ import annotations

import asyncio
import hashlib
import logging
from datetime import UTC, datetime

from ..config import config
from .bridge_manager import BridgeManager, bridge_source_from_container, is_bridge
from .debug_log import DebugLog
from .docker_manager import DockerManager

logger = logging.getLogger(__name__)

HOST_CONTAINER_ID = "host"
LOCAL_CONTAINER_ID = "local"


def _is_host(container_id: str) -> bool:
    return container_id == HOST_CONTAINER_ID


def _is_local(container_id: str) -> bool:
    return container_id == LOCAL_CONTAINER_ID


def _is_bridge(container_id: str) -> bool:
    return is_bridge(container_id)


def _is_special(container_id: str) -> bool:
    return _is_host(container_id) or _is_local(container_id) or _is_bridge(container_id)


def make_session_id(container_id: str, session_name: str) -> str:
    """Deterministic session ID: md5(container_id:session_name)[:12]."""
    return hashlib.md5(f"{container_id}:{session_name}".encode()).hexdigest()[:12]


class TmuxManager:
    """Manages tmux sessions inside Docker containers via ``docker exec``,
    or locally on the host when container_id == "host"."""

    _instance: TmuxManager | None = None

    def __init__(self) -> None:
        self._docker: DockerManager | None = None

    def _get_docker(self) -> DockerManager:
        if self._docker is None:
            self._docker = DockerManager.get()
        return self._docker

    @classmethod
    def get(cls) -> TmuxManager:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    async def _run_cmd(self, container_id: str, cmd: list[str]) -> str:
        """Run a command locally, on the host via socket, via bridge, or via docker exec."""
        if _is_local(container_id):
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await proc.communicate()
            return stdout.decode("utf-8", errors="replace")
        if _is_host(container_id):
            socket = config.host_tmux_socket
            # Insert -S <socket> after "tmux"
            host_cmd = [cmd[0], "-S", socket] + cmd[1:]
            proc = await asyncio.create_subprocess_exec(
                *host_cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await proc.communicate()
            return stdout.decode("utf-8", errors="replace")
        if _is_bridge(container_id):
            bm = BridgeManager.get()
            dl = DebugLog.get()
            conn = bm.get_bridge_for_container(container_id)
            if not conn:
                dl.warn("bridge", f"No bridge connection for {container_id}", f"cmd={cmd}")
                return ""
            try:
                source = bridge_source_from_container(container_id)
                result = await conn.request({
                    "type": "tmux_cmd", "cmd": cmd, "source": source,
                })
                if result.get("error"):
                    dl.error("bridge", f"tmux_cmd error: {result['error']}", f"container={container_id} cmd={cmd}")
                    logger.debug("Bridge tmux_cmd error: %s", result["error"])
                    return ""
                return result.get("output", "")
            except asyncio.TimeoutError:
                dl.error("bridge", f"tmux_cmd timed out for {container_id}", f"cmd={cmd}")
                logger.warning("Bridge tmux_cmd timed out for %s", container_id)
                return ""
        return await self._get_docker().exec_command(container_id, cmd)

    async def list_windows(self, container_id: str, session_name: str) -> list[dict]:
        """List all tmux windows in a session.

        Returns a list of dicts with: index, name, active, panes.
        """
        output = await self._run_cmd(
            container_id,
            [
                "tmux",
                "list-windows",
                "-t",
                session_name,
                "-F",
                "#{window_index}|#{window_name}|#{window_active}|#{window_panes}|#{window_bell_flag}|#{window_activity_flag}|#{pane_current_command}|#{@pane_status}",
            ],
        )
        windows = []
        for line in output.strip().splitlines():
            line = line.strip()
            if not line or "|" not in line:
                continue
            parts = line.split("|")
            if len(parts) < 4:
                continue
            windows.append(
                {
                    "index": int(parts[0]) if parts[0].isdigit() else 0,
                    "name": parts[1],
                    "active": parts[2] == "1",
                    "panes": int(parts[3]) if parts[3].isdigit() else 1,
                    "bell": parts[4] == "1" if len(parts) > 4 else False,
                    "activity": parts[5] == "1" if len(parts) > 5 else False,
                    "command": parts[6] if len(parts) > 6 else "",
                    "pane_status": parts[7] if len(parts) > 7 else "",
                }
            )
        return windows

    async def _list_all_windows(self, container_id: str) -> dict[str, list[dict]]:
        """List all windows across all sessions in a single tmux command.

        Returns a dict mapping session_name -> list of window dicts.
        """
        output = await self._run_cmd(
            container_id,
            [
                "tmux",
                "list-windows",
                "-a",
                "-F",
                "#{session_name}|#{window_index}|#{window_name}|#{window_active}|#{window_panes}|#{window_bell_flag}|#{window_activity_flag}|#{pane_current_command}|#{@pane_status}",
            ],
        )
        windows_by_session: dict[str, list[dict]] = {}
        for line in output.strip().splitlines():
            line = line.strip()
            if not line or "|" not in line:
                continue
            parts = line.split("|")
            if len(parts) < 5:
                continue
            session_name = parts[0]
            window = {
                "index": int(parts[1]) if parts[1].isdigit() else 0,
                "name": parts[2],
                "active": parts[3] == "1",
                "panes": int(parts[4]) if parts[4].isdigit() else 1,
                "bell": parts[5] == "1" if len(parts) > 5 else False,
                "activity": parts[6] == "1" if len(parts) > 6 else False,
                "command": parts[7] if len(parts) > 7 else "",
                "pane_status": parts[8] if len(parts) > 8 else "",
            }
            windows_by_session.setdefault(session_name, []).append(window)
        return windows_by_session

    async def list_sessions(self, container_id: str) -> list[dict]:
        """List all tmux sessions in a container (or on the host).

        Returns a list of dicts with: id, name, windows, created, attached.
        For bridge containers, returns the cached sessions reported by the bridge
        (which already include correct source-based IDs).
        """
        if _is_bridge(container_id):
            bm = BridgeManager.get()
            conn = bm.get_bridge_for_container(container_id)
            if conn:
                source = bridge_source_from_container(container_id)
                return [s for s in conn.sessions if s.get("source") == source]
            return []

        # Fetch sessions and all windows in just 2 commands (instead of 1+N)
        output = await self._run_cmd(
            container_id,
            [
                "tmux",
                "list-sessions",
                "-F",
                "#{session_name}|#{session_windows}|#{session_created}|#{session_attached}",
            ],
        )
        all_windows = await self._list_all_windows(container_id)

        sessions = []
        for line in output.strip().splitlines():
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

            windows = all_windows.get(name, [])

            sessions.append(
                {
                    "id": make_session_id(container_id, name),
                    "name": name,
                    "windows": windows,
                    "created": created,
                    "attached": attached,
                }
            )
        return sessions

    async def create_session(self, container_id: str, session_name: str) -> dict:
        """Create a new tmux session in the container (or on the host)."""
        dl = DebugLog.get()
        dl.info("tmux", f"Creating session '{session_name}'", f"container={container_id}")
        await self._run_cmd(
            container_id,
            ["tmux", "new-session", "-d", "-s", session_name],
        )
        # Enable CSI u extended key sequences (e.g. Shift+Enter → \x1b[13;2u)
        # so apps like Claude Code can distinguish modified keys.
        await self._run_cmd(
            container_id,
            ["tmux", "set-option", "-s", "extended-keys", "always"],
        )
        # Allow DCS passthrough so tmuxdeck-open can send OSC sequences
        # through tmux to xterm.js in the browser.
        await self._run_cmd(
            container_id,
            ["tmux", "set-option", "-g", "allow-passthrough", "on"],
        )
        # Enable activity monitoring so sidebar indicators work.
        await self._run_cmd(
            container_id,
            ["tmux", "set-option", "-g", "monitor-activity", "on"],
        )
        # No alert (no bell, no status message) — just set the window flag.
        await self._run_cmd(
            container_id,
            ["tmux", "set-option", "-g", "activity-action", "none"],
        )
        # Return the new session info
        return {
            "id": make_session_id(container_id, session_name),
            "name": session_name,
            "windows": [
                {
                    "index": 0, "name": "bash", "active": True,
                    "panes": 1, "bell": False, "activity": False,
                    "command": "bash", "pane_status": "",
                },
            ],
            "created": datetime.now(UTC).isoformat(),
            "attached": False,
        }

    async def rename_session(self, container_id: str, old_name: str, new_name: str) -> None:
        """Rename a tmux session."""
        await self._run_cmd(
            container_id,
            ["tmux", "rename-session", "-t", old_name, new_name],
        )

    async def kill_session(self, container_id: str, session_name: str) -> None:
        """Kill a tmux session."""
        await self._run_cmd(
            container_id,
            ["tmux", "kill-session", "-t", session_name],
        )

    async def resolve_session_id(self, container_id: str, session_id: str) -> str | None:
        """Resolve a session ID (md5 hash) to the actual tmux session name.

        Returns None if no match found.
        """
        sessions = await self.list_sessions(container_id)
        for s in sessions:
            if s["id"] == session_id:
                return s["name"]
        return None

    async def capture_pane(
        self, container_id: str, session_name: str, window_index: int = 0, ansi: bool = False
    ) -> str:
        """Capture the content of a tmux pane.

        When ansi=True, includes ANSI escape sequences (colors, bold).
        """
        cmd = ["tmux", "capture-pane", "-p", "-t", f"{session_name}:{window_index}"]
        if ansi:
            cmd.insert(3, "-e")  # insert -e before -t
        return await self._run_cmd(container_id, cmd)

    async def get_pane_width(
        self, container_id: str, session_name: str, window_index: int = 0
    ) -> int:
        """Return the width (columns) of a tmux pane."""
        out = await self._run_cmd(container_id, [
            "tmux", "display-message", "-p", "-t",
            f"{session_name}:{window_index}", "#{pane_width}",
        ])
        return int(out.strip())

    async def send_keys(
        self,
        container_id: str,
        session_name: str,
        window_index: int,
        text: str,
        enter: bool = True,
        submit: bool = False,
    ) -> None:
        """Send keys to a tmux pane.

        enter: append a single Enter keypress.
        submit: append two Enter keypresses (submits in Claude Code).
        """
        cmd = ["tmux", "send-keys", "-t", f"{session_name}:{window_index}", text]
        if submit:
            cmd += ["Enter", "Enter"]
        elif enter:
            cmd.append("Enter")
        await self._run_cmd(container_id, cmd)

    async def resolve_session_id_global(self, session_id: str) -> tuple[str, str] | None:
        """Resolve a session ID across all containers.

        Returns (container_id, session_name) or None if not found.
        """
        from ..api.containers import list_containers

        resp = await list_containers()
        for container in resp.containers:
            for session in container.sessions:
                if session.id == session_id:
                    return (container.id, session.name)
        return None

    async def swap_windows(self, container_id: str, session_name: str, index1: int, index2: int) -> None:
        """Swap two windows within the same tmux session."""
        await self._run_cmd(container_id, [
            "tmux", "swap-window",
            "-s", f"{session_name}:{index1}",
            "-t", f"{session_name}:{index2}",
        ])

    async def move_window(self, container_id: str, src_session: str, window_index: int, dst_session: str) -> None:
        """Move a window from one tmux session to another."""
        await self._run_cmd(container_id, [
            "tmux", "move-window",
            "-s", f"{src_session}:{window_index}",
            "-t", f"{dst_session}:",
        ])

    async def create_window(self, container_id: str, session_name: str, window_name: str | None = None) -> list[dict]:
        """Create a new window in a tmux session.

        Returns the updated list of windows after creation.
        """
        cmd = ["tmux", "new-window", "-t", session_name]
        if window_name:
            cmd += ["-n", window_name]
        await self._run_cmd(container_id, cmd)
        return await self.list_windows(container_id, session_name)

    async def set_pane_status(self, container_id: str, session_name: str, window_index: int, status: str) -> None:
        """Set @pane_status option on a tmux pane."""
        await self._run_cmd(container_id, [
            "tmux", "set-option", "-p", "-t", f"{session_name}:{window_index}", "@pane_status", status,
        ])

    async def list_panes(self, container_id: str, session_name: str, window_index: int) -> list[dict]:
        """List all tmux panes in a window.

        Returns a list of dicts with: index, active, width, height, title, command.
        """
        target = f"{session_name}:{window_index}"
        output = await self._run_cmd(
            container_id,
            [
                "tmux",
                "list-panes",
                "-t",
                target,
                "-F",
                "#{pane_index}|#{pane_active}|#{pane_width}|#{pane_height}|#{pane_title}|#{pane_current_command}",
            ],
        )
        panes = []
        for line in output.strip().splitlines():
            line = line.strip()
            if not line or "|" not in line:
                continue
            parts = line.split("|")
            if len(parts) < 4:
                continue
            panes.append(
                {
                    "index": int(parts[0]) if parts[0].isdigit() else 0,
                    "active": parts[1] == "1",
                    "width": int(parts[2]) if parts[2].isdigit() else 80,
                    "height": int(parts[3]) if parts[3].isdigit() else 24,
                    "title": parts[4] if len(parts) > 4 else "",
                    "command": parts[5] if len(parts) > 5 else "",
                }
            )
        return panes

    async def capture_pane_content(
        self, container_id: str, session_name: str, window_index: int, pane_index: int, max_lines: int = 2000
    ) -> str:
        """Capture pane scrollback content with ANSI escapes."""
        target = f"{session_name}:{window_index}.{pane_index}"
        output = await self._run_cmd(
            container_id,
            [
                "tmux",
                "capture-pane",
                "-p",
                "-e",
                "-S",
                f"-{max_lines}",
                "-t",
                target,
            ],
        )
        return output

    async def capture_active_pane_history(
        self, container_id: str, session_name: str, max_lines: int = 5000
    ) -> str:
        """Capture scrollback of the currently active pane in the session."""
        output = await self._run_cmd(
            container_id,
            [
                "tmux",
                "capture-pane",
                "-p",
                "-e",
                "-S",
                f"-{max_lines}",
                "-t",
                session_name,
            ],
        )
        return output

    async def ensure_session(self, container_id: str, session_name: str) -> None:
        """Create a session if it doesn't already exist."""
        sessions = await self.list_sessions(container_id)
        for s in sessions:
            if s["name"] == session_name:
                # Ensure extended-keys is on for existing sessions too
                await self._run_cmd(
                    container_id,
                    ["tmux", "set-option", "-s", "extended-keys", "always"],
                )
                await self._run_cmd(
                    container_id,
                    ["tmux", "set-option", "-g", "allow-passthrough", "on"],
                )
                # Enable activity monitoring so sidebar indicators work.
                await self._run_cmd(
                    container_id,
                    ["tmux", "set-option", "-g", "monitor-activity", "on"],
                )
                # No alert (no bell, no status message) — just set the window flag.
                await self._run_cmd(
                    container_id,
                    ["tmux", "set-option", "-g", "activity-action", "none"],
                )
                return
        await self.create_session(container_id, session_name)
