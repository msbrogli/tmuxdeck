from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from ..schemas import CreateSessionRequest, CreateWindowRequest, MoveWindowRequest, RenameSessionRequest, SwapWindowsRequest, TmuxSessionResponse, TmuxWindowResponse
from ..services.bridge_manager import BridgeManager, is_bridge
from ..services.debug_log import DebugLog
from ..services.tmux_manager import TmuxManager

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/containers/{container_id}/sessions", tags=["sessions"])


async def _refresh_bridge_sessions(container_id: str) -> None:
    """Refresh cached session list for a bridge container."""
    if not is_bridge(container_id):
        return
    bm = BridgeManager.get()
    conn = bm.get_bridge_for_container(container_id)
    if not conn:
        return
    tm = TmuxManager.get()
    try:
        conn.sessions = await tm.list_sessions(container_id)
    except Exception:
        logger.debug("Failed to refresh bridge sessions for %s", container_id)


@router.get("", response_model=list[TmuxSessionResponse])
async def list_sessions(container_id: str):
    tm = TmuxManager.get()
    try:
        sessions = await tm.list_sessions(container_id)
    except Exception as e:
        raise HTTPException(500, f"Failed to list sessions: {e}") from None
    return [TmuxSessionResponse(**s) for s in sessions]


@router.post("", response_model=TmuxSessionResponse, status_code=201)
async def create_session(container_id: str, req: CreateSessionRequest):
    dl = DebugLog.get()
    tm = TmuxManager.get()
    try:
        session = await tm.create_session(container_id, req.name)
    except Exception as e:
        dl.error("session", f"Failed to create session '{req.name}': {e}", f"container={container_id}")
        raise HTTPException(500, f"Failed to create session: {e}") from None
    dl.info("session", f"Session created: {req.name}", f"container={container_id} id={session['id']}")
    await _refresh_bridge_sessions(container_id)
    return TmuxSessionResponse(**session)


@router.patch("/{session_id}", status_code=204)
async def rename_session(container_id: str, session_id: str, req: RenameSessionRequest):
    tm = TmuxManager.get()

    # Resolve session ID to tmux session name
    old_name = await tm.resolve_session_id(container_id, session_id)
    if old_name is None:
        # Try using session_id directly as a name
        old_name = session_id

    try:
        await tm.rename_session(container_id, old_name, req.name)
    except Exception as e:
        raise HTTPException(500, f"Failed to rename session: {e}") from None
    await _refresh_bridge_sessions(container_id)


@router.post("/{session_id}/swap-windows", status_code=204)
async def swap_windows(container_id: str, session_id: str, req: SwapWindowsRequest):
    tm = TmuxManager.get()

    session_name = await tm.resolve_session_id(container_id, session_id)
    if session_name is None:
        session_name = session_id

    try:
        await tm.swap_windows(container_id, session_name, req.index1, req.index2)
    except Exception as e:
        raise HTTPException(500, f"Failed to swap windows: {e}") from None


@router.post("/{session_id}/move-window", status_code=204)
async def move_window(container_id: str, session_id: str, req: MoveWindowRequest):
    tm = TmuxManager.get()

    src_name = await tm.resolve_session_id(container_id, session_id)
    if src_name is None:
        src_name = session_id

    dst_name = await tm.resolve_session_id(container_id, req.target_session_id)
    if dst_name is None:
        dst_name = req.target_session_id

    try:
        await tm.move_window(container_id, src_name, req.window_index, dst_name)
    except Exception as e:
        raise HTTPException(500, f"Failed to move window: {e}") from None


@router.post("/{session_id}/windows", response_model=list[TmuxWindowResponse], status_code=201)
async def create_window(container_id: str, session_id: str, req: CreateWindowRequest | None = None):
    tm = TmuxManager.get()

    session_name = await tm.resolve_session_id(container_id, session_id)
    if session_name is None:
        session_name = session_id

    try:
        windows = await tm.create_window(container_id, session_name, req.name if req else None)
    except Exception as e:
        raise HTTPException(500, f"Failed to create window: {e}") from None
    return [TmuxWindowResponse(**w) for w in windows]


@router.post("/{session_id}/windows/{window_index}/clear-status", status_code=204)
async def clear_window_status(container_id: str, session_id: str, window_index: int):
    tm = TmuxManager.get()

    session_name = await tm.resolve_session_id(container_id, session_id)
    if session_name is None:
        session_name = session_id

    try:
        await tm.set_pane_status(container_id, session_name, window_index, "idle")
    except Exception as e:
        raise HTTPException(500, f"Failed to clear window status: {e}") from None


@router.post("/{session_id}/clear-status", status_code=204)
async def clear_session_status(container_id: str, session_id: str):
    tm = TmuxManager.get()

    session_name = await tm.resolve_session_id(container_id, session_id)
    if session_name is None:
        session_name = session_id

    try:
        windows = await tm.list_windows(container_id, session_name)
        for win in windows:
            await tm.set_pane_status(container_id, session_name, win["index"], "idle")
    except Exception as e:
        raise HTTPException(500, f"Failed to clear session status: {e}") from None


@router.delete("/{session_id}", status_code=204)
async def kill_session(container_id: str, session_id: str):
    tm = TmuxManager.get()

    # Resolve session ID to tmux session name
    session_name = await tm.resolve_session_id(container_id, session_id)
    if session_name is None:
        session_name = session_id

    dl = DebugLog.get()
    try:
        await tm.kill_session(container_id, session_name)
    except Exception as e:
        dl.error("session", f"Failed to kill session '{session_name}': {e}", f"container={container_id}")
        raise HTTPException(500, f"Failed to kill session: {e}") from None
    dl.info("session", f"Session killed: {session_name}", f"container={container_id}")
    await _refresh_bridge_sessions(container_id)
