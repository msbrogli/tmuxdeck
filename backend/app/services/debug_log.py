"""In-memory ring buffer for debug log entries."""

from __future__ import annotations

import uuid
from collections import deque
from datetime import UTC, datetime
from typing import Any


class LogEntry:
    __slots__ = ("id", "timestamp", "level", "source", "message", "detail")

    def __init__(self, level: str, source: str, message: str, detail: str | None = None) -> None:
        self.id = uuid.uuid4().hex[:8]
        self.timestamp = datetime.now(UTC).isoformat()
        self.level = level
        self.source = source
        self.message = message
        self.detail = detail

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "id": self.id,
            "timestamp": self.timestamp,
            "level": self.level,
            "source": self.source,
            "message": self.message,
        }
        if self.detail:
            d["detail"] = self.detail
        return d


class DebugLog:
    """Singleton in-memory ring buffer (max 2000 entries)."""

    _instance: DebugLog | None = None

    def __init__(self, maxlen: int = 2000) -> None:
        self._entries: deque[LogEntry] = deque(maxlen=maxlen)

    @classmethod
    def get(cls) -> DebugLog:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def info(self, source: str, message: str, detail: str | None = None) -> None:
        self._entries.append(LogEntry("info", source, message, detail))

    def warn(self, source: str, message: str, detail: str | None = None) -> None:
        self._entries.append(LogEntry("warn", source, message, detail))

    def error(self, source: str, message: str, detail: str | None = None) -> None:
        self._entries.append(LogEntry("error", source, message, detail))

    def get_entries(self) -> list[dict[str, Any]]:
        return [e.to_dict() for e in self._entries]

    def clear(self) -> None:
        self._entries.clear()
