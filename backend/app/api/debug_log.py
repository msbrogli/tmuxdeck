from __future__ import annotations

from fastapi import APIRouter

from ..services.debug_log import DebugLog

router = APIRouter(prefix="/api/v1/debug-log", tags=["debug-log"])


@router.get("")
async def get_debug_log():
    dl = DebugLog.get()
    return {"entries": dl.get_entries()}


@router.delete("", status_code=204)
async def clear_debug_log():
    dl = DebugLog.get()
    dl.clear()
