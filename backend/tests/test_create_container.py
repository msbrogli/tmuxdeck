"""Tests for POST /api/v1/containers (create container)."""

from __future__ import annotations

import os
from unittest.mock import AsyncMock, MagicMock, patch

import docker
from fastapi.testclient import TestClient

from app import store
from app.main import app
from app.services.docker_manager import DockerManager
from app.services.tmux_manager import TmuxManager

from .conftest import FAKE_CONTAINER_RUNNING


class TestCreateContainerSuccess:
    """Happy-path tests for container creation."""

    def test_returns_201(self, client, sample_template):
        resp = client.post("/api/v1/containers", json={
            "templateId": sample_template["id"],
            "name": "my-container",
        })

        assert resp.status_code == 201

    def test_response_contains_container_fields(self, client, sample_template):
        resp = client.post("/api/v1/containers", json={
            "templateId": sample_template["id"],
            "name": "my-container",
        })

        data = resp.json()
        assert data["id"] == FAKE_CONTAINER_RUNNING["id"]
        assert data["displayName"] == "my-container"
        assert data["status"] == "running"
        assert data["templateId"] == sample_template["id"]
        assert "sessions" in data

    def test_builds_image_with_template_content(self, client, mock_dm, sample_template):
        client.post("/api/v1/containers", json={
            "templateId": sample_template["id"],
            "name": "my-container",
        })

        mock_dm.build_image.assert_called_once()
        content, tag = mock_dm.build_image.call_args.args
        assert "FROM ubuntu:22.04" in content
        assert tag == "test-template:latest"

    def test_container_name_has_prefix(self, client, mock_dm, sample_template):
        client.post("/api/v1/containers", json={
            "templateId": sample_template["id"],
            "name": "my-container",
        })

        kwargs = mock_dm.create_container.call_args.kwargs
        assert kwargs["name"] == "tmuxdeck-my-container"

    def test_saves_metadata(self, client, sample_template):
        client.post("/api/v1/containers", json={
            "templateId": sample_template["id"],
            "name": "my-container",
        })

        meta = store.get_container_meta(FAKE_CONTAINER_RUNNING["full_id"])
        assert meta is not None
        assert meta["displayName"] == "my-container"
        assert meta["templateId"] == sample_template["id"]


class TestCreateContainerVolumesAndEnv:
    """Tests for volume and environment variable merging."""

    def test_merges_template_and_request_volumes(self, client, mock_dm, sample_template):
        client.post("/api/v1/containers", json={
            "templateId": sample_template["id"],
            "name": "c",
            "volumes": ["/host:/container"],
        })

        volumes = mock_dm.create_container.call_args.kwargs["volumes"]
        assert "/data:/data" in volumes        # from template
        assert "/host:/container" in volumes   # from request

    def test_deduplicates_volumes(self, client, mock_dm, sample_template):
        client.post("/api/v1/containers", json={
            "templateId": sample_template["id"],
            "name": "c",
            "volumes": ["/data:/data"],  # same as template default
        })

        volumes = mock_dm.create_container.call_args.kwargs["volumes"]
        assert volumes.count("/data:/data") == 1

    def test_includes_settings_default_volume_mounts(self, client, mock_dm, sample_template):
        store.update_settings({
            "defaultVolumeMounts": ["/projects:/projects", "/configs:/configs:ro"],
        })

        client.post("/api/v1/containers", json={
            "templateId": sample_template["id"],
            "name": "c",
        })

        volumes = mock_dm.create_container.call_args.kwargs["volumes"]
        assert "/projects:/projects" in volumes
        assert "/configs:/configs:ro" in volumes

    def test_mounts_ssh_dir_from_settings(self, client, mock_dm, sample_template, tmp_path):
        ssh_dir = tmp_path / ".ssh"
        ssh_dir.mkdir()
        (ssh_dir / "id_rsa").touch()
        store.update_settings({"sshKeyPath": str(ssh_dir / "id_rsa")})

        client.post("/api/v1/containers", json={
            "templateId": sample_template["id"],
            "name": "c",
        })

        volumes = mock_dm.create_container.call_args.kwargs["volumes"]
        assert f"{ssh_dir}:/root/.ssh:ro" in volumes

    def test_skips_ssh_mount_when_dir_missing(self, client, mock_dm, sample_template):
        store.update_settings({"sshKeyPath": "/nonexistent/.ssh/id_rsa"})

        client.post("/api/v1/containers", json={
            "templateId": sample_template["id"],
            "name": "c",
        })

        volumes = mock_dm.create_container.call_args.kwargs["volumes"]
        assert not any("/root/.ssh" in v for v in volumes)

    def test_expands_tilde_in_settings_volumes(self, client, mock_dm, sample_template):
        store.update_settings({
            "defaultVolumeMounts": ["~/.claude:/root/.claude:ro"],
        })

        client.post("/api/v1/containers", json={
            "templateId": sample_template["id"],
            "name": "c",
        })

        volumes = mock_dm.create_container.call_args.kwargs["volumes"]
        home = os.path.expanduser("~")
        assert f"{home}/.claude:/root/.claude:ro" in volumes

    def test_volume_merge_order_settings_then_template_then_request(
        self, client, mock_dm, sample_template,
    ):
        store.update_settings({"defaultVolumeMounts": ["/settings:/settings"]})

        client.post("/api/v1/containers", json={
            "templateId": sample_template["id"],
            "name": "c",
            "volumes": ["/req:/req"],
        })

        volumes = mock_dm.create_container.call_args.kwargs["volumes"]
        idx_settings = volumes.index("/settings:/settings")
        idx_template = volumes.index("/data:/data")
        idx_request = volumes.index("/req:/req")
        assert idx_settings < idx_template < idx_request

    def test_merges_env_with_request_overriding(self, client, mock_dm, sample_template):
        client.post("/api/v1/containers", json={
            "templateId": sample_template["id"],
            "name": "c",
            "env": {"BAZ": "qux", "FOO": "overridden"},
        })

        env = mock_dm.create_container.call_args.kwargs["env"]
        assert env["FOO"] == "overridden"  # request overrides template
        assert env["BAZ"] == "qux"         # request adds new

    def test_template_env_used_when_no_request_env(self, client, mock_dm, sample_template):
        client.post("/api/v1/containers", json={
            "templateId": sample_template["id"],
            "name": "c",
        })

        env = mock_dm.create_container.call_args.kwargs["env"]
        assert env == {"FOO": "bar"}


class TestCreateContainerErrors:
    """Tests for error responses."""

    def test_docker_unavailable_returns_500(self, mock_tm, sample_template):
        """Reproduces: DockerManager.get() fails due to socket permission error."""
        docker_exc = docker.errors.DockerException(
            "Error while fetching server API version: "
            "('Connection aborted.', PermissionError(13, 'Permission denied'))"
        )
        with (
            patch.object(DockerManager, "get", side_effect=docker_exc),
            patch.object(TmuxManager, "get", return_value=mock_tm),
            TestClient(app, raise_server_exceptions=False) as c,
        ):
            resp = c.post("/api/v1/containers", json={
                "templateId": sample_template["id"],
                "name": "my-container",
            })

        assert resp.status_code == 500
        assert "Docker is not available" in resp.json()["detail"]

    def test_template_not_found_returns_404(self, client):
        resp = client.post("/api/v1/containers", json={
            "templateId": "nonexistent-id",
            "name": "my-container",
        })

        assert resp.status_code == 404
        assert "not found" in resp.json()["detail"].lower()

    def test_image_build_failure_returns_500(self, client, mock_dm, sample_template):
        mock_dm.build_image = AsyncMock(
            side_effect=Exception("Build error: invalid FROM"),
        )

        resp = client.post("/api/v1/containers", json={
            "templateId": sample_template["id"],
            "name": "my-container",
        })

        assert resp.status_code == 500
        assert "Image build failed" in resp.json()["detail"]

    def test_container_create_failure_returns_500(self, client, mock_dm, sample_template):
        mock_dm.create_container = AsyncMock(
            side_effect=Exception("Conflict: name already in use"),
        )

        resp = client.post("/api/v1/containers", json={
            "templateId": sample_template["id"],
            "name": "my-container",
        })

        assert resp.status_code == 500
        assert "Container creation failed" in resp.json()["detail"]

    def test_container_start_failure_returns_500(self, client, mock_dm, sample_template):
        mock_dm.start_container = AsyncMock(
            side_effect=Exception("port already allocated"),
        )

        resp = client.post("/api/v1/containers", json={
            "templateId": sample_template["id"],
            "name": "my-container",
        })

        assert resp.status_code == 500
        assert "Failed to start container" in resp.json()["detail"]

    def test_container_refresh_failure_returns_500(self, client, mock_dm, sample_template):
        mock_dm.get_container = AsyncMock(
            side_effect=Exception("container disappeared"),
        )

        resp = client.post("/api/v1/containers", json={
            "templateId": sample_template["id"],
            "name": "my-container",
        })

        assert resp.status_code == 500
        assert "Failed to refresh container info" in resp.json()["detail"]

    def test_tmux_failure_does_not_fail_request(
        self, client, mock_dm, mock_tm, sample_template,
    ):
        mock_tm.ensure_session = AsyncMock(side_effect=Exception("tmux not found"))
        mock_tm.list_sessions = AsyncMock(side_effect=Exception("tmux not found"))

        resp = client.post("/api/v1/containers", json={
            "templateId": sample_template["id"],
            "name": "my-container",
        })

        assert resp.status_code == 201


class TestCreateContainerValidation:
    """Tests for request validation."""

    def test_missing_name_returns_422(self, client):
        resp = client.post("/api/v1/containers", json={
            "templateId": "some-id",
        })

        assert resp.status_code == 422

    def test_missing_template_id_returns_422(self, client):
        resp = client.post("/api/v1/containers", json={
            "name": "my-container",
        })

        assert resp.status_code == 422

    def test_empty_body_returns_422(self, client):
        resp = client.post("/api/v1/containers", json={})

        assert resp.status_code == 422


class TestCreateContainerMountFlags:
    """Tests for mount_ssh and mount_claude flags."""

    def test_mount_ssh_false_skips_ssh_volume(self, client, mock_dm, sample_template, tmp_path):
        ssh_dir = tmp_path / ".ssh"
        ssh_dir.mkdir()
        (ssh_dir / "id_rsa").touch()
        store.update_settings({"sshKeyPath": str(ssh_dir / "id_rsa")})

        resp = client.post("/api/v1/containers", json={
            "templateId": sample_template["id"],
            "name": "c",
            "mountSsh": False,
        })

        assert resp.status_code == 201
        volumes = mock_dm.create_container.call_args.kwargs["volumes"]
        assert not any("/root/.ssh" in v for v in volumes)

    def test_mount_claude_true_mounts_claude_dir(self, client, mock_dm, sample_template, tmp_path):
        claude_dir = tmp_path / ".claude"
        claude_dir.mkdir()

        with patch("app.api.containers.os.path.expanduser", return_value=str(claude_dir)):
            resp = client.post("/api/v1/containers", json={
                "templateId": sample_template["id"],
                "name": "c",
                "mountClaude": True,
            })

        assert resp.status_code == 201
        volumes = mock_dm.create_container.call_args.kwargs["volumes"]
        assert f"{claude_dir}:/root/.claude" in volumes

    def test_mount_claude_false_skips_claude_volume(self, client, mock_dm, sample_template):
        resp = client.post("/api/v1/containers", json={
            "templateId": sample_template["id"],
            "name": "c",
            "mountClaude": False,
        })

        assert resp.status_code == 201
        volumes = mock_dm.create_container.call_args.kwargs["volumes"]
        assert not any("/root/.claude" in v for v in volumes)

    def test_defaults_mount_both(self, client, mock_dm, sample_template, tmp_path):
        ssh_dir = tmp_path / ".ssh"
        ssh_dir.mkdir()
        (ssh_dir / "id_rsa").touch()
        store.update_settings({"sshKeyPath": str(ssh_dir / "id_rsa")})

        claude_dir = tmp_path / ".claude"
        claude_dir.mkdir()

        real_expanduser = os.path.expanduser

        def fake_expanduser(path):
            if path == "~/.claude":
                return str(claude_dir)
            return real_expanduser(path)

        with patch("app.api.containers.os.path.expanduser", side_effect=fake_expanduser):
            resp = client.post("/api/v1/containers", json={
                "templateId": sample_template["id"],
                "name": "c",
            })

        assert resp.status_code == 201
        volumes = mock_dm.create_container.call_args.kwargs["volumes"]
        assert any("/root/.ssh" in v for v in volumes)
        assert f"{claude_dir}:/root/.claude" in volumes
