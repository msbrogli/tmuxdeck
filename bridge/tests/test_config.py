"""Tests for bridge configuration parsing."""

from __future__ import annotations

import sys

from tmuxdeck_bridge.config import BridgeConfig, parse_config


def test_bridge_config_defaults():
    cfg = BridgeConfig()
    assert cfg.url == ""
    assert cfg.token == ""
    assert cfg.name == "bridge"
    assert cfg.local is True
    assert cfg.host_tmux_socket == ""
    assert cfg.docker_socket == ""
    assert cfg.docker_label == ""
    assert cfg.session_report_interval == 5.0
    assert cfg.reconnect_min == 5.0
    assert cfg.reconnect_max == 60.0


def test_bridge_config_custom():
    cfg = BridgeConfig(
        url="ws://example.com/ws/bridge",
        token="secret",
        name="my-server",
        local=False,
        host_tmux_socket="/tmp/tmux-1000/default",
        docker_socket="/var/run/docker.sock",
        docker_label="tmuxdeck=true",
    )
    assert cfg.url == "ws://example.com/ws/bridge"
    assert cfg.token == "secret"
    assert cfg.name == "my-server"
    assert cfg.local is False
    assert cfg.host_tmux_socket == "/tmp/tmux-1000/default"
    assert cfg.docker_socket == "/var/run/docker.sock"
    assert cfg.docker_label == "tmuxdeck=true"


def test_parse_config_basic(monkeypatch):
    monkeypatch.setattr(
        sys,
        "argv",
        ["tmuxdeck-bridge", "--url", "ws://host:8000/ws/bridge", "--token", "abc123"],
    )
    cfg = parse_config()
    assert cfg.url == "ws://host:8000/ws/bridge"
    assert cfg.token == "abc123"
    assert cfg.local is True


def test_parse_config_no_local(monkeypatch):
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "tmuxdeck-bridge",
            "--url", "ws://host:8000/ws/bridge",
            "--token", "abc123",
            "--no-local",
        ],
    )
    cfg = parse_config()
    assert cfg.local is False


def test_parse_config_all_options(monkeypatch):
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "tmuxdeck-bridge",
            "--url", "ws://host:8000/ws/bridge",
            "--token", "abc123",
            "--name", "prod-server",
            "--host-tmux-socket", "/tmp/tmux/default",
            "--docker-socket", "/var/run/docker.sock",
            "--docker-label", "env=prod",
            "--report-interval", "10",
        ],
    )
    cfg = parse_config()
    assert cfg.name == "prod-server"
    assert cfg.host_tmux_socket == "/tmp/tmux/default"
    assert cfg.docker_socket == "/var/run/docker.sock"
    assert cfg.docker_label == "env=prod"
    assert cfg.session_report_interval == 10.0


def test_parse_config_env_vars(monkeypatch):
    monkeypatch.setattr(
        sys,
        "argv",
        ["tmuxdeck-bridge", "--url", "ws://host:8000/ws/bridge", "--token", "abc123"],
    )
    monkeypatch.setenv("BRIDGE_NAME", "env-server")
    monkeypatch.setenv("HOST_TMUX_SOCKET", "/tmp/tmux-env/default")
    monkeypatch.setenv("DOCKER_SOCKET", "/run/docker.sock")
    monkeypatch.setenv("DOCKER_LABEL", "app=test")
    cfg = parse_config()
    assert cfg.name == "env-server"
    assert cfg.host_tmux_socket == "/tmp/tmux-env/default"
    assert cfg.docker_socket == "/run/docker.sock"
    assert cfg.docker_label == "app=test"
