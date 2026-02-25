from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import store
from .api.auth import router as auth_router
from .api.containers import router as containers_router
from .api.images import router as images_router
from .api.sessions import router as sessions_router
from .api.settings import router as settings_router
from .api.templates import router as templates_router
from .config import config
from .middleware import AuthMiddleware
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Ensure data directories exist
    store._ensure_dir(config.data_path / "templates")
    store._ensure_dir(config.data_path / "containers")

    # Seed default templates
    _seed_templates()

    logger.info("TmuxDeck backend started")
    yield
    logger.info("TmuxDeck backend shutting down")


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
app.include_router(images_router)
app.include_router(sessions_router)
app.include_router(templates_router)
app.include_router(settings_router)
app.include_router(ws_router)


@app.get("/health")
async def health():
    return {"status": "ok"}
