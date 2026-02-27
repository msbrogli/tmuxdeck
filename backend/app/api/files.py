from __future__ import annotations

import json
import logging
import mimetypes
import os
import subprocess
import xml.dom.minidom

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response

from ..services.docker_manager import DockerManager
from ..services.tmux_manager import _is_special

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/containers", tags=["files"])

MAX_FILE_SIZE = 20 * 1024 * 1024  # 20 MB

# MIME types we treat as renderable text (beyond text/*)
TEXT_MIME_TYPES = {
    "application/json",
    "application/xml",
    "application/javascript",
    "application/x-yaml",
    "application/toml",
    "application/x-shellscript",
    "application/x-python",
    "application/x-perl",
    "application/x-ruby",
    "application/x-httpd-php",
    "application/xhtml+xml",
}


def _mime_from_extension(path: str) -> str:
    """Guess MIME type from file extension. Fallback for when `file` is unavailable."""
    mime, _ = mimetypes.guess_type(path)
    return mime or "application/octet-stream"


def _detect_mime_local(path: str) -> str:
    """Detect MIME type using the `file` command on the host."""
    try:
        result = subprocess.run(
            ["file", "--mime-type", "-b", path],
            capture_output=True, text=True, timeout=5,
        )
        mime = result.stdout.strip()
        if mime and "/" in mime and mime != "application/octet-stream":
            return mime
    except Exception:
        pass
    return _mime_from_extension(path)


async def _detect_mime_container(container_id: str, path: str) -> str:
    """Detect MIME type using the `file` command inside a Docker container,
    falling back to extension-based detection."""
    dm = DockerManager.get()
    try:
        output = await dm.exec_command(container_id, ["file", "--mime-type", "-b", path])
        mime = output.strip()
        if mime and "/" in mime and mime != "application/octet-stream":
            return mime
    except Exception:
        pass
    return _mime_from_extension(path)


def _categorize_mime(mime: str) -> str | None:
    """Map a MIME type to a renderable category, or None if unsupported."""
    if mime.startswith("image/"):
        return "image"
    if mime == "application/pdf":
        return "pdf"
    if mime.startswith("text/") or mime in TEXT_MIME_TYPES:
        return "text"
    return None


def _pretty_print_text(data: bytes, path: str) -> bytes:
    """Auto-format JSON/XML content. Returns original data if formatting fails."""
    ext = os.path.splitext(path)[1].lower()
    if ext == ".json":
        try:
            parsed = json.loads(data)
            return json.dumps(parsed, indent=2, ensure_ascii=False).encode("utf-8")
        except Exception:
            pass
    elif ext == ".xml":
        try:
            dom = xml.dom.minidom.parseString(data)
            return dom.toprettyxml(indent="  ").encode("utf-8")
        except Exception:
            pass
    return data


@router.get("/{container_id}/file")
async def get_file(container_id: str, path: str = Query(..., description="Absolute path to file")):
    """Serve a file from inside a container or from the host filesystem."""

    # Detect MIME type
    if _is_special(container_id):
        if not os.path.isabs(path):
            raise HTTPException(status_code=400, detail="Path must be absolute")
        if not os.path.isfile(path):
            raise HTTPException(status_code=404, detail=f"File not found: {path}")
        mime = _detect_mime_local(path)
    else:
        mime = await _detect_mime_container(container_id, path)

    # Determine category
    category = _categorize_mime(mime)
    if category is None:
        raise HTTPException(
            status_code=415,
            detail=f"Cannot render this file type (detected: {mime})",
        )

    # Read file contents
    try:
        if _is_special(container_id):
            size = os.path.getsize(path)
            if size > MAX_FILE_SIZE:
                raise HTTPException(status_code=413, detail=f"File too large ({size} bytes). Max: {MAX_FILE_SIZE} bytes")
            with open(path, "rb") as f:
                data = f.read()
        else:
            dm = DockerManager.get()
            data = await dm.get_file(container_id, path)
            if len(data) > MAX_FILE_SIZE:
                raise HTTPException(status_code=413, detail=f"File too large ({len(data)} bytes). Max: {MAX_FILE_SIZE} bytes")
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"File not found: {path}")
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error reading file %s from %s", path, container_id)
        raise HTTPException(status_code=500, detail=str(e))

    # Pretty-print JSON/XML for text category
    if category == "text":
        data = _pretty_print_text(data, path)

    # Use a sensible content type for the response
    if category == "text":
        content_type = "text/plain; charset=utf-8"
    else:
        content_type = mime

    return Response(
        content=data,
        media_type=content_type,
        headers={
            "X-File-Category": category,
            "X-File-Mime": mime,
        },
    )
