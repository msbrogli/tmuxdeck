from __future__ import annotations

import secrets

from fastapi import APIRouter

from .. import store
from ..schemas import SettingsResponse, UpdateSettingsRequest
from ..store import _DEFAULT_HOTKEYS

router = APIRouter(prefix="/api/v1/settings", tags=["settings"])


def _to_response(data: dict) -> SettingsResponse:
    return SettingsResponse(
        telegram_bot_token=data.get("telegramBotToken", ""),
        telegram_allowed_users=data.get("telegramAllowedUsers", []),
        default_volume_mounts=data.get("defaultVolumeMounts", []),
        ssh_key_path=data.get("sshKeyPath", "~/.ssh/id_rsa"),
        telegram_registration_secret=data.get("telegramRegistrationSecret", ""),
        telegram_notification_timeout_secs=data.get("telegramNotificationTimeoutSecs", 60),
        hotkeys={**_DEFAULT_HOTKEYS, **data.get("hotkeys", {})},
    )


@router.get("", response_model=SettingsResponse)
async def get_settings():
    return _to_response(store.get_settings())


@router.post("", response_model=SettingsResponse)
async def update_settings(req: UpdateSettingsRequest):
    updates = {}
    if req.telegram_bot_token is not None:
        updates["telegramBotToken"] = req.telegram_bot_token
    if req.telegram_allowed_users is not None:
        updates["telegramAllowedUsers"] = req.telegram_allowed_users
    if req.default_volume_mounts is not None:
        updates["defaultVolumeMounts"] = req.default_volume_mounts
    if req.ssh_key_path is not None:
        updates["sshKeyPath"] = req.ssh_key_path
    if req.telegram_registration_secret is not None:
        updates["telegramRegistrationSecret"] = req.telegram_registration_secret
    if req.telegram_notification_timeout_secs is not None:
        updates["telegramNotificationTimeoutSecs"] = req.telegram_notification_timeout_secs
    if req.hotkeys is not None:
        updates["hotkeys"] = req.hotkeys

    return _to_response(store.update_settings(updates))


@router.post("/generate-secret")
async def generate_secret():
    """Generate a new Telegram registration secret and save it."""
    secret = secrets.token_urlsafe(16)
    store.update_settings({"telegramRegistrationSecret": secret})
    return {"secret": secret}


@router.get("/telegram-chats")
async def list_telegram_chats():
    """Return list of registered Telegram chats with user info."""
    return {"chats": store.get_telegram_chat_details()}


@router.delete("/telegram-chats/{chat_id}")
async def remove_telegram_chat(chat_id: int):
    """Unregister a Telegram chat."""
    store.remove_telegram_chat(chat_id)
    return {"chats": store.get_telegram_chat_details()}
