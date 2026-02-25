from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class CamelModel(BaseModel):
    """Base model with camelCase aliases matching frontend TypeScript types."""

    model_config = ConfigDict(
        populate_by_name=True,
        alias_generator=lambda s: "".join(
            w if i == 0 else w.capitalize() for i, w in enumerate(s.split("_"))
        ),
        from_attributes=True,
    )


# --- Tmux Window / Session ---


class TmuxWindowResponse(CamelModel):
    index: int
    name: str
    active: bool
    panes: int
    bell: bool
    activity: bool


class TmuxSessionResponse(CamelModel):
    id: str
    name: str
    windows: list[TmuxWindowResponse]
    created: str
    attached: bool
    summary: str | None = None


class CreateSessionRequest(CamelModel):
    name: str


class RenameSessionRequest(CamelModel):
    name: str


class CreateWindowRequest(CamelModel):
    name: str | None = None


class SwapWindowsRequest(CamelModel):
    index1: int
    index2: int


class MoveWindowRequest(CamelModel):
    window_index: int
    target_session_id: str


# --- Container ---


class ContainerResponse(CamelModel):
    id: str
    name: str
    display_name: str
    status: str
    image: str
    is_host: bool | None = None
    is_local: bool | None = None
    template_id: str | None = None
    sessions: list[TmuxSessionResponse]
    created_at: str


class CreateContainerRequest(CamelModel):
    template_id: str
    name: str
    env: dict[str, str] = {}
    volumes: list[str] = []
    mount_ssh: bool = True
    mount_claude: bool = True


class RenameContainerRequest(CamelModel):
    display_name: str


# --- Template ---


class TemplateResponse(CamelModel):
    id: str
    name: str
    type: str
    content: str
    build_args: dict[str, str]
    default_volumes: list[str]
    default_env: dict[str, str]
    created_at: str
    updated_at: str


class CreateTemplateRequest(CamelModel):
    name: str
    type: str = "dockerfile"
    content: str = ""
    build_args: dict[str, str] = {}
    default_volumes: list[str] = []
    default_env: dict[str, str] = {}


class UpdateTemplateRequest(CamelModel):
    name: str | None = None
    type: str | None = None
    content: str | None = None
    build_args: dict[str, str] | None = None
    default_volumes: list[str] | None = None
    default_env: dict[str, str] | None = None


# --- Settings ---


class SettingsResponse(CamelModel):
    telegram_bot_token: str
    telegram_allowed_users: list[str]
    default_volume_mounts: list[str]
    ssh_key_path: str


class UpdateSettingsRequest(CamelModel):
    telegram_bot_token: str | None = None
    telegram_allowed_users: list[str] | None = None
    default_volume_mounts: list[str] | None = None
    ssh_key_path: str | None = None
