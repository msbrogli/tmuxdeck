"""In-memory notification store and lifecycle management."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class NotificationRecord:
    id: str
    message: str
    title: str
    notification_type: str
    session_id: str
    container_id: str
    tmux_session: str
    tmux_window: int
    created_at: str
    status: str = "pending"  # pending | telegram_sent | dismissed
    telegram_message_id: int | None = None
    telegram_chat_id: int | None = None
    channels: list[str] = field(default_factory=lambda: ["web", "os", "telegram"])
    responses: list[str] = field(default_factory=list)
    _timer_task: asyncio.Task | None = field(default=None, repr=False)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "message": self.message,
            "title": self.title,
            "notificationType": self.notification_type,
            "sessionId": self.session_id,
            "containerId": self.container_id,
            "tmuxSession": self.tmux_session,
            "tmuxWindow": self.tmux_window,
            "createdAt": self.created_at,
            "status": self.status,
            "channels": self.channels,
        }


class NotificationManager:
    _instance: NotificationManager | None = None

    def __init__(self) -> None:
        self._notifications: dict[str, NotificationRecord] = {}
        self._sse_subscribers: set[asyncio.Queue[dict | None]] = set()
        self._telegram_bot: Any = None  # Set after TelegramBot is created

    @classmethod
    def get(cls) -> NotificationManager:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def set_telegram_bot(self, bot: Any) -> None:
        self._telegram_bot = bot

    def _get_timeout(self) -> int:
        from .. import store
        settings = store.get_settings()
        return settings.get("telegramNotificationTimeoutSecs", 60)

    def create(self, data: dict[str, Any]) -> NotificationRecord:
        all_channels = ["web", "os", "telegram"]
        raw_channels = data.get("channels") or []
        channels = [c for c in raw_channels if c in all_channels] or all_channels

        record = NotificationRecord(
            id=str(uuid.uuid4()),
            message=data.get("message", ""),
            title=data.get("title", ""),
            notification_type=data.get("notification_type", ""),
            session_id=data.get("session_id", ""),
            container_id=data.get("container_id", ""),
            tmux_session=data.get("tmux_session", ""),
            tmux_window=data.get("tmux_window", 0),
            created_at=datetime.now(UTC).isoformat(),
            channels=channels,
        )
        self._notifications[record.id] = record

        # Broadcast to SSE subscribers
        self._broadcast({"event": "notification", "data": record.to_dict()})

        # Send Telegram: immediately if web channel is disabled, otherwise
        # delay as a fallback (gives the browser time to dismiss first).
        if "telegram" in record.channels:
            delay = 0 if "web" not in record.channels else self._get_timeout()
            record._timer_task = asyncio.create_task(
                self._schedule_telegram(record.id, delay)
            )

        logger.info(
            "Notification created: %s (session=%s, container=%s)",
            record.id,
            record.session_id,
            record.container_id,
        )
        return record

    def dismiss(
        self,
        session_id: str = "",
        container_id: str = "",
        tmux_session: str = "",
        tmux_window: int | None = None,
    ) -> int:
        """Dismiss pending notifications matching the given filters. Returns count dismissed."""
        count = 0
        for record in list(self._notifications.values()):
            if record.status == "dismissed":
                continue

            match = True
            if session_id and record.session_id != session_id:
                match = False
            if container_id and record.container_id != container_id:
                match = False
            if tmux_session and record.tmux_session != tmux_session:
                match = False
            if tmux_window is not None and record.tmux_window != tmux_window:
                match = False

            if match:
                record.status = "dismissed"
                if record._timer_task and not record._timer_task.done():
                    record._timer_task.cancel()
                count += 1

        if count > 0:
            self._broadcast({"event": "dismiss", "data": {"count": count}})
            logger.info("Dismissed %d notifications", count)

        return count

    def get_pending(self) -> list[NotificationRecord]:
        return [n for n in self._notifications.values() if n.status == "pending"]

    def get_all(self) -> list[NotificationRecord]:
        return list(self._notifications.values())

    def handle_telegram_reply(self, message_id: int, text: str) -> NotificationRecord | None:
        """Look up notification by telegram_message_id, route reply to terminal."""
        for record in self._notifications.values():
            if record.telegram_message_id == message_id:
                record.responses.append(text)
                self._send_to_terminal(record, text)
                return record
        return None

    def subscribe_sse(self) -> asyncio.Queue[dict | None]:
        queue: asyncio.Queue[dict | None] = asyncio.Queue()
        self._sse_subscribers.add(queue)
        return queue

    def unsubscribe_sse(self, queue: asyncio.Queue[dict | None]) -> None:
        self._sse_subscribers.discard(queue)

    def _broadcast(self, event: dict) -> None:
        for queue in self._sse_subscribers:
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(event)

    async def _schedule_telegram(self, notification_id: str, timeout_secs: int) -> None:
        try:
            await asyncio.sleep(timeout_secs)
        except asyncio.CancelledError:
            return

        record = self._notifications.get(notification_id)
        if not record or record.status != "pending":
            return

        if self._telegram_bot:
            try:
                await self._telegram_bot.send_notification(record)
                record.status = "telegram_sent"
                logger.info("Telegram notification sent for %s", notification_id)
            except Exception:
                logger.exception("Failed to send Telegram notification for %s", notification_id)

    def _send_to_terminal(self, record: NotificationRecord, text: str) -> None:
        """Send text to the correct terminal via tmux send-keys."""
        asyncio.create_task(self._async_send_to_terminal(record, text))

    async def _async_send_to_terminal(self, record: NotificationRecord, text: str) -> None:
        from .tmux_manager import TmuxManager

        tm = TmuxManager.get()
        target = f"{record.tmux_session}:{record.tmux_window}"
        container_id = record.container_id

        try:
            # Send the text followed by Enter
            await tm._run_cmd(container_id, ["tmux", "send-keys", "-t", target, text, "Enter"])
            logger.info(
                "Sent reply to terminal: container=%s target=%s",
                container_id,
                target,
            )
        except Exception:
            logger.exception("Failed to send reply to terminal")

    async def cleanup(self) -> None:
        """Cancel all pending timers."""
        for record in self._notifications.values():
            if record._timer_task and not record._timer_task.done():
                record._timer_task.cancel()
        # Signal SSE subscribers to close
        for queue in self._sse_subscribers:
            await queue.put(None)
        self._sse_subscribers.clear()
        self._notifications.clear()
