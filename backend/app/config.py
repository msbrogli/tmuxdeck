from pathlib import Path

from pydantic_settings import BaseSettings


class AppConfig(BaseSettings):
    data_dir: str = "/data"
    docker_socket: str = "/var/run/docker.sock"
    container_name_prefix: str = "tmuxdeck"
    templates_dir: str = "/app/docker/templates"
    host_tmux_socket: str = ""  # e.g. "/tmp/tmux-host/default"

    model_config = {"env_file": ".env", "extra": "ignore"}

    @property
    def data_path(self) -> Path:
        return Path(self.data_dir)


config = AppConfig()
