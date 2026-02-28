"""Terminal session management — PTY + tmux attach for bridge channels."""

from __future__ import annotations

import asyncio
import fcntl
import logging
import os
import pty
import signal
import struct
import termios
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import websockets

logger = logging.getLogger(__name__)


class TerminalSession:
    """Manages a single PTY running tmux attach, connected to a bridge channel."""

    def __init__(
        self,
        channel_id: int,
        ws: websockets.ClientConnection,
        cmd: list[str],
    ) -> None:
        self.channel_id = channel_id
        self._ws = ws
        self._cmd = cmd
        self._master_fd: int | None = None
        self._proc: asyncio.subprocess.Process | None = None
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        """Spawn the PTY process and start the read loop."""
        env = os.environ.copy()
        env.pop("TMUX", None)
        env["TERM"] = "xterm-256color"

        master_fd, slave_fd = pty.openpty()
        self._master_fd = master_fd

        self._proc = await asyncio.create_subprocess_exec(
            *self._cmd,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            env=env,
        )
        os.close(slave_fd)

        self._task = asyncio.create_task(self._read_loop())

    async def _read_loop(self) -> None:
        """Read from PTY and send binary frames with channel header to backend."""
        loop = asyncio.get_event_loop()
        header = struct.pack(">H", self.channel_id)
        try:
            while True:
                data = await loop.run_in_executor(None, os.read, self._master_fd, 4096)
                if not data:
                    break
                await self._ws.send(header + data)
        except OSError:
            pass
        except Exception as e:
            logger.debug("Terminal read loop error (ch %d): %s", self.channel_id, e)

    def write(self, data: bytes) -> None:
        """Write data to the PTY (terminal input from user)."""
        if self._master_fd is not None:
            try:
                os.write(self._master_fd, data)
            except OSError:
                pass

    def resize(self, cols: int, rows: int) -> None:
        """Resize the PTY."""
        if self._master_fd is not None:
            try:
                winsize = struct.pack("HHHH", rows, cols, 0, 0)
                fcntl.ioctl(self._master_fd, termios.TIOCSWINSZ, winsize)
                if self._proc and self._proc.returncode is None:
                    self._proc.send_signal(signal.SIGWINCH)
            except OSError as e:
                logger.debug("Resize failed (ch %d): %s", self.channel_id, e)

    async def stop(self) -> None:
        """Terminate the PTY process and clean up."""
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        if self._master_fd is not None:
            try:
                os.close(self._master_fd)
            except OSError:
                pass
            self._master_fd = None
        if self._proc and self._proc.returncode is None:
            try:
                self._proc.terminate()
            except ProcessLookupError:
                pass
            await self._proc.wait()
