"""Simple JSON file store replacing SQLAlchemy.

Layout:
    data/templates/{id}.json
    data/containers/{docker_id}.json
    data/settings.json
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from pathlib import Path  # noqa: TC003 — used at runtime
from typing import Any

from .config import config


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def _read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def _write_json(path: Path, data: dict[str, Any]) -> None:
    _ensure_dir(path.parent)
    path.write_text(json.dumps(data, indent=2))


# --- Templates -----------------------------------------------------------


def templates_dir() -> Path:
    return config.data_path / "templates"


def list_templates() -> list[dict[str, Any]]:
    d = templates_dir()
    if not d.exists():
        return []
    results = []
    for f in sorted(d.glob("*.json")):
        results.append(_read_json(f))
    return results


def get_template(template_id: str) -> dict[str, Any] | None:
    p = templates_dir() / f"{template_id}.json"
    if not p.exists():
        return None
    return _read_json(p)


def create_template(data: dict[str, Any]) -> dict[str, Any]:
    tid = str(uuid.uuid4())
    now = _now()
    record = {
        "id": tid,
        "name": data["name"],
        "type": data.get("type", "dockerfile"),
        "content": data.get("content", ""),
        "buildArgs": data.get("buildArgs", {}),
        "defaultVolumes": data.get("defaultVolumes", []),
        "defaultEnv": data.get("defaultEnv", {}),
        "createdAt": now,
        "updatedAt": now,
    }
    _write_json(templates_dir() / f"{tid}.json", record)
    return record


def update_template(template_id: str, data: dict[str, Any]) -> dict[str, Any] | None:
    p = templates_dir() / f"{template_id}.json"
    if not p.exists():
        return None
    record = _read_json(p)
    for key in ("name", "type", "content", "buildArgs", "defaultVolumes", "defaultEnv"):
        if key in data and data[key] is not None:
            record[key] = data[key]
    record["updatedAt"] = _now()
    _write_json(p, record)
    return record


def delete_template(template_id: str) -> bool:
    p = templates_dir() / f"{template_id}.json"
    if not p.exists():
        return False
    p.unlink()
    return True


# --- Container Metadata --------------------------------------------------


def containers_dir() -> Path:
    return config.data_path / "containers"


def list_container_metas() -> list[dict[str, Any]]:
    d = containers_dir()
    if not d.exists():
        return []
    results = []
    for f in sorted(d.glob("*.json")):
        results.append(_read_json(f))
    return results


def get_container_meta(docker_id: str) -> dict[str, Any] | None:
    """Lookup by Docker short ID or full ID."""
    d = containers_dir()
    if not d.exists():
        return None
    # Try exact match first
    p = d / f"{docker_id}.json"
    if p.exists():
        return _read_json(p)
    # Try prefix match on filenames
    for f in d.glob("*.json"):
        if f.stem.startswith(docker_id) or docker_id.startswith(f.stem):
            return _read_json(f)
    return None


def save_container_meta(docker_id: str, data: dict[str, Any]) -> dict[str, Any]:
    now = _now()
    record = {
        "dockerContainerId": docker_id,
        "displayName": data["displayName"],
        "templateId": data.get("templateId"),
        "createdAt": data.get("createdAt", now),
    }
    _write_json(containers_dir() / f"{docker_id}.json", record)
    return record


def update_container_meta(docker_id: str, data: dict[str, Any]) -> dict[str, Any] | None:
    meta = get_container_meta(docker_id)
    if meta is None:
        return None
    for key, value in data.items():
        if value is not None:
            meta[key] = value
    # Re-save using the ID from the record
    _write_json(containers_dir() / f"{meta['dockerContainerId']}.json", meta)
    return meta


def delete_container_meta(docker_id: str) -> bool:
    d = containers_dir()
    p = d / f"{docker_id}.json"
    if p.exists():
        p.unlink()
        return True
    # Try prefix match
    for f in d.glob("*.json"):
        if f.stem.startswith(docker_id) or docker_id.startswith(f.stem):
            f.unlink()
            return True
    return False


# --- Settings -------------------------------------------------------------


def settings_path() -> Path:
    return config.data_path / "settings.json"


_DEFAULT_HOTKEYS: dict[str, str] = {
    "quickSwitch": "Ctrl+K",
    "showHelp": "Ctrl+H",
    "nextItem": "Ctrl+ArrowDown",
    "prevItem": "Ctrl+ArrowUp",
    "foldSession": "Ctrl+ArrowLeft",
    "unfoldSession": "Ctrl+ArrowRight",
    "moveWindowUp": "Shift+Ctrl+ArrowUp",
    "moveWindowDown": "Shift+Ctrl+ArrowDown",
    "deselect": "Escape Escape",
}

_DEFAULT_SETTINGS: dict[str, Any] = {
    "telegramBotToken": "",
    "telegramAllowedUsers": [],
    "defaultVolumeMounts": [],
    "sshKeyPath": "~/.ssh/id_rsa",
    "telegramRegistrationSecret": "",
    "telegramNotificationTimeoutSecs": 60,
    "hotkeys": dict(_DEFAULT_HOTKEYS),
}


def get_settings() -> dict[str, Any]:
    p = settings_path()
    if not p.exists():
        _ensure_dir(p.parent)
        _write_json(p, _DEFAULT_SETTINGS)
        return dict(_DEFAULT_SETTINGS)
    return _read_json(p)


def update_settings(data: dict[str, Any]) -> dict[str, Any]:
    current = get_settings()
    for key, value in data.items():
        if value is not None:
            current[key] = value
    _write_json(settings_path(), current)
    return current


# --- Telegram Chats ----------------------------------------------------------


def telegram_chats_path() -> Path:
    return config.data_path / "telegram_chats.json"


def get_telegram_chats() -> list[int]:
    """Return flat list of chat IDs (used by bot for sending)."""
    return [c["chatId"] for c in get_telegram_chat_details()]


def get_telegram_chat_details() -> list[dict[str, Any]]:
    """Return list of chat records with user info."""
    p = telegram_chats_path()
    if not p.exists():
        return []
    data = json.loads(p.read_text())
    # Migrate old format (flat list of ints) to new format
    if "chat_ids" in data and "chats" not in data:
        return [{"chatId": cid, "username": None, "firstName": None} for cid in data["chat_ids"]]
    return data.get("chats", [])


def _save_chats(chats: list[dict[str, Any]]) -> None:
    _ensure_dir(telegram_chats_path().parent)
    telegram_chats_path().write_text(json.dumps({"chats": chats}, indent=2))


def add_telegram_chat(
    chat_id: int,
    username: str | None = None,
    first_name: str | None = None,
) -> list[int]:
    chats = get_telegram_chat_details()
    if not any(c["chatId"] == chat_id for c in chats):
        chats.append({"chatId": chat_id, "username": username, "firstName": first_name})
        _save_chats(chats)
    return [c["chatId"] for c in chats]


def remove_telegram_chat(chat_id: int) -> list[int]:
    chats = [c for c in get_telegram_chat_details() if c["chatId"] != chat_id]
    _save_chats(chats)
    return [c["chatId"] for c in chats]
