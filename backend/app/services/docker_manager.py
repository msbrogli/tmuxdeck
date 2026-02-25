from __future__ import annotations

import asyncio
import io
import logging
import tarfile
from typing import TYPE_CHECKING, Any

import docker

from ..config import config

if TYPE_CHECKING:
    from docker.models.containers import Container

logger = logging.getLogger(__name__)


class DockerManager:
    """Singleton wrapper around docker-py. All calls are sync and must be
    dispatched via ``asyncio.to_thread``."""

    _instance: DockerManager | None = None

    def __init__(self) -> None:
        self._client = docker.DockerClient(base_url=f"unix://{config.docker_socket}")

    @classmethod
    def get(cls) -> DockerManager:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    # --- helpers --------------------------------------------------------

    def _prefix(self) -> str:
        return config.container_name_prefix

    # --- container lifecycle --------------------------------------------

    async def list_containers(self) -> list[dict[str, Any]]:
        def _list() -> list[dict[str, Any]]:
            containers = self._client.containers.list(
                all=True,
                filters={"name": self._prefix()},
            )
            result = []
            for c in containers:
                result.append(self._container_to_dict(c))
            return result

        return await asyncio.to_thread(_list)

    async def get_container(self, container_id: str) -> dict[str, Any]:
        def _get() -> dict[str, Any]:
            c = self._client.containers.get(container_id)
            return self._container_to_dict(c)

        return await asyncio.to_thread(_get)

    async def create_container(
        self,
        image: str,
        name: str,
        env: dict[str, str] | None = None,
        volumes: list[str] | None = None,
    ) -> dict[str, Any]:
        def _create() -> dict[str, Any]:
            # Build volume binds from string format "host:container"
            binds = volumes or []

            c = self._client.containers.create(
                image=image,
                name=name,
                environment=env or {},
                volumes=binds,
                detach=True,
                tty=True,
                stdin_open=True,
            )
            return self._container_to_dict(c)

        return await asyncio.to_thread(_create)

    async def start_container(self, container_id: str) -> None:
        def _start() -> None:
            c = self._client.containers.get(container_id)
            c.start()

        await asyncio.to_thread(_start)

    async def stop_container(self, container_id: str) -> None:
        def _stop() -> None:
            c = self._client.containers.get(container_id)
            c.stop(timeout=10)

        await asyncio.to_thread(_stop)

    async def remove_container(self, container_id: str) -> None:
        def _remove() -> None:
            c = self._client.containers.get(container_id)
            c.remove(force=True)

        await asyncio.to_thread(_remove)

    async def rename_container(self, container_id: str, new_name: str) -> None:
        def _rename() -> None:
            c = self._client.containers.get(container_id)
            c.rename(new_name)

        await asyncio.to_thread(_rename)

    # --- image management -----------------------------------------------

    async def build_image(self, dockerfile_content: str, tag: str) -> str:
        def _build() -> str:
            f = io.BytesIO(dockerfile_content.encode("utf-8"))
            image, build_logs = self._client.images.build(fileobj=f, tag=tag, rm=True, forcerm=True)
            return image.id

        return await asyncio.to_thread(_build)

    def build_image_streaming(
        self, dockerfile_content: str, tag: str
    ) -> tuple[asyncio.Queue[str | None], asyncio.Task[str]]:
        """Build an image and stream log lines via an asyncio.Queue.

        Returns ``(queue, task)`` where *queue* yields log line strings
        (``None`` = sentinel for end) and *task* resolves to the image ID
        or raises on failure.
        """
        queue: asyncio.Queue[str | None] = asyncio.Queue()
        loop = asyncio.get_running_loop()

        async def _run() -> str:
            image_id: str | None = None
            error_msg: str | None = None

            def _build() -> None:
                nonlocal image_id, error_msg
                f = io.BytesIO(dockerfile_content.encode("utf-8"))
                for chunk in self._client.api.build(
                    fileobj=f, tag=tag, rm=True, forcerm=True, decode=True
                ):
                    if "stream" in chunk:
                        line = chunk["stream"].rstrip("\n")
                        if line:
                            loop.call_soon_threadsafe(queue.put_nowait, line)
                    if "error" in chunk:
                        error_msg = chunk["error"]
                        return
                # Resolve image ID from the tag
                try:
                    img = self._client.images.get(tag)
                    image_id = img.id
                except Exception as exc:
                    error_msg = str(exc)

            await asyncio.to_thread(_build)

            # Signal end of log stream
            queue.put_nowait(None)

            if error_msg:
                raise RuntimeError(error_msg)
            if image_id is None:
                raise RuntimeError("Build produced no image")
            return image_id

        task = asyncio.create_task(_run())
        return queue, task

    # --- exec -----------------------------------------------------------

    async def exec_command(self, container_id: str, cmd: list[str] | str) -> str:
        def _exec() -> str:
            c = self._client.containers.get(container_id)
            exit_code, output = c.exec_run(cmd)
            return output.decode("utf-8", errors="replace") if output else ""

        return await asyncio.to_thread(_exec)

    async def exec_interactive(self, container_id: str, cmd: list[str] | str) -> Any:
        """Create an interactive exec instance and return the raw socket.

        Returns a tuple of (exec_id, socket) for bidirectional communication.
        """

        def _exec() -> tuple[str, Any]:
            c = self._client.containers.get(container_id)
            exec_instance = self._client.api.exec_create(
                c.id, cmd, stdin=True, tty=True, stdout=True, stderr=True,
                environment={"TERM": "xterm-256color"},
            )
            sock = self._client.api.exec_start(exec_instance["Id"], socket=True, tty=True)
            return exec_instance["Id"], sock

        return await asyncio.to_thread(_exec)

    async def exec_resize(self, exec_id: str, height: int, width: int) -> None:
        def _resize() -> None:
            self._client.api.exec_resize(exec_id, height=height, width=width)

        await asyncio.to_thread(_resize)

    # --- file transfer --------------------------------------------------

    async def put_file(self, container_id: str, dest_dir: str, filename: str, content: bytes) -> None:
        """Copy a file into a container using put_archive()."""

        def _put() -> None:
            c = self._client.containers.get(container_id)
            c.exec_run(["mkdir", "-p", dest_dir])
            tar_stream = io.BytesIO()
            with tarfile.open(fileobj=tar_stream, mode="w") as tar:
                info = tarfile.TarInfo(name=filename)
                info.size = len(content)
                tar.addfile(info, io.BytesIO(content))
            tar_stream.seek(0)
            c.put_archive(dest_dir, tar_stream)

        await asyncio.to_thread(_put)

    # --- helpers --------------------------------------------------------

    @staticmethod
    def _container_to_dict(c: Container) -> dict[str, Any]:
        status_map = {
            "running": "running",
            "created": "creating",
            "exited": "stopped",
            "dead": "error",
            "removing": "stopped",
            "paused": "stopped",
            "restarting": "running",
        }
        raw_status = c.status
        mapped_status = status_map.get(raw_status, "error")

        image_name = ""
        if c.image and c.image.tags:
            image_name = c.image.tags[0]
        elif c.image:
            image_name = c.image.short_id

        created = c.attrs.get("Created", "")

        return {
            "id": c.short_id,
            "full_id": c.id,
            "name": c.name,
            "status": mapped_status,
            "image": image_name,
            "created_at": created,
        }
