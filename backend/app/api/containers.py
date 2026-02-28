from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from .. import store
from ..config import config
from ..schemas import (
    ContainerListResponse,
    ContainerResponse,
    CreateContainerRequest,
    RenameContainerRequest,
    TmuxSessionResponse,
)
from ..services.docker_manager import DockerManager
from ..services.bridge_manager import BRIDGE_PREFIX, BridgeManager, is_bridge
from ..services.tmux_manager import (
    HOST_CONTAINER_ID,
    LOCAL_CONTAINER_ID,
    TmuxManager,
    _is_host,
    _is_local,
    _is_special,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/containers", tags=["containers"])

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent.parent.parent / "scripts"


def _read_script(name: str) -> bytes:
    """Read a script file from the scripts directory."""
    return (_SCRIPTS_DIR / name).read_bytes()


async def _inject_scripts(dm: "DockerManager", container_id: str) -> None:
    """Inject and run setup scripts into a newly started container."""
    # Inject both scripts first
    install_script = _read_script("tmuxdeck-install")
    await dm.put_file(container_id, "/usr/local/bin", "tmuxdeck-install", install_script)
    await dm.exec_command(container_id, ["chmod", "+x", "/usr/local/bin/tmuxdeck-install"])

    open_script = _read_script("tmuxdeck-open")
    await dm.put_file(container_id, "/usr/local/bin", "tmuxdeck-open", open_script)
    await dm.exec_command(container_id, ["chmod", "+x", "/usr/local/bin/tmuxdeck-open"])

    notify_script = _read_script("tmuxdeck-notify")
    await dm.put_file(container_id, "/usr/local/bin", "tmuxdeck-notify", notify_script)
    await dm.exec_command(container_id, ["chmod", "+x", "/usr/local/bin/tmuxdeck-notify"])

    for hook in ("tmuxdeck-hook-prompt", "tmuxdeck-hook-stop", "tmuxdeck-hook-notification"):
        script = _read_script(hook)
        await dm.put_file(container_id, "/usr/local/bin", hook, script)
        await dm.exec_command(container_id, ["chmod", "+x", f"/usr/local/bin/{hook}"])

    # Now run the install script (tmuxdeck-open is already in place)
    await dm.exec_command(container_id, ["sh", "/usr/local/bin/tmuxdeck-install"])


async def _build_local_container(tm: TmuxManager) -> ContainerResponse:
    """Build the synthetic local container entry."""
    sessions: list[dict] = []
    try:
        sessions = await tm.list_sessions(LOCAL_CONTAINER_ID)
    except Exception:
        logger.debug("Failed to list local tmux sessions")

    return ContainerResponse(
        id=LOCAL_CONTAINER_ID,
        name="local",
        display_name="Local",
        status="running",
        image="local",
        container_type="local",
        sessions=[TmuxSessionResponse(**s) for s in sessions],
        created_at=datetime.now(UTC).isoformat(),
    )


async def _build_host_container(tm: TmuxManager) -> ContainerResponse:
    """Build the synthetic host container entry."""
    sessions: list[dict] = []
    try:
        sessions = await tm.list_sessions(HOST_CONTAINER_ID)
    except Exception:
        logger.debug("Failed to list host tmux sessions")

    return ContainerResponse(
        id=HOST_CONTAINER_ID,
        name="localhost",
        display_name="Host",
        status="running",
        image="host",
        container_type="host",
        sessions=[TmuxSessionResponse(**s) for s in sessions],
        created_at=datetime.now(UTC).isoformat(),
    )


def _build_container_response(
    docker_info: dict, meta: dict | None, sessions: list[dict] | None = None
) -> ContainerResponse:
    display_name = docker_info["name"]
    template_id = None
    if meta:
        display_name = meta.get("displayName", docker_info["name"])
        template_id = meta.get("templateId")

    return ContainerResponse(
        id=docker_info["id"],
        name=docker_info["name"],
        display_name=display_name,
        status=docker_info["status"],
        image=docker_info["image"],
        container_type="docker",
        template_id=template_id,
        sessions=[TmuxSessionResponse(**s) for s in (sessions or [])],
        created_at=docker_info["created_at"],
    )


@router.get("", response_model=ContainerListResponse)
async def list_containers():
    tm = TmuxManager.get()

    # Local container is always first
    local = await _build_local_container(tm)
    results: list[ContainerResponse] = [local]

    # Host container only when socket is configured
    if config.host_tmux_socket:
        host = await _build_host_container(tm)
        results.append(host)

    # Bridge containers
    bm = BridgeManager.get()
    for conn in bm.list_bridges():
        sessions = [TmuxSessionResponse(**s) for s in conn.sessions]
        results.append(ContainerResponse(
            id=f"{BRIDGE_PREFIX}{conn.bridge_id}",
            name=conn.name,
            display_name=conn.name,
            status="running",
            image="bridge",
            container_type="bridge",
            sessions=sessions,
            created_at=datetime.now(UTC).isoformat(),
        ))

    # Docker containers (gracefully skip if Docker is unavailable)
    docker_error: str | None = None
    try:
        dm = DockerManager.get()
        docker_containers = await dm.list_containers()
    except Exception as exc:
        logger.warning("Docker unavailable, skipping Docker containers", exc_info=True)
        return ContainerListResponse(containers=results, docker_error=str(exc))

    metas = store.list_container_metas()
    meta_map = {m["dockerContainerId"]: m for m in metas}
    for dc in docker_containers:
        meta = meta_map.get(dc["full_id"]) or meta_map.get(dc["id"])

        sessions: list[dict] = []
        if dc["status"] == "running":
            try:
                sessions = await tm.list_sessions(dc["id"])
            except Exception:
                logger.debug("Failed to list sessions for %s", dc["id"])

        results.append(_build_container_response(dc, meta, sessions))

    return ContainerListResponse(containers=results, docker_error=docker_error)


@router.post("", response_model=ContainerResponse, status_code=201)
async def create_container(req: CreateContainerRequest):
    try:
        dm = DockerManager.get()
    except Exception as e:
        raise HTTPException(500, f"Docker is not available: {e}") from None
    tm = TmuxManager.get()

    # Look up template
    template = store.get_template(req.template_id)
    if not template:
        raise HTTPException(404, f"Template {req.template_id} not found")

    # Build image from template dockerfile
    image_tag = f"{template['name']}:latest"
    try:
        await dm.build_image(template["content"], image_tag)
    except Exception as e:
        raise HTTPException(500, f"Image build failed: {e}") from None

    # Merge volumes: settings defaults + SSH key + template defaults + request overrides
    settings = store.get_settings()
    volumes: list[str] = []

    def _add_volume(v: str) -> None:
        """Add a volume mount, expanding ~ in the host path and deduplicating."""
        parts = v.split(":", 1)
        parts[0] = os.path.expanduser(parts[0])
        expanded = ":".join(parts)
        if expanded not in volumes:
            volumes.append(expanded)

    for v in settings.get("defaultVolumeMounts", []):
        if v:
            _add_volume(v)

    if req.mount_ssh:
        ssh_key_path = settings.get("sshKeyPath", "")
        if ssh_key_path:
            ssh_dir = os.path.dirname(os.path.expanduser(ssh_key_path))
            if ssh_dir and os.path.isdir(ssh_dir):
                _add_volume(f"{ssh_dir}:/tmp/.host-ssh:ro")

    if req.mount_claude:
        claude_dir = os.path.expanduser("~/.claude")
        if os.path.isdir(claude_dir):
            _add_volume(f"{claude_dir}:/root/.claude")

    for v in template.get("defaultVolumes", []):
        _add_volume(v)

    for v in req.volumes:
        _add_volume(v)

    # Merge env
    env = dict(template.get("defaultEnv", {}))
    env.update(req.env)
    env.setdefault("TMUXDECK_URL", "http://host.docker.internal:8000")

    container_name = f"{store.config.container_name_prefix}-{req.name}"

    try:
        dc = await dm.create_container(
            image=image_tag,
            name=container_name,
            env=env,
            volumes=volumes,
        )
    except Exception as e:
        raise HTTPException(500, f"Container creation failed: {e}") from None

    # Start it
    try:
        await dm.start_container(dc["id"])
    except Exception as e:
        raise HTTPException(500, f"Failed to start container: {e}") from None

    # Inject setup scripts
    try:
        await _inject_scripts(dm, dc["id"])
    except Exception:
        logger.warning("Failed to inject scripts into %s", dc["id"], exc_info=True)

    # Refresh info after start
    try:
        dc = await dm.get_container(dc["id"])
    except Exception as e:
        raise HTTPException(500, f"Failed to refresh container info: {e}") from None

    # Save metadata
    meta = store.save_container_meta(
        dc["full_id"],
        {
            "displayName": req.name,
            "templateId": req.template_id,
        },
    )

    # Wait briefly for tmux to initialize, then ensure "main" session
    await asyncio.sleep(1)
    try:
        await tm.ensure_session(dc["id"], "main")
    except Exception:
        logger.debug("Could not ensure main session for %s", dc["id"])

    sessions = []
    with contextlib.suppress(Exception):
        sessions = await tm.list_sessions(dc["id"])

    return _build_container_response(dc, meta, sessions)


@router.post("/stream")
async def create_container_stream(req: CreateContainerRequest):
    """Create a container with real-time progress streaming via NDJSON."""

    def _line(obj: dict) -> str:
        return json.dumps(obj, default=str) + "\n"

    async def _generate():
        try:
            dm = DockerManager.get()
        except Exception as e:
            yield _line({"event": "error", "message": f"Docker is not available: {e}"})
            return
        tm = TmuxManager.get()

        # Look up template
        template = store.get_template(req.template_id)
        if not template:
            yield _line({"event": "error", "message": f"Template {req.template_id} not found"})
            return

        # --- Step 1: Build image ---
        image_tag = f"{template['name']}:latest"
        yield _line({"event": "step", "step": "building_image", "message": "Building image..."})

        try:
            queue, build_task = dm.build_image_streaming(template["content"], image_tag)

            # Stream build logs
            while True:
                line = await queue.get()
                if line is None:
                    break
                yield _line({"event": "log", "line": line})

            # Await task to catch errors
            await build_task
        except Exception as e:
            yield _line({"event": "error", "step": "building_image", "message": f"Build failed: {e}"})
            return

        # --- Step 2: Create container ---
        yield _line({"event": "step", "step": "creating_container", "message": "Creating container..."})

        # Merge volumes (same logic as existing endpoint)
        settings = store.get_settings()
        merged_volumes: list[str] = []

        def _add_volume(v: str) -> None:
            parts = v.split(":", 1)
            parts[0] = os.path.expanduser(parts[0])
            expanded = ":".join(parts)
            if expanded not in merged_volumes:
                merged_volumes.append(expanded)

        for v in settings.get("defaultVolumeMounts", []):
            if v:
                _add_volume(v)

        if req.mount_ssh:
            ssh_key_path = settings.get("sshKeyPath", "")
            if ssh_key_path:
                ssh_dir = os.path.dirname(os.path.expanduser(ssh_key_path))
                if ssh_dir and os.path.isdir(ssh_dir):
                    _add_volume(f"{ssh_dir}:/tmp/.host-ssh:ro")

        if req.mount_claude:
            claude_dir = os.path.expanduser("~/.claude")
            if os.path.isdir(claude_dir):
                _add_volume(f"{claude_dir}:/root/.claude")

        for v in template.get("defaultVolumes", []):
            _add_volume(v)

        for v in req.volumes:
            _add_volume(v)

        env = dict(template.get("defaultEnv", {}))
        env.update(req.env)
        env.setdefault("TMUXDECK_URL", "http://host.docker.internal:8000")

        container_name = f"{store.config.container_name_prefix}-{req.name}"

        try:
            dc = await dm.create_container(
                image=image_tag,
                name=container_name,
                env=env,
                volumes=merged_volumes,
            )
        except Exception as e:
            yield _line({"event": "error", "step": "creating_container", "message": f"Container creation failed: {e}"})
            return

        # --- Step 3: Start container ---
        yield _line({"event": "step", "step": "starting_container", "message": "Starting container..."})

        try:
            await dm.start_container(dc["id"])
        except Exception as e:
            yield _line({"event": "error", "step": "starting_container", "message": f"Failed to start container: {e}"})
            return

        # Inject setup scripts
        try:
            await _inject_scripts(dm, dc["id"])
        except Exception:
            logger.warning("Failed to inject scripts into %s", dc["id"], exc_info=True)

        # Refresh info after start
        try:
            dc = await dm.get_container(dc["id"])
        except Exception as e:
            yield _line({"event": "error", "step": "starting_container", "message": f"Failed to refresh container info: {e}"})
            return

        # Save metadata
        meta = store.save_container_meta(
            dc["full_id"],
            {
                "displayName": req.name,
                "templateId": req.template_id,
            },
        )

        # --- Step 4: Initialize tmux ---
        yield _line({"event": "step", "step": "initializing", "message": "Initializing tmux session..."})

        await asyncio.sleep(1)
        try:
            await tm.ensure_session(dc["id"], "main")
        except Exception:
            logger.debug("Could not ensure main session for %s", dc["id"])

        sessions = []
        with contextlib.suppress(Exception):
            sessions = await tm.list_sessions(dc["id"])

        # --- Complete ---
        container_resp = _build_container_response(dc, meta, sessions)
        yield _line({
            "event": "complete",
            "container": container_resp.model_dump(by_alias=True),
        })

    return StreamingResponse(
        _generate(),
        media_type="application/x-ndjson",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/{container_id}", response_model=ContainerResponse)
async def get_container(container_id: str):
    tm = TmuxManager.get()

    if _is_local(container_id):
        return await _build_local_container(tm)
    if _is_host(container_id):
        return await _build_host_container(tm)
    if is_bridge(container_id):
        bm = BridgeManager.get()
        conn = bm.get_bridge_for_container(container_id)
        if not conn:
            raise HTTPException(404, f"Bridge {container_id} not connected")
        sessions = [TmuxSessionResponse(**s) for s in conn.sessions]
        return ContainerResponse(
            id=container_id,
            name=conn.name,
            display_name=conn.name,
            status="running",
            image="bridge",
            container_type="bridge",
            sessions=sessions,
            created_at=datetime.now(UTC).isoformat(),
        )

    dm = DockerManager.get()

    try:
        dc = await dm.get_container(container_id)
    except Exception:
        raise HTTPException(404, f"Container {container_id} not found") from None

    meta = store.get_container_meta(dc["full_id"]) or store.get_container_meta(dc["id"])

    sessions: list[dict] = []
    if dc["status"] == "running":
        with contextlib.suppress(Exception):
            sessions = await tm.list_sessions(dc["id"])

    return _build_container_response(dc, meta, sessions)


@router.patch("/{container_id}", response_model=ContainerResponse)
async def rename_container(container_id: str, req: RenameContainerRequest):
    if _is_special(container_id):
        raise HTTPException(400, "Cannot rename a special container")
    dm = DockerManager.get()
    tm = TmuxManager.get()

    try:
        dc = await dm.get_container(container_id)
    except Exception:
        raise HTTPException(404, f"Container {container_id} not found") from None

    new_docker_name = f"{store.config.container_name_prefix}-{req.display_name}"
    await dm.rename_container(dc["id"], new_docker_name)

    # Update metadata
    meta = store.get_container_meta(dc["full_id"]) or store.get_container_meta(dc["id"])
    if meta:
        store.update_container_meta(dc["full_id"], {"displayName": req.display_name})
        meta = store.get_container_meta(dc["full_id"])
    else:
        meta = store.save_container_meta(dc["full_id"], {"displayName": req.display_name})

    dc = await dm.get_container(dc["id"])

    sessions = []
    if dc["status"] == "running":
        with contextlib.suppress(Exception):
            sessions = await tm.list_sessions(dc["id"])

    return _build_container_response(dc, meta, sessions)


@router.post("/{container_id}/start", status_code=204)
async def start_container(container_id: str):
    if _is_special(container_id):
        raise HTTPException(400, "Cannot start/stop a special container")
    dm = DockerManager.get()
    try:
        await dm.start_container(container_id)
    except Exception as e:
        raise HTTPException(500, f"Failed to start container: {e}") from None


@router.post("/{container_id}/stop", status_code=204)
async def stop_container(container_id: str):
    if _is_special(container_id):
        raise HTTPException(400, "Cannot start/stop a special container")
    dm = DockerManager.get()
    try:
        await dm.stop_container(container_id)
    except Exception as e:
        raise HTTPException(500, f"Failed to stop container: {e}") from None


@router.delete("/{container_id}", status_code=204)
async def remove_container(container_id: str):
    if _is_special(container_id):
        raise HTTPException(400, "Cannot remove a special container")
    dm = DockerManager.get()

    # Get full ID before removing
    try:
        dc = await dm.get_container(container_id)
        full_id = dc["full_id"]
    except Exception:
        full_id = container_id

    try:
        await dm.remove_container(container_id)
    except Exception as e:
        raise HTTPException(500, f"Failed to remove container: {e}") from None

    store.delete_container_meta(full_id)
