from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import store
from .api.auth import router as auth_router
from .api.containers import router as containers_router
from .api.files import router as files_router
from .api.images import router as images_router
from .api.notifications import router as notifications_router
from .api.sessions import router as sessions_router
from .api.settings import router as settings_router
from .api.templates import router as templates_router
from .config import config
from .middleware import AuthMiddleware
from .services.notification_manager import NotificationManager
from .ws.terminal import router as ws_router

logger = logging.getLogger(__name__)


def _seed_templates() -> None:
    """Seed templates from docker/templates/*.dockerfile if none exist."""
    existing = store.list_templates()
    if existing:
        return

    templates_path = Path(config.templates_dir)
    if not templates_path.exists():
        logger.info("Templates dir %s not found, skipping seed", templates_path)
        return

    for dockerfile in sorted(templates_path.glob("*.dockerfile")):
        name = dockerfile.stem  # e.g. "basic-dev"
        content = dockerfile.read_text()
        store.create_template(
            {
                "name": name,
                "type": "dockerfile",
                "content": content,
                "buildArgs": {},
                "defaultVolumes": [],
                "defaultEnv": {},
            }
        )
        logger.info("Seeded template: %s", name)


async def _start_telegram_bot() -> object | None:
    """Start Telegram bot if token is configured. Returns bot instance or None."""
    settings = store.get_settings()
    token = settings.get("telegramBotToken", "")
    if not token:
        logger.info("No Telegram bot token configured, skipping bot startup")
        return None

    try:
        from .services.telegram_bot import TelegramBot

        bot = TelegramBot(token)
        nm = NotificationManager.get()
        nm.set_telegram_bot(bot)
        bot.set_notification_manager(nm)

        await bot.start()
        return bot
    except Exception:
        logger.exception("Failed to start Telegram bot")
        return None


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Ensure data directories exist
    store._ensure_dir(config.data_path / "templates")
    store._ensure_dir(config.data_path / "containers")

    # Seed default templates
    _seed_templates()

    # Initialize notification manager
    nm = NotificationManager.get()

    # Start Telegram bot
    telegram_bot = await _start_telegram_bot()

    logger.info("TmuxDeck backend started")
    yield
    logger.info("TmuxDeck backend shutting down")

    # Cleanup
    if telegram_bot:
        await telegram_bot.stop()
    await nm.cleanup()


app = FastAPI(title="TmuxDeck", version="0.1.0", lifespan=lifespan)

# Middleware executes in reverse order of addition (last added runs first).
# AuthMiddleware must be added BEFORE CORSMiddleware so that CORS runs first
# and adds headers to all responses — including 401s from AuthMiddleware.
app.add_middleware(AuthMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routers
app.include_router(auth_router)
app.include_router(containers_router)
app.include_router(files_router)
app.include_router(images_router)
app.include_router(sessions_router)
app.include_router(templates_router)
app.include_router(settings_router)
app.include_router(notifications_router)
app.include_router(ws_router)


@app.get("/health")
async def health():
    return {"status": "ok"}
