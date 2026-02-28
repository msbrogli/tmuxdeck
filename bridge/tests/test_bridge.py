"""Tests for bridge protocol handling."""

from __future__ import annotations

import struct

import pytest

from tmuxdeck_bridge.bridge import Bridge
from tmuxdeck_bridge.config import BridgeConfig


def test_bridge_init():
    cfg = BridgeConfig(url="ws://localhost:8000/ws/bridge", token="test")
    bridge = Bridge(cfg)
    assert bridge._running is False
    assert bridge._terminals == {}
    assert bridge._ws is None


def test_build_tmux_cmd_no_socket():
    cfg = BridgeConfig(url="ws://localhost:8000/ws/bridge", token="test")
    bridge = Bridge(cfg)
    cmd = bridge._build_tmux_cmd(["tmux", "list-sessions"])
    assert cmd == ["tmux", "list-sessions"]


def test_build_tmux_cmd_with_socket():
    cfg = BridgeConfig(
        url="ws://localhost:8000/ws/bridge",
        token="test",
        host_tmux_socket="/tmp/tmux/default",
    )
    bridge = Bridge(cfg)
    cmd = bridge._build_tmux_cmd(["tmux", "list-sessions"])
    assert cmd == ["tmux", "-S", "/tmp/tmux/default", "list-sessions"]


def test_build_tmux_cmd_non_tmux():
    cfg = BridgeConfig(
        url="ws://localhost:8000/ws/bridge",
        token="test",
        host_tmux_socket="/tmp/tmux/default",
    )
    bridge = Bridge(cfg)
    cmd = bridge._build_tmux_cmd(["echo", "hello"])
    assert cmd == ["echo", "hello"]


@pytest.mark.asyncio
async def test_handle_binary_routes_to_terminal():
    cfg = BridgeConfig(url="ws://localhost:8000/ws/bridge", token="test")
    bridge = Bridge(cfg)

    # Create a mock terminal
    written_data = []

    class MockTerminal:
        def write(self, data):
            written_data.append(data)

    channel_id = 42
    bridge._terminals[channel_id] = MockTerminal()

    # Simulate binary frame: [2-byte channel_id][payload]
    payload = b"hello terminal"
    frame = struct.pack(">H", channel_id) + payload
    await bridge._handle_binary(frame)

    assert written_data == [payload]


@pytest.mark.asyncio
async def test_handle_binary_ignores_unknown_channel():
    cfg = BridgeConfig(url="ws://localhost:8000/ws/bridge", token="test")
    bridge = Bridge(cfg)

    frame = struct.pack(">H", 999) + b"data"
    # Should not raise
    await bridge._handle_binary(frame)


@pytest.mark.asyncio
async def test_handle_binary_short_frame():
    cfg = BridgeConfig(url="ws://localhost:8000/ws/bridge", token="test")
    bridge = Bridge(cfg)

    # Frame too short (< 2 bytes)
    await bridge._handle_binary(b"\x00")
    # Should not raise
