# TmuxDeck - Implementation Plan

## Context

A web-based tmux session manager backed by Docker. The UI is session-centric: you see all containers and their tmux sessions, click to connect via xterm.js, create new sessions, rename things easily, and manage container lifecycle. Containers are created from editable Dockerfile/compose templates. Telegram integration provides lightweight text interaction with Claude Code sessions.

**V1 scope**: Docker-only. All tmux sessions live inside Docker containers. The backend runs in Docker with the host's Docker socket mounted. Local host tmux and bridge support deferred to v2.

## Architecture

```
+-------------------+       +----------------------------+
|  React Frontend   |       |  Backend Container         |
|  (nginx + SPA)    |       |  FastAPI + docker-py       |
|                   |       |                            |
|  xterm.js --------+--WS--+--> docker exec tmux attach  |
|  Dashboard -------+--REST-+--> list containers/sessions |
+-------------------+       |                            |
                            |  /var/run/docker.sock      |
+-------------------+       |  mounted (controls host    |
|  Telegram Bot     +--HTTP-+--> docker engine)           |
+-------------------+       +----------------------------+
                                      |
                    docker exec / create / start / stop
                                      |
              +----------+----------+----------+
              |          |          |          |
           Container  Container  Container  Container
           (tmux      (tmux      (tmux)     (tmux
            sessions)  sessions)             sessions)
```

## Tech Stack

- **Backend**: Python 3.12 + FastAPI + SQLAlchemy + docker-py + python-telegram-bot
- **Frontend**: React 18 + TypeScript + Vite + xterm.js + Tailwind CSS + TanStack Query + Monaco Editor
- **Database**: SQLite

## UI Design

### Main View — Session-Centric Dashboard (`/`)

The primary view is a **sidebar + terminal** layout:

```
+--sidebar (collapsible)--------+--terminal area-----------------+
| [+ New Container]             |                                |
|                               |  (selected session's xterm.js  |
| ▼ my-project (running)    [⋮]|   fills this area)             |
|   ├─ claude          ← active|                                |
|   ├─ shell                    |                                |
|   └─ [+ New Session]         |                                |
|                               |                                |
| ▼ api-server (running)    [⋮]|                                |
|   ├─ claude                   |                                |
|   └─ [+ New Session]         |                                |
|                               |                                |
| ▶ old-project (stopped)   [⋮]|  "Select a session to connect" |
|                               |  (when nothing selected)       |
| ─────────────                 |                                |
| [⚙ Settings]                 |                                |
+-------------------------------+--------------------------------+
```

**Key behaviors:**
- **Sidebar**: tree of containers → sessions. Click a session to connect (terminal fills right panel)
- **Container name**: double-click to rename inline (calls `docker rename`)
- **Session name**: double-click to rename inline (calls `tmux rename-session`)
- **[⋮] menu** on container: Start, Stop, Remove, Rename
- **[+ New Session]**: creates empty shell tmux session in that container
- **[+ New Container]**: opens template picker → creates and starts container
- **C-b + w inside terminal**: native tmux window list (no web app interception — passthrough)
- **Stopped containers**: shown collapsed, grayed out, with option to start or remove

### Template Manager (`/settings/templates`)

Templates are raw **Dockerfile** or **docker-compose.yml** files edited in a **Monaco code editor**:

```
+--template list---+--editor (Monaco)----------------------------+
| [+ New Template] |  # Dockerfile                               |
|                  |  FROM node:20-bookworm                      |
| ● claude-worker  |                                             |
| ● python-dev     |  RUN apt-get update && apt-get install -y \ |
| ● node-project   |      git tmux openssh-server ...            |
|                  |                                             |
|                  |  RUN npm install -g @anthropic-ai/claude-code|
|                  |                                             |
|                  |  [Save] [Save As New] [Delete]              |
+------------------+---------------------------------------------+
```

Each template stores:
- Name
- Type: `dockerfile` or `compose`
- Content (raw file text)
- Build args / env vars (optional metadata)
- Volume mounts (e.g., `~/.claude` path)

When creating a container from a template, the flow is:
1. Pick template → preview/edit before launching
2. Set container name, env vars, volume mounts
3. Build image (if needed) → create + start container
4. Container appears in sidebar

### Settings Page (`/settings`)

- Telegram bot configuration (token, allowed users)
- Default volume mounts (e.g., `~/.claude` host path)
- SSH key path for private repos

## Project Structure

```
tmuxdeck/
├── docker-compose.yml
├── .env.example
├── backend/
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── app/
│   │   ├── main.py                 # FastAPI app, lifespan, CORS
│   │   ├── config.py               # pydantic-settings
│   │   ├── database.py             # SQLAlchemy engine + session
│   │   ├── models/
│   │   │   ├── template.py         # Container templates (Dockerfile/compose)
│   │   │   ├── container_meta.py   # Display names, custom metadata for containers
│   │   │   └── telegram_chat.py    # Telegram chat ↔ container links
│   │   ├── schemas/                # Pydantic request/response models
│   │   ├── api/
│   │   │   ├── templates.py        # CRUD templates
│   │   │   ├── containers.py       # List, create, start, stop, remove, rename
│   │   │   ├── sessions.py         # List, create, rename, kill tmux sessions
│   │   │   └── telegram.py         # Webhook endpoint
│   │   ├── ws/
│   │   │   └── terminal.py         # WebSocket ↔ docker exec tmux attach
│   │   └── services/
│   │       ├── docker_manager.py   # docker-py: container lifecycle + image builds
│   │       ├── tmux_manager.py     # docker exec: tmux operations
│   │       └── telegram_bot.py     # Telegram bot handlers
├── frontend/
│   ├── Dockerfile                  # Multi-stage: build + nginx
│   ├── nginx.conf                  # SPA routing + API/WS proxy
│   ├── package.json
│   ├── vite.config.ts
│   └── src/
│       ├── App.tsx                 # Router
│       ├── api/client.ts           # Fetch wrapper
│       ├── pages/
│       │   ├── MainPage.tsx        # Sidebar + terminal layout (primary view)
│       │   ├── TemplatesPage.tsx   # Template list + Monaco editor
│       │   └── SettingsPage.tsx    # Telegram, defaults
│       └── components/
│           ├── Terminal.tsx         # xterm.js + WebSocket wrapper
│           ├── Sidebar.tsx         # Container/session tree
│           ├── ContainerNode.tsx   # Collapsible container with sessions
│           ├── SessionItem.tsx     # Clickable session (inline rename)
│           ├── NewContainerDialog.tsx  # Template picker + config
│           ├── TemplateEditor.tsx  # Monaco editor wrapper
│           └── Layout.tsx          # App shell (sidebar + content)
└── docker/
    └── templates/                  # Default templates shipped with the app
        ├── claude-worker.dockerfile
        └── basic-dev.dockerfile
```

## Database Schema

**templates** — Dockerfile/compose templates:
- id, name, type (`dockerfile` | `compose`), content (text), build_args (JSON), default_volumes (JSON), default_env (JSON), created_at, updated_at

**container_meta** — display names and custom metadata for Docker containers:
- id, docker_container_id (string, unique), display_name (string), template_id (FK nullable), created_at
- Note: the actual container state comes from Docker; this table only stores UI metadata

**telegram_chats** — links Telegram chats to containers:
- id, chat_id (bigint), docker_container_id (string), tmux_session (string), is_active, created_at

## API Endpoints

### Containers

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/containers` | List all containers (merges Docker state + DB metadata) |
| POST | `/api/v1/containers` | Create from template (build image if needed, run) |
| GET | `/api/v1/containers/{id}` | Container details |
| PATCH | `/api/v1/containers/{id}` | Rename container (display_name + docker rename) |
| POST | `/api/v1/containers/{id}/start` | Start |
| POST | `/api/v1/containers/{id}/stop` | Stop |
| DELETE | `/api/v1/containers/{id}` | Remove |

### Tmux Sessions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/containers/{id}/sessions` | List tmux sessions in container |
| POST | `/api/v1/containers/{id}/sessions` | Create new session (empty shell) |
| PATCH | `/api/v1/containers/{id}/sessions/{name}` | Rename session (`tmux rename-session`) |
| DELETE | `/api/v1/containers/{id}/sessions/{name}` | Kill session |

### Terminal

| Path | Description |
|------|-------------|
| WS `/ws/terminal/{container_id}/{session_name}` | Attach to tmux session |

### Templates

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/api/v1/templates` | List / Create |
| GET/PUT/DELETE | `/api/v1/templates/{id}` | CRUD single template |

### Telegram

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/telegram/webhook` | Incoming updates |
| GET/POST/DELETE | `/api/v1/telegram/links` | List / Link / Unlink chats |

## Key Services

### docker_manager.py

```python
class DockerManager:
    def list_containers(self, all=False) -> list[dict]
    def create_container(self, image, name, env, volumes, ports) -> Container
    def build_image(self, dockerfile_content, tag, build_args) -> Image
    def start/stop/remove_container(self, container_id)
    def rename_container(self, container_id, new_name)
    def exec_in_container(self, container_id, cmd) -> ExecResult
    def exec_interactive(self, container_id, cmd) -> (exec_id, socket)
```

### tmux_manager.py

```python
class TmuxManager:
    def list_sessions(self, container_id) -> list[dict]
        # docker exec <cid> tmux list-sessions -F '#{session_name}:...'
    def create_session(self, container_id, name) -> None
        # docker exec <cid> tmux new-session -d -s <name>
    def rename_session(self, container_id, old_name, new_name) -> None
        # docker exec <cid> tmux rename-session -t <old> <new>
    def kill_session(self, container_id, name) -> None
    def attach_interactive(self, container_id, session_name) -> (exec_id, socket)
        # docker exec -it <cid> tmux attach -t <name>
```

### WebSocket terminal handler

1. Accept WebSocket at `/ws/terminal/{container_id}/{session_name}`
2. `exec_create(tty=True, stdin=True)` + `exec_start(socket=True)` for `tmux attach -t <name>`
3. Bidirectional pipe: browser bytes ↔ exec socket bytes
4. Handle `RESIZE:cols:rows` text messages → `exec_resize()`
5. All tmux keybindings (C-b + w, C-b + c, etc.) pass through natively

## Implementation Phases

### Phase 1: Full UI with Mock Data (frontend-only, no backend)

Build the complete frontend with a mock API layer so the UI can be iterated on before any backend work. All API calls go through a mock service that returns fake data and simulates state changes in memory.

**Mock data layer** (`frontend/src/mocks/`):
- `mockData.ts` — hardcoded containers, sessions, templates
- `mockApi.ts` — implements the same interface as the real API client but uses in-memory state
- Simulated delays (200-500ms) to feel realistic
- Mock terminal: xterm.js connected to a local echo or a simple shell emulator (shows fake Claude Code output)

**Build order:**
1. Scaffold React app (Vite + TypeScript + Tailwind + React Router + TanStack Query)
2. Create mock data layer with sample containers and sessions
3. Build Layout + Sidebar component (container/session tree)
4. Build ContainerNode (collapsible, [⋮] menu, inline rename)
5. Build SessionItem (clickable, inline rename)
6. Build Terminal component (xterm.js — mock mode echoes input or shows static content)
7. Build MainPage: sidebar + terminal area, session selection wires up terminal
8. Build NewContainerDialog (template picker, name input, config fields)
9. Build TemplatesPage with Monaco editor (templates stored in mock state)
10. Build SettingsPage (Telegram config, default mounts)
11. Polish: transitions, responsive layout, keyboard navigation, loading states, error states

**Phase 1 deliverable:** A fully navigable UI running on `npm run dev`. All interactions work with mock data. No Docker, no backend, no real terminal — but the UX is complete and can be tested and refined.

### Phase 2: Backend + Real Docker Integration
12. Set up FastAPI backend: main.py, config.py, database.py, models
13. Implement `docker_manager.py` and `tmux_manager.py`
14. Implement all REST endpoints (containers, sessions, templates)
15. Implement WebSocket terminal handler
16. Create default worker Dockerfile (`docker/templates/claude-worker.dockerfile`)
17. Swap frontend from mock API to real API client (same interface, different implementation)
18. End-to-end test: real containers, real tmux, real xterm.js terminal

### Phase 3: Telegram + Polish + Deployment
19. Implement Telegram bot + webhook
20. Write docker-compose.yml for full stack
21. Test full deployment from scratch

## Verification

### Phase 1 (mock mode)
1. `npm run dev` → UI opens at localhost:5173
2. Sidebar shows mock containers with sessions
3. Click a session → terminal area shows mock terminal
4. Click "+ New Container" → dialog opens → fill form → new container appears in sidebar
5. Click "+ New Session" → new session appears under container
6. Double-click container name → inline edit → rename works
7. Double-click session name → inline edit → rename works
8. Container [⋮] menu → Stop → container grays out, sessions hidden → Start → comes back
9. Container [⋮] menu → Remove → container disappears (with confirmation)
10. Templates page → see templates in list → edit in Monaco → Save / Save As New / Delete
11. Settings page → forms render and save to mock state

### Phase 2 (real backend)
12. `docker compose up` → backend + frontend start
13. Create container from template → real Docker container starts
14. Click session → real tmux session in xterm.js → interact with Claude Code
15. C-b + w → native tmux window list
16. SSH into container → `tmux attach` → same session

### Phase 3 (Telegram)
17. Configure bot token → `/link` → send message → get response
