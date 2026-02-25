from __future__ import annotations

from fastapi import APIRouter

from .. import store
from ..schemas import SettingsResponse, UpdateSettingsRequest

router = APIRouter(prefix="/api/v1/settings", tags=["settings"])


def _to_response(data: dict) -> SettingsResponse:
    return SettingsResponse(
        telegram_bot_token=data.get("telegramBotToken", ""),
        telegram_allowed_users=data.get("telegramAllowedUsers", []),
        default_volume_mounts=data.get("defaultVolumeMounts", []),
        ssh_key_path=data.get("sshKeyPath", "~/.ssh/id_rsa"),
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

    return _to_response(store.update_settings(updates))
