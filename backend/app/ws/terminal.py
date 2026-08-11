from __future__ import annotations

import asyncio
import contextlib
import fcntl
import json
import logging
import os
import pty
import random
import time
import signal
import struct
import termios
import uuid

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .. import auth
from ..config import config
import socket as _socket

from ..services.bridge_manager import BridgeManager, TerminalInfo, bridge_id_from_container, bridge_source_from_container, is_bridge
from ..services.docker_manager import DockerManager
from ..services.tmux_manager import TmuxManager, _is_host, _is_local

logger = logging.getLogger(__name__)
router = APIRouter()


def _clean_env() -> dict[str, str]:
    """Return a copy of os.environ without TMUX to allow nested attach."""
    env = os.environ.copy()
    env.pop("TMUX", None)
    # Tell tmux the outer terminal is xterm-compatible (supports CSI u, etc.)
    env["TERM"] = "xterm-256color"
    return env


VIEW_SESSION_PREFIX = "_view_"


async def _create_view_session(
    tmux_prefix: list[str], original_session: str, window_index: int,
) -> str:
    """Create a grouped (linked) tmux session for independent window navigation.

    Returns the view session name.  The grouped session shares the same
    window group as *original_session* but has its own "current window"
    pointer, allowing multiple clients to view different windows.
    """
    view_name = f"{VIEW_SESSION_PREFIX}{uuid.uuid4().hex[:8]}"
    proc = await asyncio.create_subprocess_exec(
        *tmux_prefix, "new-session", "-d", "-t", original_session, "-s", view_name,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
        env=_clean_env(),
    )
    await asyncio.wait_for(proc.wait(), timeout=10.0)
    if proc.returncode != 0:
        raise RuntimeError(f"Failed to create view session for {original_session}")
    return view_name


async def _kill_view_session(tmux_prefix: list[str], view_name: str) -> None:
    """Best-effort cleanup of a grouped view session."""
    with contextlib.suppress(Exception):
        proc = await asyncio.create_subprocess_exec(
            *tmux_prefix, "kill-session", "-t", view_name,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            env=_clean_env(),
        )
        await asyncio.wait_for(proc.wait(), timeout=5.0)


async def _set_tmux_extended_keys(tmux_prefix: list[str]) -> None:
    """Enable CSI u extended key sequences in the tmux server.

    This lets tmux forward modified-key sequences (e.g. Shift+Enter as
    \\x1b[13;2u) to applications running inside it.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            *tmux_prefix, "set-option", "-s", "extended-keys", "always",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(proc.wait(), timeout=5.0)
    except (OSError, asyncio.TimeoutError):
        pass  # tmux may not support extended-keys on older versions


async def _is_alternate_screen(tmux_prefix: list[str], session_name: str) -> bool:
    """Check if the active pane in the tmux session uses the alternate screen."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *tmux_prefix, "display-message", "-p", "-t", session_name,
            "#{alternate_on}",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5.0)
        return stdout.decode().strip() == "1"
    except (OSError, asyncio.TimeoutError):
        return False


async def _set_tmux_passthrough(tmux_prefix: list[str]) -> None:
    """Enable DCS passthrough so tmuxdeck-open can send OSC sequences
    through tmux to xterm.js in the browser (requires tmux >= 3.3a)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *tmux_prefix, "set-option", "-g", "allow-passthrough", "on",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(proc.wait(), timeout=5.0)
    except (OSError, asyncio.TimeoutError):
        pass


async def _set_tmux_monitor_activity(tmux_prefix: list[str]) -> None:
    """Enable activity monitoring so #{window_activity_flag} works."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *tmux_prefix, "set-option", "-g", "monitor-activity", "on",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(proc.wait(), timeout=5.0)
        # Set activity-action to none so tmux sets the window flag
        # without generating any alert (no bell, no status message).
        proc = await asyncio.create_subprocess_exec(
            *tmux_prefix, "set-option", "-g", "activity-action", "none",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(proc.wait(), timeout=5.0)
    except (OSError, asyncio.TimeoutError):
        pass


async def _set_tmux_auto_rename(tmux_prefix: list[str]) -> None:
    """Set automatic-rename-format for descriptive window titles."""
    from .. import store
    from ..services.tmux_manager import DEFAULT_AUTO_RENAME_FORMAT
    settings = await asyncio.to_thread(store.get_settings)
    fmt = settings.get("tmuxAutoRenameFormat", "")
    fmt = fmt if fmt else DEFAULT_AUTO_RENAME_FORMAT
    try:
        proc = await asyncio.create_subprocess_exec(
            *tmux_prefix, "set-option", "-gw", "automatic-rename", "on",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(proc.wait(), timeout=5.0)
        proc = await asyncio.create_subprocess_exec(
            *tmux_prefix, "set-option", "-gw", "automatic-rename-format", fmt,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(proc.wait(), timeout=5.0)
    except (OSError, asyncio.TimeoutError):
        pass


async def _get_tmux_option(tmux_prefix: list[str], option: str) -> str:
    """Read a global tmux option value. Returns empty string on error."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *tmux_prefix, "show-options", "-gv", option,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await proc.communicate()
        return stdout.decode().strip()
    except OSError:
        return ""


async def _check_tmux_mouse(tmux_prefix: list[str]) -> bool:
    """Return True if tmux global mouse option is 'on'."""
    return await _get_tmux_option(tmux_prefix, "mouse") == "on"


async def _tmux_session_exists(tmux_prefix: list[str], target: str) -> bool:
    """Check whether a tmux session/window target exists."""
    proc = await asyncio.create_subprocess_exec(
        *tmux_prefix, "has-session", "-t", target,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
        env=_clean_env(),
    )
    return await proc.wait() == 0


async def _check_tmux_bell(tmux_prefix: list[str]) -> dict[str, str] | None:
    """Return dict of bell-related problems, or None if everything is fine."""
    problems: dict[str, str] = {}
    bell_action = await _get_tmux_option(tmux_prefix, "bell-action")
    if bell_action == "none":
        problems["bellAction"] = bell_action
    visual_bell = await _get_tmux_option(tmux_prefix, "visual-bell")
    if visual_bell == "on":
        problems["visualBell"] = visual_bell
    return problems or None


async def _pty_terminal(
    websocket: WebSocket,
    cmd: list[str],
    label: str = "PTY",
    tmux_prefix: list[str] | None = None,
    session_name: str | None = None,
    container_id: str | None = None,
    original_session: str | None = None,
) -> None:
    """Handle a tmux session via a local PTY with the given command.

    If *tmux_prefix* and *session_name* are provided, the handler also
    supports ``SELECT_WINDOW:<index>`` control messages which let the
    frontend switch tmux windows without tearing down the connection.
    """
    master_fd, slave_fd = pty.openpty()

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        env=_clean_env(),
    )
    os.close(slave_fd)

    # Warn frontend if tmux mouse mode is on (breaks text selection)
    if tmux_prefix and await _check_tmux_mouse(tmux_prefix):
        await websocket.send_text("MOUSE_WARNING:on")

    # Warn frontend if tmux bell settings prevent bell propagation
    if tmux_prefix:
        bell_problems = await _check_tmux_bell(tmux_prefix)
        if bell_problems:
            await websocket.send_text(f"BELL_WARNING:{json.dumps(bell_problems)}")

    loop = asyncio.get_event_loop()
    start_time = time.monotonic()
    sent_data = False

    async def pty_to_ws() -> None:
        """Read PTY output and forward to WebSocket.

        Uses select() to drain all immediately available data before sending,
        coalescing many small reads into fewer WebSocket frames.  This prevents
        high-throughput terminals (e.g. scrolling large files) from monopolising
        the event loop with hundreds of individual send_bytes calls.
        """
        nonlocal sent_data
        import select

        def _read_coalesced() -> bytes:
            """Blocking read: wait for first chunk, then drain everything available."""
            # First read blocks until data arrives
            data = os.read(master_fd, 65536)
            if not data:
                return b""
            chunks = [data]
            total = len(data)
            # Drain any additional immediately available data (non-blocking)
            while total < 256_000:
                r, _, _ = select.select([master_fd], [], [], 0)
                if not r:
                    break
                try:
                    more = os.read(master_fd, 65536)
                except OSError:
                    break
                if not more:
                    break
                chunks.append(more)
                total += len(more)
            return b"".join(chunks) if len(chunks) > 1 else chunks[0]

        try:
            while True:
                data = await loop.run_in_executor(None, _read_coalesced)
                if not data:
                    break
                sent_data = True
                await websocket.send_bytes(data)
                # Yield so the event loop can process other work
                await asyncio.sleep(0)
        except (OSError, WebSocketDisconnect, RuntimeError):
            pass

    async def ws_to_pty() -> None:
        try:
            while True:
                msg = await websocket.receive()

                if msg.get("type") == "websocket.disconnect":
                    break

                if "text" in msg:
                    text = msg["text"]
                    if text.startswith("RESIZE:"):
                        parts = text.split(":")
                        if len(parts) == 3:
                            try:
                                cols = int(parts[1])
                                rows = int(parts[2])
                                winsize = struct.pack("HHHH", rows, cols, 0, 0)
                                fcntl.ioctl(master_fd, termios.TIOCSWINSZ, winsize)
                                # PTY slave may not be a controlling terminal, so
                                # SIGWINCH is not auto-delivered.  Notify explicitly.
                                if proc.returncode is None:
                                    proc.send_signal(signal.SIGWINCH)
                            except (ValueError, OSError) as e:
                                logger.debug("%s resize failed: %s", label, e)
                        continue
                    if text.startswith("SELECT_WINDOW:") and tmux_prefix and session_name:
                        try:
                            win_idx = int(text.split(":", 1)[1])
                            target = f"{session_name}:{win_idx}"
                            sw = await asyncio.create_subprocess_exec(
                                *tmux_prefix, "select-window", "-t", target,
                                stdout=asyncio.subprocess.DEVNULL,
                                stderr=asyncio.subprocess.DEVNULL,
                                env=_clean_env(),
                            )
                            await sw.wait()
                            # Force a full client redraw.  tmux's select-window
                            # issued via the command channel does NOT repaint
                            # the attached client — it only mutates server
                            # state — so cells not explicitly rewritten by the
                            # new window's program leak from the previous
                            # window (visible overlap / partial blanks).
                            # refresh-client fixes this the same way pressing
                            # prefix-n inside the attached client does.
                            rc = await asyncio.create_subprocess_exec(
                                *tmux_prefix, "refresh-client", "-t", session_name,
                                stdout=asyncio.subprocess.DEVNULL,
                                stderr=asyncio.subprocess.DEVNULL,
                                env=_clean_env(),
                            )
                            await rc.wait()
                        except (ValueError, OSError) as e:
                            logger.debug("%s select-window failed: %s", label, e)
                        continue
                    if text.startswith("SELECT_PANE:") and tmux_prefix and session_name:
                        try:
                            direction = text.split(":", 1)[1].strip()
                            flag_map = {"U": "-U", "D": "-D", "L": "-L", "R": "-R"}
                            flag = flag_map.get(direction)
                            if flag:
                                sp = await asyncio.create_subprocess_exec(
                                    *tmux_prefix, "select-pane", flag,
                                    "-t", session_name,
                                    stdout=asyncio.subprocess.DEVNULL,
                                    stderr=asyncio.subprocess.DEVNULL,
                                    env=_clean_env(),
                                )
                                await sp.wait()
                        except (ValueError, OSError) as e:
                            logger.debug("%s select-pane failed: %s", label, e)
                        continue
                    if text.startswith("TOGGLE_ZOOM:") and tmux_prefix and session_name:
                        try:
                            zp = await asyncio.create_subprocess_exec(
                                *tmux_prefix, "resize-pane", "-Z",
                                "-t", session_name,
                                stdout=asyncio.subprocess.DEVNULL,
                                stderr=asyncio.subprocess.DEVNULL,
                                env=_clean_env(),
                            )
                            await zp.wait()
                        except (ValueError, OSError) as e:
                            logger.debug("%s toggle-zoom failed: %s", label, e)
                        continue
                    if text.startswith("SPLIT_PANE:") and tmux_prefix and session_name:
                        try:
                            direction = text.split(":", 1)[1].strip()
                            flag = "-v" if direction == "H" else "-h"
                            sp = await asyncio.create_subprocess_exec(
                                *tmux_prefix, "split-window", flag,
                                "-t", session_name,
                                stdout=asyncio.subprocess.DEVNULL,
                                stderr=asyncio.subprocess.DEVNULL,
                                env=_clean_env(),
                            )
                            await sp.wait()
                        except (ValueError, OSError) as e:
                            logger.debug("%s split-pane failed: %s", label, e)
                        continue
                    if text.startswith("KILL_PANE:") and tmux_prefix and session_name:
                        try:
                            kp = await asyncio.create_subprocess_exec(
                                *tmux_prefix, "kill-pane",
                                "-t", session_name,
                                stdout=asyncio.subprocess.DEVNULL,
                                stderr=asyncio.subprocess.DEVNULL,
                                env=_clean_env(),
                            )
                            await kp.wait()
                        except (ValueError, OSError) as e:
                            logger.debug("%s kill-pane failed: %s", label, e)
                        continue
                    if text.startswith("SCROLL:") and tmux_prefix and session_name:
                        try:
                            parts = text.split(":")
                            direction = parts[1] if len(parts) > 1 else ""
                            count = parts[2] if len(parts) > 2 else "3"
                            scroll_type = parts[3] if len(parts) > 3 else "line"
                            alt = await _is_alternate_screen(tmux_prefix, session_name)
                            if direction == "up":
                                if alt:
                                    # Forward to the app running in alternate screen
                                    key = "PPage" if scroll_type == "page" else "Up"
                                    args = [*tmux_prefix, "send-keys", "-t", session_name]
                                    if scroll_type != "page":
                                        args += ["-N", count]
                                    args.append(key)
                                    su = await asyncio.create_subprocess_exec(
                                        *args,
                                        stdout=asyncio.subprocess.DEVNULL,
                                        stderr=asyncio.subprocess.DEVNULL,
                                    )
                                    await su.wait()
                                else:
                                    # Enter copy-mode with auto-exit (-e), then scroll up
                                    cm = await asyncio.create_subprocess_exec(
                                        *tmux_prefix, "copy-mode", "-e",
                                        "-t", session_name,
                                        stdout=asyncio.subprocess.DEVNULL,
                                        stderr=asyncio.subprocess.DEVNULL,
                                    )
                                    await cm.wait()
                                    su = await asyncio.create_subprocess_exec(
                                        *tmux_prefix, "send-keys",
                                        "-t", session_name,
                                        "-X", "-N", count, "scroll-up",
                                        stdout=asyncio.subprocess.DEVNULL,
                                        stderr=asyncio.subprocess.DEVNULL,
                                    )
                                    await su.wait()
                            elif direction == "down":
                                if alt:
                                    key = "NPage" if scroll_type == "page" else "Down"
                                    args = [*tmux_prefix, "send-keys", "-t", session_name]
                                    if scroll_type != "page":
                                        args += ["-N", count]
                                    args.append(key)
                                    sd = await asyncio.create_subprocess_exec(
                                        *args,
                                        stdout=asyncio.subprocess.DEVNULL,
                                        stderr=asyncio.subprocess.DEVNULL,
                                    )
                                    await sd.wait()
                                else:
                                    sd = await asyncio.create_subprocess_exec(
                                        *tmux_prefix, "send-keys",
                                        "-t", session_name,
                                        "-X", "-N", count, "scroll-down",
                                        stdout=asyncio.subprocess.DEVNULL,
                                        stderr=asyncio.subprocess.DEVNULL,
                                    )
                                    await sd.wait()
                            elif direction == "exit":
                                if not alt:
                                    ex = await asyncio.create_subprocess_exec(
                                        *tmux_prefix, "send-keys",
                                        "-t", session_name,
                                        "-X", "cancel",
                                        stdout=asyncio.subprocess.DEVNULL,
                                        stderr=asyncio.subprocess.DEVNULL,
                                    )
                                    await ex.wait()
                        except (ValueError, OSError) as e:
                            logger.debug("%s scroll failed: %s", label, e)
                        continue
                    if text == "SHIFT_ENTER:" and tmux_prefix and session_name:
                        try:
                            sk = await asyncio.create_subprocess_exec(
                                *tmux_prefix, "send-keys", "-l",
                                "-t", session_name, "--",
                                "\x1b[13;2u",
                                stdout=asyncio.subprocess.DEVNULL,
                                stderr=asyncio.subprocess.DEVNULL,
                            )
                            await sk.wait()
                        except (ValueError, OSError) as e:
                            logger.debug("%s shift-enter failed: %s", label, e)
                        continue
                    if text == "DISABLE_MOUSE:" and tmux_prefix:
                        try:
                            dm_proc = await asyncio.create_subprocess_exec(
                                *tmux_prefix, "set-option", "-g", "mouse", "off",
                                stdout=asyncio.subprocess.DEVNULL,
                                stderr=asyncio.subprocess.DEVNULL,
                            )
                            await asyncio.wait_for(dm_proc.wait(), timeout=5.0)
                            await websocket.send_text("MOUSE_WARNING:off")
                        except (ValueError, OSError) as e:
                            logger.debug("%s disable-mouse failed: %s", label, e)
                        continue
                    if text == "FIX_BELL:" and tmux_prefix:
                        try:
                            ba = await asyncio.create_subprocess_exec(
                                *tmux_prefix, "set-option", "-g", "bell-action", "any",
                                stdout=asyncio.subprocess.DEVNULL,
                                stderr=asyncio.subprocess.DEVNULL,
                            )
                            await ba.wait()
                            vb = await asyncio.create_subprocess_exec(
                                *tmux_prefix, "set-option", "-g", "visual-bell", "off",
                                stdout=asyncio.subprocess.DEVNULL,
                                stderr=asyncio.subprocess.DEVNULL,
                            )
                            await vb.wait()
                            await websocket.send_text("BELL_WARNING:ok")
                        except (ValueError, OSError) as e:
                            logger.debug("%s fix-bell failed: %s", label, e)
                        continue
                    if text == "CLEAR_BUFFER:" and tmux_prefix and session_name:
                        try:
                            # Reset terminal (clears visible pane)
                            sr = await asyncio.create_subprocess_exec(
                                *tmux_prefix, "send-keys", "-R",
                                "-t", session_name,
                                stdout=asyncio.subprocess.DEVNULL,
                                stderr=asyncio.subprocess.DEVNULL,
                            )
                            await sr.wait()
                            # Clear scrollback history
                            ch = await asyncio.create_subprocess_exec(
                                *tmux_prefix, "clear-history",
                                "-t", session_name,
                                stdout=asyncio.subprocess.DEVNULL,
                                stderr=asyncio.subprocess.DEVNULL,
                            )
                            await ch.wait()
                        except (ValueError, OSError) as e:
                            logger.debug("%s clear-buffer failed: %s", label, e)
                        continue
                    if text.startswith("LIST_PANES:") and tmux_prefix and session_name and container_id:
                        try:
                            win_idx = int(text.split(":", 1)[1])
                            tm = TmuxManager.get()
                            panes = await tm.list_panes(container_id, session_name, win_idx)
                            await websocket.send_text(f"PANE_LIST:{json.dumps(panes)}")
                        except (ValueError, OSError) as e:
                            logger.debug("%s list-panes failed: %s", label, e)
                        continue
                    if text.startswith("ZOOM_PANE:") and tmux_prefix and session_name:
                        try:
                            parts = text.split(":", 1)[1].split(".")
                            win_idx = int(parts[0])
                            pane_idx = int(parts[1])
                            target = f"{session_name}:{win_idx}.{pane_idx}"
                            sp = await asyncio.create_subprocess_exec(
                                *tmux_prefix, "select-pane", "-t", target,
                                stdout=asyncio.subprocess.DEVNULL,
                                stderr=asyncio.subprocess.DEVNULL,
                                env=_clean_env(),
                            )
                            await sp.wait()
                            zp = await asyncio.create_subprocess_exec(
                                *tmux_prefix, "resize-pane", "-Z", "-t", target,
                                stdout=asyncio.subprocess.DEVNULL,
                                stderr=asyncio.subprocess.DEVNULL,
                                env=_clean_env(),
                            )
                            await zp.wait()
                        except (ValueError, OSError) as e:
                            logger.debug("%s zoom-pane failed: %s", label, e)
                        continue
                    if text.startswith("UNZOOM_PANE:") and tmux_prefix and session_name:
                        try:
                            chk = await asyncio.create_subprocess_exec(
                                *tmux_prefix, "display-message", "-p", "-t", session_name,
                                "#{window_zoomed_flag}",
                                stdout=asyncio.subprocess.PIPE,
                                stderr=asyncio.subprocess.DEVNULL,
                                env=_clean_env(),
                            )
                            stdout, _ = await chk.communicate()
                            if stdout.decode().strip() == "1":
                                uz = await asyncio.create_subprocess_exec(
                                    *tmux_prefix, "resize-pane", "-Z", "-t", session_name,
                                    stdout=asyncio.subprocess.DEVNULL,
                                    stderr=asyncio.subprocess.DEVNULL,
                                    env=_clean_env(),
                                )
                                await uz.wait()
                        except (ValueError, OSError) as e:
                            logger.debug("%s unzoom-pane failed: %s", label, e)
                        continue
                    if text.startswith("CAPTURE_PANE:") and tmux_prefix and session_name and container_id:
                        try:
                            parts = text.split(":", 1)[1].split(".")
                            win_idx = int(parts[0])
                            pane_idx = int(parts[1])
                            tm = TmuxManager.get()
                            content = await tm.capture_pane_content(container_id, session_name, win_idx, pane_idx)
                            await websocket.send_text(f"PANE_CONTENT:{win_idx}.{pane_idx}:{content}")
                        except (ValueError, OSError) as e:
                            logger.debug("%s capture-pane failed: %s", label, e)
                        continue
                    if text.startswith("HISTORY_REQUEST:") and tmux_prefix and session_name and container_id:
                        try:
                            tm = TmuxManager.get()
                            content = await tm.capture_active_pane_history(
                                container_id, session_name,
                            )
                            # Send as binary with a text prefix so the client
                            # can feed raw ANSI bytes into the terminal buffer.
                            header = b"HISTORY_DATA:"
                            await websocket.send_bytes(header + content.encode("utf-8"))
                        except (ValueError, OSError) as e:
                            logger.debug("%s history-request failed: %s", label, e)
                        continue
                    await loop.run_in_executor(
                        None, os.write, master_fd, text.encode("utf-8")
                    )
                elif "bytes" in msg:
                    await loop.run_in_executor(None, os.write, master_fd, msg["bytes"])

        except (OSError, WebSocketDisconnect):
            pass

    async def _resolve_client_session() -> tuple[str, str]:
        """Detect which session the tmux client is currently on.

        Returns (resolved_session_name, query_session) where
        resolved_session_name is the real (non-view) session name for
        the frontend, and query_session is the tmux session to query
        for list_windows/list_panes.
        """
        _fallback = (original_session or session_name, session_name)
        _CMD_TIMEOUT = 5.0
        try:
            client_pid = str(proc.pid)
            lc = await asyncio.create_subprocess_exec(
                *tmux_prefix, "list-clients",
                "-F", "#{client_pid}|#{client_session}",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                env=_clean_env(),
            )
            try:
                stdout, _ = await asyncio.wait_for(lc.communicate(), timeout=_CMD_TIMEOUT)
            except asyncio.TimeoutError:
                lc.kill()
                logger.warning("tmux list-clients timed out after %ss", _CMD_TIMEOUT)
                return _fallback
            client_session: str | None = None
            for line in stdout.decode().strip().splitlines():
                parts = line.split("|", 1)
                if len(parts) == 2 and parts[0] == client_pid:
                    client_session = parts[1]
                    break
            if not client_session:
                # Client not found — fall back to view session
                return _fallback
            # If client is on a view session, resolve to the real session
            # via session_group
            if client_session.startswith(VIEW_SESSION_PREFIX):
                dm = await asyncio.create_subprocess_exec(
                    *tmux_prefix, "display-message", "-p",
                    "-t", client_session, "#{session_group}",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL,
                    env=_clean_env(),
                )
                try:
                    sg_out, _ = await asyncio.wait_for(dm.communicate(), timeout=_CMD_TIMEOUT)
                except asyncio.TimeoutError:
                    dm.kill()
                    logger.warning("tmux display-message timed out after %ss", _CMD_TIMEOUT)
                    return _fallback
                group = sg_out.decode().strip()
                return (group or client_session, client_session)
            return (client_session, client_session)
        except OSError as e:
            logger.warning("_resolve_client_session failed: %s", e)
            return _fallback

    async def poll_window_state() -> None:
        """Periodically check tmux window state and notify the frontend."""
        if not tmux_prefix or not session_name or not container_id:
            logger.debug("%s poll_window_state: skipped (missing params)", label)
            return
        logger.debug("%s poll_window_state: started for %s/%s", label, container_id, session_name)
        tm = TmuxManager.get()
        last_active: int | None = None
        last_windows: list[dict] | None = None
        last_resolved: str | None = None
        try:
            while True:
                await asyncio.sleep(3 + random.uniform(0, 1))
                try:
                    # Detect which session the tmux client is actually on
                    resolved_session, query_session = await _resolve_client_session()

                    windows = await tm.list_windows(container_id, query_session)
                    active = next(
                        (w["index"] for w in windows if w.get("active")), None,
                    )
                    # Serialize to comparable form (ignore pane_status fluctuations)
                    win_summary = [
                        (w["index"], w["name"], w.get("bell"), w.get("activity"), w.get("path"))
                        for w in windows
                    ]
                    last_summary = (
                        [
                            (w["index"], w["name"], w.get("bell"), w.get("activity"), w.get("path"))
                            for w in last_windows
                        ]
                        if last_windows
                        else None
                    )

                    if active != last_active or win_summary != last_summary or resolved_session != last_resolved:
                        last_active = active
                        last_windows = windows
                        last_resolved = resolved_session
                        # Include panes of the active window
                        panes = []
                        if active is not None:
                            try:
                                panes = await tm.list_panes(container_id, query_session, active)
                            except Exception:
                                pass
                        payload = json.dumps(
                            {"active": active, "windows": windows, "panes": panes,
                             "session": resolved_session}
                        )
                        logger.debug("%s poll: sending WINDOW_STATE (session=%s, active=%s, %d windows)",
                                    label, resolved_session, active, len(windows))
                        await websocket.send_text(f"WINDOW_STATE:{payload}")
                except (OSError, asyncio.CancelledError):
                    raise
                except Exception as e:
                    logger.warning("%s window poll failed: %s", label, e, exc_info=True)
        except (asyncio.CancelledError, WebSocketDisconnect):
            logger.debug("%s poll_window_state: stopped", label)
            pass

    try:
        done, pending = await asyncio.wait(
            [
                asyncio.create_task(pty_to_ws()),
                asyncio.create_task(ws_to_pty()),
                asyncio.create_task(poll_window_state()),
            ],
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
        # Fast-exit heuristic: if the PTY closed almost immediately with no
        # data sent, the session likely vanished between has-session and attach.
        elapsed = time.monotonic() - start_time
        if elapsed < 2.0 and not sent_data:
            with contextlib.suppress(Exception):
                await websocket.send_text("SESSION_GONE:")
                await websocket.close(code=4404, reason="Session no longer exists")
    finally:
        # Kill the tmux process FIRST so it releases the PTY slave
        with contextlib.suppress(ProcessLookupError):
            proc.terminate()
        try:
            await asyncio.wait_for(proc.wait(), timeout=3.0)
        except (asyncio.TimeoutError, ProcessLookupError):
            with contextlib.suppress(Exception):
                proc.kill()
        # Close the PTY master fd in a thread — on macOS, os.close() on a
        # PTY master can block for 30-60s if a process still holds the slave.
        try:
            await asyncio.wait_for(
                loop.run_in_executor(None, os.close, master_fd),
                timeout=5.0,
            )
        except (OSError, asyncio.TimeoutError):
            pass


async def _bridge_terminal(
    websocket: WebSocket,
    container_id: str,
    session_name: str,
    window_index: int,
) -> None:
    """Handle a terminal session proxied through a bridge agent."""
    bm = BridgeManager.get()
    bid = bridge_id_from_container(container_id)
    conn = bm.get_bridge(bid)
    if not conn:
        await websocket.close(code=4004, reason="Bridge not connected")
        return

    channel_id = conn.allocate_channel()
    source = bridge_source_from_container(container_id)
    view_name: str | None = None

    try:
        # Set tmux options on the remote server before attaching
        for tmux_option_cmd in [
            ["tmux", "set-option", "-s", "extended-keys", "always"],
            ["tmux", "set-option", "-g", "allow-passthrough", "on"],
            ["tmux", "set-option", "-g", "monitor-activity", "on"],
            ["tmux", "set-option", "-g", "activity-action", "none"],
        ]:
            try:
                await conn.request({
                    "type": "tmux_cmd",
                    "cmd": tmux_option_cmd,
                    "source": source,
                }, timeout=5)
            except (asyncio.TimeoutError, Exception):
                pass  # Best-effort, don't block attach on config failure

        # Auto-rename windows with configurable format
        from .. import store as _store
        from ..services.tmux_manager import DEFAULT_AUTO_RENAME_FORMAT
        _auto_fmt = _store.get_settings().get("tmuxAutoRenameFormat", "")
        _auto_fmt = _auto_fmt if _auto_fmt else DEFAULT_AUTO_RENAME_FORMAT
        for auto_cmd in [
            ["tmux", "set-option", "-gw", "automatic-rename", "on"],
            ["tmux", "set-option", "-gw", "automatic-rename-format", _auto_fmt],
        ]:
            try:
                await conn.request({
                    "type": "tmux_cmd",
                    "cmd": auto_cmd,
                    "source": source,
                }, timeout=5)
            except (asyncio.TimeoutError, Exception):
                pass

        # Wait for initial RESIZE from frontend so bridge PTY starts
        # at the correct dimensions.
        cols, rows = 80, 24
        try:
            msg = await asyncio.wait_for(websocket.receive(), timeout=3.0)
            if msg.get("type") == "websocket.disconnect":
                return
            if "text" in msg:
                text = msg["text"]
                if text.startswith("RESIZE:"):
                    parts = text.split(":")
                    if len(parts) == 3:
                        try:
                            cols = int(parts[1])
                            rows = int(parts[2])
                        except ValueError:
                            pass
        except asyncio.TimeoutError:
            logger.debug("Bridge RESIZE wait timed out, using defaults 80x24")

        # Create grouped session for independent window navigation
        view_name = f"{VIEW_SESSION_PREFIX}{uuid.uuid4().hex[:8]}"
        try:
            await conn.request({
                "type": "tmux_cmd",
                "cmd": ["tmux", "new-session", "-d", "-t", session_name, "-s", view_name],
                "source": source,
            }, timeout=5)
        except (asyncio.TimeoutError, Exception) as e:
            logger.error("Bridge create view session failed: %s", e)
            await websocket.send_text("SESSION_GONE:")
            await websocket.close(code=4404, reason="Failed to create view session")
            return
        # Use view session name for all subsequent operations
        session_name = view_name

        # Request the bridge to attach to the tmux session
        result = await conn.request({
            "type": "attach",
            "session_name": view_name,
            "window_index": window_index,
            "channel_id": channel_id,
            "cols": cols,
            "rows": rows,
            "source": source,
        })

        if result.get("type") == "attach_error":
            error = result.get("reason", "Unknown error")
            logger.error("Bridge attach failed: %s", error)
            await websocket.send_text("SESSION_GONE:")
            await websocket.close(code=4404, reason=error)
            return

        # Register this user WS so bridge binary frames get routed here
        conn.register_terminal(channel_id, TerminalInfo(
            channel_id=channel_id,
            user_ws=websocket,
            session_name=session_name,
            window_index=window_index,
            source=source,
            cols=cols,
            rows=rows,
        ))

        # Forward user input to bridge
        try:
            while True:
                msg = await websocket.receive()

                if msg.get("type") == "websocket.disconnect":
                    break

                if "text" in msg:
                    text = msg["text"]
                    if text.startswith("RESIZE:"):
                        parts = text.split(":")
                        if len(parts) == 3:
                            try:
                                cols = int(parts[1])
                                rows = int(parts[2])
                                # Update stored dimensions for reattach
                                info = conn.get_terminal_info(channel_id)
                                if info:
                                    info.cols = cols
                                    info.rows = rows
                                await conn.send_json({
                                    "type": "resize",
                                    "channel_id": channel_id,
                                    "cols": cols,
                                    "rows": rows,
                                })
                            except (ValueError, Exception) as e:
                                logger.debug("Bridge resize failed: %s", e)
                        continue
                    if text.startswith("SELECT_WINDOW:"):
                        try:
                            win_idx = int(text.split(":", 1)[1])
                            # Fire-and-forget: no need to wait for response,
                            # the PTY output will show the window change
                            await conn.send_json({
                                "type": "tmux_cmd",
                                "cmd": ["tmux", "select-window", "-t",
                                         f"{session_name}:{win_idx}"],
                                "source": source,
                            })
                        except (ValueError, Exception) as e:
                            logger.debug("Bridge select-window failed: %s", e)
                        continue
                    if text.startswith("SCROLL:"):
                        try:
                            parts = text.split(":")
                            direction = parts[1] if len(parts) > 1 else ""
                            count = parts[2] if len(parts) > 2 else "3"
                            scroll_type = parts[3] if len(parts) > 3 else "line"
                            # Fire-and-forget scroll commands to avoid
                            # round-trip latency.  The bridge handles alt-screen
                            # detection and sends the right tmux command.
                            await conn.send_json({
                                "type": "scroll",
                                "session_name": session_name,
                                "direction": direction,
                                "count": count,
                                "scroll_type": scroll_type,
                                "source": source,
                            })
                        except (ValueError, Exception) as e:
                            logger.debug("Bridge scroll failed: %s", e)
                        continue
                    if text == "SHIFT_ENTER:":
                        try:
                            await conn.send_json({
                                "type": "tmux_cmd",
                                "cmd": ["tmux", "send-keys", "-l",
                                         "-t", session_name, "--",
                                         "\x1b[13;2u"],
                                "source": source,
                            })
                        except Exception as e:
                            logger.debug("Bridge shift-enter failed: %s", e)
                        continue
                    if text == "DISABLE_MOUSE:":
                        try:
                            await conn.request({
                                "type": "tmux_cmd",
                                "cmd": ["tmux", "set-option", "-g", "mouse", "off"],
                                "source": source,
                            })
                            await websocket.send_text("MOUSE_WARNING:off")
                        except (ValueError, asyncio.TimeoutError, Exception) as e:
                            logger.debug("Bridge disable-mouse failed: %s", e)
                        continue
                    if text == "FIX_BELL:":
                        try:
                            await conn.request({
                                "type": "tmux_cmd",
                                "cmd": ["tmux", "set-option", "-g",
                                         "bell-action", "any"],
                                "source": source,
                            })
                            await conn.request({
                                "type": "tmux_cmd",
                                "cmd": ["tmux", "set-option", "-g",
                                         "visual-bell", "off"],
                                "source": source,
                            })
                            await websocket.send_text("BELL_WARNING:ok")
                        except (ValueError, asyncio.TimeoutError, Exception) as e:
                            logger.debug("Bridge fix-bell failed: %s", e)
                        continue
                    if text == "CLEAR_BUFFER:":
                        try:
                            await conn.request({
                                "type": "tmux_cmd",
                                "cmd": ["tmux", "send-keys", "-R",
                                         "-t", session_name],
                                "source": source,
                            })
                            await conn.request({
                                "type": "tmux_cmd",
                                "cmd": ["tmux", "clear-history",
                                         "-t", session_name],
                                "source": source,
                            })
                        except (ValueError, asyncio.TimeoutError, Exception) as e:
                            logger.debug("Bridge clear-buffer failed: %s", e)
                        continue
                    # Regular text input → send as binary to bridge
                    await conn.send_binary(channel_id, text.encode("utf-8"))
                elif "bytes" in msg:
                    await conn.send_binary(channel_id, msg["bytes"])

        except (OSError, WebSocketDisconnect):
            pass

    except asyncio.TimeoutError:
        logger.error("Bridge attach timed out for %s", container_id)
        await websocket.send_text("Bridge attach timed out\r\n")
    except Exception as e:
        logger.error("Bridge terminal error: %s", e)
    finally:
        # Tell bridge to detach this channel
        try:
            await conn.send_json({
                "type": "detach",
                "channel_id": channel_id,
            })
        except Exception:
            pass
        # Clean up grouped view session
        if view_name:
            try:
                await conn.send_json({
                    "type": "tmux_cmd",
                    "cmd": ["tmux", "kill-session", "-t", view_name],
                    "source": source,
                })
            except Exception:
                pass
        conn.unregister_terminal(channel_id)


@router.websocket("/ws/terminal/{container_id}/{session_name}/{window_index}")
async def terminal_ws(
    websocket: WebSocket, container_id: str, session_name: str, window_index: int
):
    # Auth check before accepting the WebSocket
    if auth.is_pin_set():
        token = websocket.cookies.get("session")
        if not token or not auth.validate_session(token):
            await websocket.close(code=4001)
            return

    await websocket.accept()

    # Disable Nagle's algorithm for lower latency
    transport = websocket.scope.get("transport")
    if transport:
        sock_obj = transport.get_extra_info("socket")
        if sock_obj:
            sock_obj.setsockopt(_socket.IPPROTO_TCP, _socket.TCP_NODELAY, 1)

    target = f"{session_name}:{window_index}"

    # Bridge terminals
    if is_bridge(container_id):
        try:
            await _bridge_terminal(websocket, container_id, session_name, window_index)
        except WebSocketDisconnect:
            pass
        except Exception as e:
            logger.error("Bridge terminal WebSocket error: %s", e)
        finally:
            with contextlib.suppress(Exception):
                await websocket.close()
        return

    if _is_local(container_id):
        view_name: str | None = None
        try:
            tmux_prefix = ["tmux"]
            if not await _tmux_session_exists(tmux_prefix, target):
                await websocket.send_text("SESSION_GONE:")
                await websocket.close(code=4404, reason="Session no longer exists")
                return
            # Enable CSI u extended keys (e.g. Shift+Enter) before attaching
            await _set_tmux_extended_keys(tmux_prefix)
            # Enable DCS passthrough for tmuxdeck-open
            await _set_tmux_passthrough(tmux_prefix)
            # Enable activity monitoring for sidebar indicators
            await _set_tmux_monitor_activity(tmux_prefix)
            # Auto-rename windows with configurable format
            await _set_tmux_auto_rename(tmux_prefix)
            # Create grouped session for independent window navigation
            view_name = await _create_view_session(tmux_prefix, session_name, window_index)
            cmd = [*tmux_prefix, "attach-session", "-t", f"{view_name}:{window_index}"]
            await _pty_terminal(websocket, cmd, label="Local",
                                tmux_prefix=tmux_prefix, session_name=view_name,
                                container_id=container_id,
                                original_session=session_name)
        except WebSocketDisconnect:
            pass
        except Exception as e:
            logger.error("Local terminal WebSocket error: %s", e)
        finally:
            if view_name:
                await _kill_view_session(tmux_prefix, view_name)
            with contextlib.suppress(Exception):
                await websocket.close()
        return

    if _is_host(container_id):
        view_name: str | None = None
        try:
            socket = config.host_tmux_socket
            tmux_prefix = ["tmux", "-S", socket]
            if not await _tmux_session_exists(tmux_prefix, target):
                await websocket.send_text("SESSION_GONE:")
                await websocket.close(code=4404, reason="Session no longer exists")
                return
            # Enable CSI u extended keys (e.g. Shift+Enter) before attaching
            await _set_tmux_extended_keys(tmux_prefix)
            # Enable DCS passthrough for tmuxdeck-open
            await _set_tmux_passthrough(tmux_prefix)
            # Enable activity monitoring for sidebar indicators
            await _set_tmux_monitor_activity(tmux_prefix)
            # Auto-rename windows with configurable format
            await _set_tmux_auto_rename(tmux_prefix)
            # Create grouped session for independent window navigation
            view_name = await _create_view_session(tmux_prefix, session_name, window_index)
            cmd = [*tmux_prefix, "attach-session", "-t", f"{view_name}:{window_index}"]
            await _pty_terminal(websocket, cmd, label="Host",
                                tmux_prefix=tmux_prefix, session_name=view_name,
                                container_id=container_id,
                                original_session=session_name)
        except WebSocketDisconnect:
            pass
        except Exception as e:
            logger.error("Host terminal WebSocket error: %s", e)
        finally:
            if view_name:
                await _kill_view_session(tmux_prefix, view_name)
            with contextlib.suppress(Exception):
                await websocket.close()
        return

    dm = DockerManager.get()
    exec_id = None
    sock = None
    view_name: str | None = None

    try:
        # Check if the tmux session exists before attaching
        try:
            sessions_out = await dm.exec_command(container_id, ["tmux", "list-sessions", "-F", "#{session_name}"])
            session_target = target.split(":")[0]
            if session_target not in sessions_out.strip().splitlines():
                await websocket.send_text("SESSION_GONE:")
                await websocket.close(code=4404, reason="Session no longer exists")
                return
        except Exception:
            await websocket.send_text("SESSION_GONE:")
            await websocket.close(code=4404, reason="Container or session unavailable")
            return

        # Enable CSI u extended keys (e.g. Shift+Enter) before attaching
        await dm.exec_command(container_id, ["tmux", "set-option", "-s", "extended-keys", "always"])

        # Enable DCS passthrough for tmuxdeck-open OSC sequences
        await dm.exec_command(container_id, ["tmux", "set-option", "-g", "allow-passthrough", "on"])

        # Enable activity monitoring for sidebar indicators
        await dm.exec_command(container_id, ["tmux", "set-option", "-g", "monitor-activity", "on"])
        # No alert (no bell, no status message) — just set the window flag.
        await dm.exec_command(container_id, ["tmux", "set-option", "-g", "activity-action", "none"])

        # Auto-rename windows with configurable format
        from .. import store as _store
        from ..services.tmux_manager import DEFAULT_AUTO_RENAME_FORMAT
        _fmt = _store.get_settings().get("tmuxAutoRenameFormat", "")
        _fmt = _fmt if _fmt else DEFAULT_AUTO_RENAME_FORMAT
        await dm.exec_command(container_id, ["tmux", "set-option", "-gw", "automatic-rename", "on"])
        await dm.exec_command(container_id, ["tmux", "set-option", "-gw", "automatic-rename-format", _fmt])

        # Create grouped session for independent window navigation
        view_name = f"{VIEW_SESSION_PREFIX}{uuid.uuid4().hex[:8]}"
        await dm.exec_command(
            container_id,
            ["tmux", "new-session", "-d", "-t", session_name, "-s", view_name],
        )
        # Use view session name for all control messages
        session_name = view_name

        # Start interactive docker exec: tmux attach
        cmd = ["tmux", "attach-session", "-t", f"{view_name}:{window_index}"]
        exec_id, sock = await dm.exec_interactive(container_id, cmd)

        # Warn frontend if tmux mouse mode is on (breaks text selection)
        try:
            mouse_out = await dm.exec_command(
                container_id, ["tmux", "show-options", "-gv", "mouse"],
            )
            if mouse_out.strip() == "on":
                await websocket.send_text("MOUSE_WARNING:on")
        except Exception:
            pass

        # Warn frontend if tmux bell settings prevent bell propagation
        try:
            bell_problems: dict[str, str] = {}
            bell_action_out = await dm.exec_command(
                container_id, ["tmux", "show-options", "-gv", "bell-action"],
            )
            if bell_action_out.strip() == "none":
                bell_problems["bellAction"] = bell_action_out.strip()
            visual_bell_out = await dm.exec_command(
                container_id, ["tmux", "show-options", "-gv", "visual-bell"],
            )
            if visual_bell_out.strip() == "on":
                bell_problems["visualBell"] = visual_bell_out.strip()
            if bell_problems:
                await websocket.send_text(f"BELL_WARNING:{json.dumps(bell_problems)}")
        except Exception:
            pass

        # Get the underlying socket for reading
        raw_sock = sock._sock if hasattr(sock, "_sock") else sock

        async def docker_to_ws():
            """Read from docker exec socket, send to WebSocket as binary."""
            loop = asyncio.get_event_loop()
            pending_sends = 0
            max_pending = 32
            try:
                while True:
                    # Backpressure: if client is slow, pause reading
                    while pending_sends >= max_pending:
                        await asyncio.sleep(0.05)
                    data = await loop.run_in_executor(None, raw_sock.recv, 16384)
                    if not data:
                        break
                    pending_sends += 1
                    try:
                        await websocket.send_bytes(data)
                    finally:
                        pending_sends -= 1
            except (OSError, WebSocketDisconnect):
                pass

        async def ws_to_docker():
            """Read from WebSocket, send to docker exec socket."""
            loop = asyncio.get_event_loop()
            try:
                while True:
                    msg = await websocket.receive()

                    if msg.get("type") == "websocket.disconnect":
                        break

                    if "text" in msg:
                        text = msg["text"]
                        # Handle resize control message
                        if text.startswith("RESIZE:"):
                            parts = text.split(":")
                            if len(parts) == 3 and exec_id:
                                try:
                                    cols = int(parts[1])
                                    rows = int(parts[2])
                                    await dm.exec_resize(exec_id, rows, cols)
                                except (ValueError, Exception) as e:
                                    logger.debug("Resize failed: %s", e)
                            continue
                        # Handle window switch without reconnecting
                        if text.startswith("SELECT_WINDOW:"):
                            try:
                                win_idx = int(text.split(":", 1)[1])
                                sw_target = f"{session_name}:{win_idx}"
                                await dm.exec_command(
                                    container_id,
                                    ["tmux", "select-window", "-t", sw_target],
                                )
                            except (ValueError, Exception) as e:
                                logger.debug("select-window failed: %s", e)
                            continue
                        if text.startswith("SELECT_PANE:"):
                            try:
                                direction = text.split(":", 1)[1].strip()
                                flag_map = {"U": "-U", "D": "-D", "L": "-L", "R": "-R"}
                                flag = flag_map.get(direction)
                                if flag:
                                    await dm.exec_command(
                                        container_id,
                                        ["tmux", "select-pane", flag,
                                         "-t", session_name],
                                    )
                            except (ValueError, Exception) as e:
                                logger.debug("select-pane failed: %s", e)
                            continue
                        if text.startswith("TOGGLE_ZOOM:"):
                            try:
                                await dm.exec_command(
                                    container_id,
                                    ["tmux", "resize-pane", "-Z",
                                     "-t", session_name],
                                )
                            except (ValueError, Exception) as e:
                                logger.debug("toggle-zoom failed: %s", e)
                            continue
                        if text.startswith("SPLIT_PANE:"):
                            try:
                                direction = text.split(":", 1)[1].strip()
                                flag = "-v" if direction == "H" else "-h"
                                await dm.exec_command(
                                    container_id,
                                    ["tmux", "split-window", flag,
                                     "-t", session_name],
                                )
                            except (ValueError, Exception) as e:
                                logger.debug("split-pane failed: %s", e)
                            continue
                        if text.startswith("KILL_PANE:"):
                            try:
                                await dm.exec_command(
                                    container_id,
                                    ["tmux", "kill-pane",
                                     "-t", session_name],
                                )
                            except (ValueError, Exception) as e:
                                logger.debug("kill-pane failed: %s", e)
                            continue
                        # Handle scroll control messages
                        if text.startswith("SCROLL:"):
                            try:
                                parts = text.split(":")
                                direction = parts[1] if len(parts) > 1 else ""
                                if direction == "up":
                                    count = parts[2] if len(parts) > 2 else "3"
                                    await dm.exec_command(
                                        container_id,
                                        ["tmux", "copy-mode", "-e",
                                         "-t", session_name],
                                    )
                                    await dm.exec_command(
                                        container_id,
                                        ["tmux", "send-keys",
                                         "-t", session_name,
                                         "-X", "-N", count, "scroll-up"],
                                    )
                                elif direction == "down":
                                    count = parts[2] if len(parts) > 2 else "3"
                                    await dm.exec_command(
                                        container_id,
                                        ["tmux", "send-keys",
                                         "-t", session_name,
                                         "-X", "-N", count, "scroll-down"],
                                    )
                                elif direction == "exit":
                                    await dm.exec_command(
                                        container_id,
                                        ["tmux", "send-keys",
                                         "-t", session_name,
                                         "-X", "cancel"],
                                    )
                            except (ValueError, Exception) as e:
                                logger.debug("scroll failed: %s", e)
                            continue
                        # Handle Shift+Enter: inject CSI u directly into pane
                        if text == "SHIFT_ENTER:":
                            try:
                                await dm.exec_command(
                                    container_id,
                                    ["tmux", "send-keys", "-l",
                                     "-t", session_name, "--",
                                     "\x1b[13;2u"],
                                )
                            except (ValueError, Exception) as e:
                                logger.debug("shift-enter failed: %s", e)
                            continue
                        # Handle disable-mouse control message
                        if text == "DISABLE_MOUSE:":
                            try:
                                await dm.exec_command(
                                    container_id,
                                    ["tmux", "set-option", "-g", "mouse", "off"],
                                )
                                await websocket.send_text("MOUSE_WARNING:off")
                            except (ValueError, Exception) as e:
                                logger.debug("disable-mouse failed: %s", e)
                            continue
                        # Handle fix-bell control message
                        if text == "FIX_BELL:":
                            try:
                                await dm.exec_command(
                                    container_id,
                                    ["tmux", "set-option", "-g", "bell-action", "any"],
                                )
                                await dm.exec_command(
                                    container_id,
                                    ["tmux", "set-option", "-g", "visual-bell", "off"],
                                )
                                await websocket.send_text("BELL_WARNING:ok")
                            except (ValueError, Exception) as e:
                                logger.debug("fix-bell failed: %s", e)
                            continue
                        # Handle clear-buffer control message
                        if text == "CLEAR_BUFFER:":
                            try:
                                await dm.exec_command(
                                    container_id,
                                    ["tmux", "send-keys", "-R",
                                     "-t", session_name],
                                )
                                await dm.exec_command(
                                    container_id,
                                    ["tmux", "clear-history",
                                     "-t", session_name],
                                )
                            except (ValueError, Exception) as e:
                                logger.debug("clear-buffer failed: %s", e)
                            continue
                        if text.startswith("LIST_PANES:"):
                            try:
                                win_idx = int(text.split(":", 1)[1])
                                tm = TmuxManager.get()
                                panes = await tm.list_panes(container_id, session_name, win_idx)
                                await websocket.send_text(f"PANE_LIST:{json.dumps(panes)}")
                            except (ValueError, Exception) as e:
                                logger.debug("list-panes failed: %s", e)
                            continue
                        if text.startswith("ZOOM_PANE:"):
                            try:
                                parts = text.split(":", 1)[1].split(".")
                                win_idx = int(parts[0])
                                pane_idx = int(parts[1])
                                target = f"{session_name}:{win_idx}.{pane_idx}"
                                await dm.exec_command(
                                    container_id,
                                    ["tmux", "select-pane", "-t", target],
                                )
                                await dm.exec_command(
                                    container_id,
                                    ["tmux", "resize-pane", "-Z", "-t", target],
                                )
                            except (ValueError, Exception) as e:
                                logger.debug("zoom-pane failed: %s", e)
                            continue
                        if text.startswith("UNZOOM_PANE:"):
                            try:
                                zoomed = await dm.exec_command(
                                    container_id,
                                    ["tmux", "display-message", "-p", "-t", session_name,
                                     "#{window_zoomed_flag}"],
                                )
                                if zoomed.strip() == "1":
                                    await dm.exec_command(
                                        container_id,
                                        ["tmux", "resize-pane", "-Z", "-t", session_name],
                                    )
                            except (ValueError, Exception) as e:
                                logger.debug("unzoom-pane failed: %s", e)
                            continue
                        if text.startswith("CAPTURE_PANE:"):
                            try:
                                parts = text.split(":", 1)[1].split(".")
                                win_idx = int(parts[0])
                                pane_idx = int(parts[1])
                                tm = TmuxManager.get()
                                content = await tm.capture_pane_content(container_id, session_name, win_idx, pane_idx)
                                await websocket.send_text(f"PANE_CONTENT:{win_idx}.{pane_idx}:{content}")
                            except (ValueError, Exception) as e:
                                logger.debug("capture-pane failed: %s", e)
                            continue
                        if text.startswith("HISTORY_REQUEST:"):
                            try:
                                tm = TmuxManager.get()
                                content = await tm.capture_active_pane_history(
                                    container_id, session_name,
                                )
                                header = b"HISTORY_DATA:"
                                await websocket.send_bytes(header + content.encode("utf-8"))
                            except (ValueError, Exception) as e:
                                logger.debug("history-request failed: %s", e)
                            continue
                        # Regular text input
                        await loop.run_in_executor(None, raw_sock.sendall, text.encode("utf-8"))

                    elif "bytes" in msg:
                        await loop.run_in_executor(None, raw_sock.sendall, msg["bytes"])

            except (OSError, WebSocketDisconnect):
                pass

        async def poll_docker_window_state() -> None:
            """Periodically check tmux window state in docker container."""
            tm = TmuxManager.get()
            last_active: int | None = None
            last_windows: list[dict] | None = None
            try:
                while True:
                    await asyncio.sleep(3 + random.uniform(0, 1))
                    try:
                        windows = await tm.list_windows(container_id, session_name)
                        active = next(
                            (w["index"] for w in windows if w.get("active")), None,
                        )
                        win_summary = [
                            (w["index"], w["name"], w.get("bell"), w.get("activity"))
                            for w in windows
                        ]
                        last_summary = (
                            [
                                (w["index"], w["name"], w.get("bell"), w.get("activity"))
                                for w in last_windows
                            ]
                            if last_windows
                            else None
                        )
                        if active != last_active or win_summary != last_summary:
                            last_active = active
                            last_windows = windows
                            panes = []
                            if active is not None:
                                try:
                                    panes = await tm.list_panes(container_id, session_name, active)
                                except Exception:
                                    pass
                            payload = json.dumps(
                                {"active": active, "windows": windows, "panes": panes}
                            )
                            await websocket.send_text(f"WINDOW_STATE:{payload}")
                    except (OSError, asyncio.CancelledError):
                        raise
                    except Exception as e:
                        logger.debug("Docker window poll failed: %s", e)
            except (asyncio.CancelledError, WebSocketDisconnect):
                pass

        # Run all directions concurrently
        done, pending = await asyncio.wait(
            [
                asyncio.create_task(docker_to_ws()),
                asyncio.create_task(ws_to_docker()),
                asyncio.create_task(poll_docker_window_state()),
            ],
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.error("Terminal WebSocket error: %s", e)
    finally:
        if view_name:
            with contextlib.suppress(Exception):
                await dm.exec_command(container_id, ["tmux", "kill-session", "-t", view_name])
        if sock:
            try:
                raw_sock = sock._sock if hasattr(sock, "_sock") else sock
                raw_sock.close()
            except Exception:
                pass
        with contextlib.suppress(Exception):
            await websocket.close()
