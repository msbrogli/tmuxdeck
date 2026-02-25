"""Tests for PIN authentication (auth endpoints + middleware)."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app import auth, store
from app.main import app
from app.services.docker_manager import DockerManager
from app.services.tmux_manager import TmuxManager


@pytest.fixture(autouse=True)
def clear_sessions():
    """Clear in-memory sessions between tests."""
    auth._sessions.clear()
    yield
    auth._sessions.clear()


@pytest.fixture
def client():
    dm = MagicMock(spec=DockerManager)
    dm.list_containers = AsyncMock(return_value=[])
    tm = MagicMock(spec=TmuxManager)
    tm.list_sessions = AsyncMock(return_value=[])
    with (
        patch.object(DockerManager, "get", return_value=dm),
        patch.object(TmuxManager, "get", return_value=tm),
        TestClient(app, raise_server_exceptions=False) as c,
    ):
        yield c


def _setup_pin(client: TestClient, pin: str = "1234") -> None:
    """Helper: set up a PIN and clear the session cookie."""
    resp = client.post("/api/v1/auth/setup", json={"pin": pin})
    assert resp.status_code == 200


def _login(client: TestClient, pin: str = "1234") -> None:
    """Helper: log in and keep the session cookie."""
    resp = client.post("/api/v1/auth/login", json={"pin": pin})
    assert resp.status_code == 200


# ── Auth status ────────────────────────────────────────────────


class TestAuthStatus:
    def test_status_no_pin_set(self, client):
        resp = client.get("/api/v1/auth/status")
        assert resp.status_code == 200
        data = resp.json()
        assert data["pinSet"] is False
        assert data["authenticated"] is False

    def test_status_pin_set_not_authenticated(self, client):
        _setup_pin(client)
        # Use a fresh client without cookies
        client.cookies.clear()
        resp = client.get("/api/v1/auth/status")
        assert resp.status_code == 200
        data = resp.json()
        assert data["pinSet"] is True
        assert data["authenticated"] is False

    def test_status_authenticated(self, client):
        _setup_pin(client)
        # setup auto-logs in, so cookie is set
        resp = client.get("/api/v1/auth/status")
        assert resp.status_code == 200
        data = resp.json()
        assert data["pinSet"] is True
        assert data["authenticated"] is True


# ── PIN setup ──────────────────────────────────────────────────


class TestSetup:
    def test_setup_success(self, client):
        resp = client.post("/api/v1/auth/setup", json={"pin": "5678"})
        assert resp.status_code == 200
        assert resp.json()["ok"] is True
        assert "session" in resp.cookies

    def test_setup_rejects_second_call(self, client):
        _setup_pin(client)
        resp = client.post("/api/v1/auth/setup", json={"pin": "9999"})
        assert resp.status_code == 400

    def test_setup_rejects_non_numeric(self, client):
        resp = client.post("/api/v1/auth/setup", json={"pin": "abcd"})
        assert resp.status_code == 422

    def test_setup_rejects_short_pin(self, client):
        resp = client.post("/api/v1/auth/setup", json={"pin": "12"})
        assert resp.status_code == 422

    def test_setup_rejects_long_pin(self, client):
        resp = client.post("/api/v1/auth/setup", json={"pin": "123456"})
        assert resp.status_code == 422


# ── Login ──────────────────────────────────────────────────────


class TestLogin:
    def test_login_correct_pin(self, client):
        _setup_pin(client, "4321")
        client.cookies.clear()
        resp = client.post("/api/v1/auth/login", json={"pin": "4321"})
        assert resp.status_code == 200
        assert "session" in resp.cookies

    def test_login_wrong_pin(self, client):
        _setup_pin(client, "4321")
        client.cookies.clear()
        resp = client.post("/api/v1/auth/login", json={"pin": "0000"})
        assert resp.status_code == 401

    def test_login_no_pin_configured(self, client):
        resp = client.post("/api/v1/auth/login", json={"pin": "1234"})
        assert resp.status_code == 400


# ── Logout ─────────────────────────────────────────────────────


class TestLogout:
    def test_logout_clears_session(self, client):
        _setup_pin(client)
        # Verify authenticated
        assert client.get("/api/v1/auth/status").json()["authenticated"] is True
        # Logout
        resp = client.post("/api/v1/auth/logout")
        assert resp.status_code == 200
        # Session should now be invalid
        assert client.get("/api/v1/auth/status").json()["authenticated"] is False


# ── Change PIN ─────────────────────────────────────────────────


class TestChangePin:
    def test_change_pin_success(self, client):
        _setup_pin(client, "1111")
        resp = client.post("/api/v1/auth/change-pin", json={
            "currentPin": "1111",
            "newPin": "2222",
        })
        assert resp.status_code == 200
        # Old PIN should no longer work
        client.cookies.clear()
        assert client.post("/api/v1/auth/login", json={"pin": "1111"}).status_code == 401
        assert client.post("/api/v1/auth/login", json={"pin": "2222"}).status_code == 200

    def test_change_pin_wrong_current(self, client):
        _setup_pin(client, "1111")
        resp = client.post("/api/v1/auth/change-pin", json={
            "currentPin": "9999",
            "newPin": "2222",
        })
        assert resp.status_code == 401

    def test_change_pin_unauthenticated(self, client):
        _setup_pin(client)
        client.cookies.clear()
        resp = client.post("/api/v1/auth/change-pin", json={
            "currentPin": "1234",
            "newPin": "5678",
        })
        assert resp.status_code == 401


# ── Middleware ─────────────────────────────────────────────────


class TestMiddleware:
    def test_auth_endpoints_are_public(self, client):
        """Auth endpoints must be accessible without a session cookie."""
        _setup_pin(client)
        client.cookies.clear()
        # All auth endpoints should be reachable
        assert client.get("/api/v1/auth/status").status_code == 200
        assert client.post("/api/v1/auth/login", json={"pin": "0000"}).status_code == 401  # 401 from handler, not middleware
        assert client.post("/api/v1/auth/logout").status_code == 200

    def test_health_is_public(self, client):
        """Health endpoint must always be accessible."""
        _setup_pin(client)
        client.cookies.clear()
        assert client.get("/health").status_code == 200

    def test_protected_endpoint_blocked_without_session(self, client):
        """Non-auth API endpoints must return 401 when PIN is set but no session."""
        _setup_pin(client)
        client.cookies.clear()
        resp = client.get("/api/v1/containers")
        assert resp.status_code == 401

    def test_protected_endpoint_allowed_with_session(self, client):
        """Non-auth API endpoints must work with a valid session."""
        _setup_pin(client)
        # setup auto-logs in
        resp = client.get("/api/v1/containers")
        assert resp.status_code == 200

    def test_no_pin_means_no_auth_required(self, client):
        """When no PIN is configured, all endpoints work without auth."""
        resp = client.get("/api/v1/containers")
        assert resp.status_code == 200


# ── Core auth module ───────────────────────────────────────────


class TestAuthCore:
    def test_hash_and_verify(self):
        h = auth.hash_pin("9876")
        assert auth.verify_pin("9876", h) is True
        assert auth.verify_pin("0000", h) is False

    def test_session_lifecycle(self):
        token = auth.create_session()
        assert auth.validate_session(token) is True
        auth.destroy_session(token)
        assert auth.validate_session(token) is False

    def test_expired_session_rejected(self):
        import time
        token = auth.create_session()
        # Manually expire it
        auth._sessions[token] = time.time() - 1
        assert auth.validate_session(token) is False
