"""Notification REST + SSE endpoints."""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from ..schemas import DismissRequest, NotificationRequest, NotificationResponse
from ..services.notification_manager import NotificationManager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/notifications", tags=["notifications"])


@router.post("", status_code=201)
async def create_notification(req: NotificationRequest):
    """Receive notification from hook script (no auth required)."""
    nm = NotificationManager.get()
    record = nm.create(req.model_dump())
    return NotificationResponse(
        id=record.id,
        message=record.message,
        title=record.title,
        notification_type=record.notification_type,
        session_id=record.session_id,
        container_id=record.container_id,
        tmux_session=record.tmux_session,
        tmux_window=record.tmux_window,
        created_at=record.created_at,
        status=record.status,
        channels=record.channels,
    )


@router.post("/dismiss")
async def dismiss_notifications(req: DismissRequest):
    """Dismiss pending notifications (from UserPromptSubmit/Stop hooks, no auth required)."""
    nm = NotificationManager.get()
    count = nm.dismiss(
        session_id=req.session_id,
        container_id=req.container_id,
        tmux_session=req.tmux_session,
        tmux_window=req.tmux_window,
    )
    return {"dismissed": count}


@router.get("")
async def list_notifications():
    """List pending notifications (authenticated)."""
    nm = NotificationManager.get()
    return [
        NotificationResponse(
            id=r.id,
            message=r.message,
            title=r.title,
            notification_type=r.notification_type,
            session_id=r.session_id,
            container_id=r.container_id,
            tmux_session=r.tmux_session,
            tmux_window=r.tmux_window,
            created_at=r.created_at,
            status=r.status,
            channels=r.channels,
        )
        for r in nm.get_pending()
    ]


@router.get("/stream")
async def stream_notifications():
    """SSE endpoint for real-time notification push (authenticated)."""
    nm = NotificationManager.get()
    queue = nm.subscribe_sse()

    async def _generate():
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=30)
                except TimeoutError:
                    # Send keepalive comment
                    yield ": keepalive\n\n"
                    continue

                if event is None:
                    # Shutdown signal
                    break

                yield f"data: {json.dumps(event)}\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            nm.unsubscribe_sse(queue)

    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
