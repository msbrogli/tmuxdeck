from __future__ import annotations

import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app import store
from app.config import config
from app.main import app
from app.services.docker_manager import DockerManager
from app.services.tmux_manager import TmuxManager

FAKE_CONTAINER_CREATED = {
    "id": "abc123def4",
    "full_id": "abc123def456789000000000000000000000000000000000000000000000000",
    "name": "tmuxdeck-test-container",
    "status": "created",
    "image": "test-template:latest",
    "created_at": "2024-01-01T00:00:00Z",
}

FAKE_CONTAINER_RUNNING = {
    **FAKE_CONTAINER_CREATED,
    "status": "running",
}


@pytest.fixture(autouse=True)
def isolated_data_dir(tmp_path):
    """Point the store at a fresh temp directory for each test."""
    original = config.data_dir
    config.data_dir = str(tmp_path / "data")
    os.makedirs(config.data_path / "templates", exist_ok=True)
    os.makedirs(config.data_path / "containers", exist_ok=True)
    yield tmp_path / "data"
    config.data_dir = original


@pytest.fixture(autouse=True)
def reset_singletons():
    """Reset manager singletons between tests."""
    DockerManager._instance = None
    TmuxManager._instance = None
    yield
    DockerManager._instance = None
    TmuxManager._instance = None


@pytest.fixture
def mock_dm():
    """Mock DockerManager with default successful behaviour."""
    dm = MagicMock(spec=DockerManager)
    dm.build_image = AsyncMock(return_value="sha256:abc123")
    dm.create_container = AsyncMock(return_value=FAKE_CONTAINER_CREATED)
    dm.start_container = AsyncMock()
    dm.get_container = AsyncMock(return_value=FAKE_CONTAINER_RUNNING)
    dm.list_containers = AsyncMock(return_value=[])
    dm.stop_container = AsyncMock()
    dm.remove_container = AsyncMock()
    dm.rename_container = AsyncMock()
    return dm


@pytest.fixture
def mock_tm():
    """Mock TmuxManager with default successful behaviour."""
    tm = MagicMock(spec=TmuxManager)
    tm.list_sessions = AsyncMock(return_value=[])
    tm.ensure_session = AsyncMock()
    tm.create_session = AsyncMock()
    return tm


@pytest.fixture
def sample_template():
    """Create a template in the store and return its data."""
    return store.create_template({
        "name": "test-template",
        "type": "dockerfile",
        "content": "FROM ubuntu:22.04\nRUN apt-get update",
        "buildArgs": {},
        "defaultVolumes": ["/data:/data"],
        "defaultEnv": {"FOO": "bar"},
    })


@pytest.fixture
def client(mock_dm, mock_tm):
    """TestClient with mocked Docker and Tmux managers."""
    with (
        patch.object(DockerManager, "get", return_value=mock_dm),
        patch.object(TmuxManager, "get", return_value=mock_tm),
        TestClient(app, raise_server_exceptions=False) as c,
    ):
        yield c
