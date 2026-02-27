"""Telegram bot service for notification forwarding and reply handling."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from telegram.constants import ParseMode
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from .. import store

if TYPE_CHECKING:
    from telegram import Update

    from .notification_manager import NotificationRecord

logger = logging.getLogger(__name__)


def _escape_md2(text: str) -> str:
    """Escape special characters for MarkdownV2."""
    special = r"_*[]()~`>#+-=|{}.!"
    return "".join(f"\\{c}" if c in special else c for c in text)


class TelegramBot:
    def __init__(self, token: str) -> None:
        self._token = token
        self._app: Application | None = None
        self._notification_manager: object | None = None

    def set_notification_manager(self, manager: object) -> None:
        self._notification_manager = manager

    async def start(self) -> None:
        self._app = Application.builder().token(self._token).build()

        self._app.add_handler(CommandHandler("start", self._handle_start))
        self._app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, self._handle_message))

        await self._app.initialize()
        await self._app.start()
        await self._app.updater.start_polling(drop_pending_updates=True)

        logger.info("Telegram bot started")

    async def stop(self) -> None:
        if self._app:
            await self._app.updater.stop()
            await self._app.stop()
            await self._app.shutdown()
            logger.info("Telegram bot stopped")

    async def send_notification(self, record: NotificationRecord) -> None:
        """Send a notification to all registered chat IDs."""
        if not self._app:
            return

        chat_ids = store.get_telegram_chats()
        if not chat_ids:
            logger.warning("No registered Telegram chats, skipping notification")
            return

        container_display = _escape_md2(record.container_id or "unknown")
        session_display = _escape_md2(f"{record.tmux_session}:{record.tmux_window}")
        message_text = _escape_md2(record.message or "No message")
        title_text = _escape_md2(record.title or "Claude Code needs attention")

        text = (
            f"🔔 *{title_text}*\n\n"
            f"📦 `{container_display}`  ·  💻 `{session_display}`\n\n"
            f"{message_text}\n\n"
            f"↩️ _Reply to this message to respond_"
        )

        for chat_id in chat_ids:
            try:
                msg = await self._app.bot.send_message(
                    chat_id=chat_id,
                    text=text,
                    parse_mode=ParseMode.MARKDOWN_V2,
                )
                record.telegram_message_id = msg.message_id
                record.telegram_chat_id = chat_id
                logger.info("Sent Telegram notification to chat %d", chat_id)
            except Exception:
                logger.exception("Failed to send Telegram message to chat %d", chat_id)

    async def _handle_start(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        """Handle /start <secret> command for registration."""
        if not update.message or not update.effective_chat:
            return

        chat_id = update.effective_chat.id
        args = context.args or []

        if not args:
            await update.message.reply_text(
                "⚠️ Please provide the registration secret:\n"
                "/start <secret>\n\n"
                "You can find the secret in TmuxDeck Settings → Telegram Bot section."
            )
            return

        secret = args[0]
        settings = store.get_settings()
        expected_secret = settings.get("telegramRegistrationSecret", "")

        if not expected_secret:
            await update.message.reply_text(
                "⚠️ No registration secret configured in TmuxDeck.\n"
                "Please generate one in Settings → Telegram Bot first."
            )
            return

        if secret != expected_secret:
            await update.message.reply_text("❌ Invalid registration secret.")
            return

        # Check if already registered
        existing = store.get_telegram_chats()
        if chat_id in existing:
            await update.message.reply_text("✅ This chat is already registered for notifications.")
            return

        user = update.effective_chat
        store.add_telegram_chat(chat_id, username=user.username, first_name=user.first_name)
        await update.message.reply_text(
            "✅ Registration successful!\n"
            "You will get tmux notifications here when no browser is active."
        )
        logger.info("Registered Telegram chat: %d", chat_id)

    async def _handle_message(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        """Handle text messages — only replies to notification messages."""
        if not update.message or not update.effective_chat:
            return

        # Check this is a registered chat
        chat_id = update.effective_chat.id
        registered = store.get_telegram_chats()
        if chat_id not in registered:
            await update.message.reply_text(
                "⚠️ This chat is not registered. Use /start <secret> first."
            )
            return

        # Must be a reply to a notification
        if not update.message.reply_to_message:
            await update.message.reply_text(
                "⚠️ Please reply to a notification message. "
                "Direct messages are not supported."
            )
            return

        reply_to_id = update.message.reply_to_message.message_id
        text = update.message.text or ""

        if not text.strip():
            return

        # Route through notification manager
        from .notification_manager import NotificationManager

        nm = NotificationManager.get()
        record = nm.handle_telegram_reply(reply_to_id, text)

        if record:
            await update.message.reply_text("✅")
        else:
            await update.message.reply_text(
                "⚠️ Could not find the notification for this message. "
                "It may have expired."
            )
