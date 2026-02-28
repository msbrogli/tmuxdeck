from __future__ import annotations

import asyncio
import contextlib
import fcntl
import json
import logging
import os
import pty
import signal
import struct
import termios

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .. import auth
from ..config import config
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
        await proc.wait()
    except OSError:
        pass  # tmux may not support extended-keys on older versions


async def _set_tmux_passthrough(tmux_prefix: list[str]) -> None:
    """Enable DCS passthrough so tmuxdeck-open can send OSC sequences
    through tmux to xterm.js in the browser (requires tmux >= 3.3a)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *tmux_prefix, "set-option", "-g", "allow-passthrough", "on",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await proc.wait()
    except OSError:
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

    async def pty_to_ws() -> None:
        try:
            while True:
                data = await loop.run_in_executor(None, os.read, master_fd, 4096)
                if not data:
                    break
                await websocket.send_bytes(data)
        except (OSError, WebSocketDisconnect):
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
                    if text.startswith("SCROLL:") and tmux_prefix and session_name:
                        try:
                            parts = text.split(":")
                            direction = parts[1] if len(parts) > 1 else ""
                            if direction == "up":
                                count = parts[2] if len(parts) > 2 else "3"
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
                                count = parts[2] if len(parts) > 2 else "3"
                                sd = await asyncio.create_subprocess_exec(
                                    *tmux_prefix, "send-keys",
                                    "-t", session_name,
                                    "-X", "-N", count, "scroll-down",
                                    stdout=asyncio.subprocess.DEVNULL,
                                    stderr=asyncio.subprocess.DEVNULL,
                                )
                                await sd.wait()
                            elif direction == "exit":
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
                            await dm_proc.wait()
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
                            content = await tm.capture_pane(container_id, session_name, win_idx, pane_idx)
                            await websocket.send_text(f"PANE_CONTENT:{win_idx}.{pane_idx}:{content}")
                        except (ValueError, OSError) as e:
                            logger.debug("%s capture-pane failed: %s", label, e)
                        continue
                    await loop.run_in_executor(
                        None, os.write, master_fd, text.encode("utf-8")
                    )
                elif "bytes" in msg:
                    await loop.run_in_executor(None, os.write, master_fd, msg["bytes"])

        except (OSError, WebSocketDisconnect):
            pass

    async def poll_window_state() -> None:
        """Periodically check tmux window state and notify the frontend."""
        if not tmux_prefix or not session_name or not container_id:
            logger.debug("%s poll_window_state: skipped (missing params)", label)
            return
        logger.debug("%s poll_window_state: started for %s/%s", label, container_id, session_name)
        tm = TmuxManager.get()
        last_active: int | None = None
        last_windows: list[dict] | None = None
        try:
            while True:
                await asyncio.sleep(1)
                try:
                    windows = await tm.list_windows(container_id, session_name)
                    active = next(
                        (w["index"] for w in windows if w.get("active")), None,
                    )
                    # Serialize to comparable form (ignore pane_status fluctuations)
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
                        # Include panes of the active window
                        panes = []
                        if active is not None:
                            try:
                                panes = await tm.list_panes(container_id, session_name, active)
                            except Exception:
                                pass
                        payload = json.dumps(
                            {"active": active, "windows": windows, "panes": panes}
                        )
                        logger.debug("%s poll: sending WINDOW_STATE (active=%s, %d windows)",
                                    label, active, len(windows))
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
    finally:
        with contextlib.suppress(OSError):
            os.close(master_fd)
        with contextlib.suppress(ProcessLookupError):
            proc.terminate()
        await proc.wait()


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
    target = f"{session_name}:{window_index}"

    if _is_local(container_id):
        try:
            tmux_prefix = ["tmux"]
            # Enable CSI u extended keys (e.g. Shift+Enter) before attaching
            await _set_tmux_extended_keys(tmux_prefix)
            # Enable DCS passthrough for tmuxdeck-open
            await _set_tmux_passthrough(tmux_prefix)
            cmd = [*tmux_prefix, "attach-session", "-t", target]
            await _pty_terminal(websocket, cmd, label="Local",
                                tmux_prefix=tmux_prefix, session_name=session_name,
                                container_id=container_id)
        except WebSocketDisconnect:
            pass
        except Exception as e:
            logger.error("Local terminal WebSocket error: %s", e)
        finally:
            with contextlib.suppress(Exception):
                await websocket.close()
        return

    if _is_host(container_id):
        try:
            socket = config.host_tmux_socket
            tmux_prefix = ["tmux", "-S", socket]
            # Enable CSI u extended keys (e.g. Shift+Enter) before attaching
            await _set_tmux_extended_keys(tmux_prefix)
            # Enable DCS passthrough for tmuxdeck-open
            await _set_tmux_passthrough(tmux_prefix)
            cmd = [*tmux_prefix, "attach-session", "-t", target]
            await _pty_terminal(websocket, cmd, label="Host",
                                tmux_prefix=tmux_prefix, session_name=session_name,
                                container_id=container_id)
        except WebSocketDisconnect:
            pass
        except Exception as e:
            logger.error("Host terminal WebSocket error: %s", e)
        finally:
            with contextlib.suppress(Exception):
                await websocket.close()
        return

    dm = DockerManager.get()
    exec_id = None
    sock = None

    try:
        # Enable CSI u extended keys (e.g. Shift+Enter) before attaching
        await dm.exec_command(container_id, ["tmux", "set-option", "-s", "extended-keys", "always"])

        # Enable DCS passthrough for tmuxdeck-open OSC sequences
        await dm.exec_command(container_id, ["tmux", "set-option", "-g", "allow-passthrough", "on"])

        # Start interactive docker exec: tmux attach
        cmd = ["tmux", "attach-session", "-t", target]
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
            try:
                while True:
                    data = await loop.run_in_executor(None, raw_sock.recv, 4096)
                    if not data:
                        break
                    await websocket.send_bytes(data)
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
                                content = await tm.capture_pane(container_id, session_name, win_idx, pane_idx)
                                await websocket.send_text(f"PANE_CONTENT:{win_idx}.{pane_idx}:{content}")
                            except (ValueError, Exception) as e:
                                logger.debug("capture-pane failed: %s", e)
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
                    await asyncio.sleep(1)
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
        if sock:
            try:
                raw_sock = sock._sock if hasattr(sock, "_sock") else sock
                raw_sock.close()
            except Exception:
                pass
        with contextlib.suppress(Exception):
            await websocket.close()
