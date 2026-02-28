"""Manages connected bridge agents and multiplexed terminal I/O."""

from __future__ import annotations

import asyncio
import json
import logging
import struct
import uuid

from fastapi import WebSocket

from .debug_log import DebugLog

logger = logging.getLogger(__name__)

BRIDGE_PREFIX = "bridge:"


def is_bridge(container_id: str) -> bool:
    return container_id.startswith(BRIDGE_PREFIX)


def bridge_id_from_container(container_id: str) -> str:
    return container_id[len(BRIDGE_PREFIX):]


class BridgeConnection:
    """A single connected bridge agent."""

    def __init__(self, bridge_id: str, name: str, ws: WebSocket) -> None:
        self.bridge_id = bridge_id
        self.name = name
        self.ws = ws
        self.sessions: list[dict] = []
        self._pending: dict[str, asyncio.Future] = {}
        self._terminal_relays: dict[int, WebSocket] = {}  # channel_id → user WS
        self._next_channel: int = 1

    def allocate_channel(self) -> int:
        """Allocate the next available channel ID."""
        channel = self._next_channel
        self._next_channel += 1
        if self._next_channel > 65535:
            self._next_channel = 1
        return channel

    def register_terminal(self, channel_id: int, user_ws: WebSocket) -> None:
        self._terminal_relays[channel_id] = user_ws

    def unregister_terminal(self, channel_id: int) -> None:
        self._terminal_relays.pop(channel_id, None)

    def get_terminal_ws(self, channel_id: int) -> WebSocket | None:
        return self._terminal_relays.get(channel_id)

    async def send_json(self, msg: dict) -> None:
        await self.ws.send_text(json.dumps(msg))

    async def send_binary(self, channel_id: int, data: bytes) -> None:
        header = struct.pack(">H", channel_id)
        await self.ws.send_bytes(header + data)

    async def request(self, msg: dict, timeout: float = 10.0) -> dict:
        """Send a JSON message and await a correlated response."""
        req_id = str(uuid.uuid4())[:8]
        msg["id"] = req_id
        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending[req_id] = fut
        try:
            await self.send_json(msg)
            return await asyncio.wait_for(fut, timeout=timeout)
        finally:
            self._pending.pop(req_id, None)

    def resolve_pending(self, req_id: str, result: dict) -> None:
        fut = self._pending.get(req_id)
        if fut and not fut.done():
            fut.set_result(result)

    async def close_all_terminals(self) -> None:
        """Close all relayed user WebSockets when bridge disconnects."""
        for channel_id, user_ws in list(self._terminal_relays.items()):
            try:
                await user_ws.close(code=1001, reason="Bridge disconnected")
            except Exception:
                pass
        self._terminal_relays.clear()


class BridgeManager:
    """Singleton tracking all connected bridge agents."""

    _instance: BridgeManager | None = None

    def __init__(self) -> None:
        self.bridges: dict[str, BridgeConnection] = {}  # bridge_id → connection

    @classmethod
    def get(cls) -> BridgeManager:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def register(self, bridge_id: str, name: str, ws: WebSocket) -> BridgeConnection:
        conn = BridgeConnection(bridge_id, name, ws)
        self.bridges[bridge_id] = conn
        logger.info("Bridge registered: %s (%s)", bridge_id, name)
        DebugLog.get().info("bridge", f"Bridge connected: {name}", f"id={bridge_id}")
        return conn

    def unregister(self, bridge_id: str) -> None:
        conn = self.bridges.pop(bridge_id, None)
        if conn:
            logger.info("Bridge unregistered: %s (%s)", bridge_id, conn.name)
            DebugLog.get().info("bridge", f"Bridge disconnected: {conn.name}", f"id={bridge_id}")

    def get_bridge(self, bridge_id: str) -> BridgeConnection | None:
        return self.bridges.get(bridge_id)

    def get_bridge_for_container(self, container_id: str) -> BridgeConnection | None:
        if not is_bridge(container_id):
            return None
        bid = bridge_id_from_container(container_id)
        return self.bridges.get(bid)

    def is_connected(self, bridge_id: str) -> bool:
        return bridge_id in self.bridges

    def list_bridges(self) -> list[BridgeConnection]:
        return list(self.bridges.values())
