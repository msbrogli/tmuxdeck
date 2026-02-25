<p align="center">
  <strong>TmuxDeck</strong><br>
  A web dashboard for managing tmux sessions across Docker containers
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#features">Features</a> &bull;
  <a href="#keyboard-shortcuts">Shortcuts</a> &bull;
  <a href="#configuration">Configuration</a> &bull;
  <a href="#contributing">Contributing</a>
</p>

---

Run AI coding agents, dev servers, and long-lived processes inside Docker containers. TmuxDeck gives you a single browser tab to manage all of them — create containers from templates, organize tmux sessions and windows, and interact through a real terminal powered by xterm.js.

```
+--sidebar--------------------------+--terminal area---------------------+
| TmuxDeck                [+] [<<] |                                    |
|                                   |  $ claude --model opus             |
| Host                     host     |  Analyzing codebase...             |
|   > main                          |  Found 12 files matching query     |
|     0: bash                       |                                    |
|                                   |                                    |
| > my-project (running)       [:]  |                                    |
|   > claude        <- active       |                                    |
|     0: claude-code *         [1]  |                                    |
|     1: shell                 [2]  |                                    |
|   > backend                       |                                    |
|     0: server                     |                                    |
|   [+ New Session]                 |                                    |
|                                   |                                    |
| > old-project (stopped)     [:]   |                                    |
|                                   |                                    |
| Templates                         |                                    |
| Settings                          |                                    |
+-----------------------------------+------------------------------------+
```

## Why TmuxDeck?

If you run multiple Docker containers with tmux sessions inside them — for AI agents, development environments, build systems — you know the pain of `docker exec`-ing into each one and juggling terminal tabs. TmuxDeck replaces that workflow:

- **One browser tab** instead of a dozen terminal windows
- **Instant switching** between sessions with a connection pool (no reconnect delay)
- **Fuzzy search** across all containers, sessions, and windows (Ctrl+K)
- **Drag-and-drop** to reorder sessions and move windows between them
- **Create containers from Dockerfile templates** with one click
- **Host tmux too** — manage sessions on the host machine, not just containers

## Quick Start

### Docker Compose (recommended)

```bash
git clone https://github.com/msbrogli/tmuxdeck.git
cd tmuxdeck
cp .env.example .env
docker compose up
```

Open **http://localhost:3000**. The backend runs on port 8000 behind the nginx proxy.

The backend needs access to the Docker socket to manage containers. To also manage **host tmux sessions**, pass your UID:

```bash
HOST_UID=$(id -u) docker compose up
```

### Local Development

```bash
# Backend (Python 3.12 + uv)
cd backend
uv sync
DATA_DIR=./data TEMPLATES_DIR=../docker/templates \
  uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# Frontend (in another terminal)
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173** — Vite proxies `/api/*` and `/ws/*` to the backend automatically.

### Mock Mode (no backend needed)

Want to explore the UI without Docker or a running backend?

```bash
cd frontend
npm install
VITE_USE_MOCK=true npm run dev
```

This runs the full UI with simulated containers, sessions, and a mock terminal.

## Features

### Real Terminal in the Browser

Full xterm.js terminal with ANSI color support, clickable links, and native tmux keybindings — Ctrl-B works as expected. Copy with Ctrl+Shift+C, paste with Ctrl+Shift+V (Cmd+C/V on Mac). Paste or drag-and-drop images directly into the terminal.

### Terminal Connection Pool

TmuxDeck keeps up to 8 WebSocket connections alive in the background (configurable 1-32) with LRU eviction. Switching between sessions is instant — no reconnect, no redraw delay.

### Session Switcher (Ctrl+K)

Fuzzy search across every container, session, and window. Results are ranked by recency and match quality. Hover to preview, Enter to switch.

### Drag-and-Drop Organization

- Drag windows within a session to reorder (`tmux swap-window`)
- Drag windows onto another session to move them (`tmux move-window`)
- Drag session headers to reorder within a container (persisted in localStorage)

### Quick-Switch Digits

Assign Ctrl+1 through Ctrl+0 to any window. Digits follow their windows when you reorder. Ctrl+Alt+1-0 to assign or unassign.

### Container Lifecycle

Create containers from Dockerfile templates with real-time build log streaming. Start, stop, rename, or remove from the sidebar context menu. Double-click any name to rename inline.

### Dockerfile Template Editor

Create and edit Dockerfile templates with Monaco editor syntax highlighting. Each template can define default environment variables and volume mounts. Ships with two templates:

- **claude-worker** — Node 20 + Claude Code CLI, ready for AI agent workflows
- **basic-dev** — Ubuntu 24.04 + build tools for general development

### Host & Local Tmux

Not just Docker — TmuxDeck can manage tmux sessions on the host machine and on the machine running the backend. The special container IDs `host` and `local` appear in the sidebar alongside your Docker containers.

### PIN Authentication

Optional PIN-based authentication protects the dashboard. No user management overhead — set a PIN in Settings and sessions last 7 days.

### Notifications

Bell and activity flags from tmux show as icons in the sidebar. When a process finishes or needs attention, you see it without switching.

### Mouse Mode Detection

When tmux mouse mode is enabled (which breaks browser text selection), TmuxDeck shows a warning banner with a one-click button to disable it.

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+K` | Open session switcher (fuzzy search) |
| `Ctrl+H` | Show keyboard shortcuts |
| `Ctrl+1` - `Ctrl+0` | Jump to assigned window |
| `Ctrl+Alt+1` - `Ctrl+Alt+0` | Assign/unassign digit to current window |
| `Ctrl+Up` / `Ctrl+Down` | Previous / next window |
| `Esc` `Esc` | Deselect current session |

All tmux keybindings (Ctrl-B + w, Ctrl-B + c, etc.) pass through natively.

## Configuration

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DATA_DIR` | `/data` | Directory for settings and template data (JSON files) |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Docker socket path |
| `CONTAINER_NAME_PREFIX` | `tmuxdeck` | Prefix for managed container names |
| `TEMPLATES_DIR` | `/app/docker/templates` | Path to seed Dockerfile templates |
| `HOST_TMUX_SOCKET` | *(none)* | Host tmux socket for host session access |
| `TELEGRAM_BOT_TOKEN` | *(none)* | Telegram bot token for text interaction |
| `TELEGRAM_ALLOWED_USERS` | *(none)* | Comma-separated Telegram user IDs |

### Settings (via UI)

- **Default volume mounts** — pre-fill when creating containers (e.g. `~/.claude:/root/.claude`)
- **SSH key path** — auto-mount SSH keys into containers for private repo access
- **Terminal pool size** — how many background connections to keep alive (1-32)
- **Telegram bot** — token and allowed users for text-based session interaction

## Architecture

```
Browser (React + xterm.js)
    |
    |--- REST /api/v1/* ---> FastAPI backend
    |--- WS   /ws/*     ---> WebSocket terminal handler
                                |
                                |--- docker-py ---> Docker Engine
                                |--- docker exec ---> tmux inside containers
                                |--- tmux (local) ---> host/local sessions
```

### Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python 3.12, FastAPI, docker-py |
| Frontend | React 18, TypeScript, Vite, Tailwind CSS |
| Terminal | xterm.js (fit + web-links addons) |
| Template editor | Monaco Editor |
| Data fetching | TanStack Query |
| Package managers | uv (backend), npm (frontend) |
| Deployment | Docker Compose, nginx |

### Project Structure

```
tmuxdeck/
├── backend/                # Python 3.12 + FastAPI
│   ├── app/
│   │   ├── api/            # REST endpoints (auth, containers, sessions, templates, settings)
│   │   ├── ws/             # WebSocket terminal handler
│   │   ├── services/       # Docker manager, tmux manager
│   │   └── schemas/        # Pydantic request/response models
│   ├── tests/              # pytest test suite
│   └── pyproject.toml      # Dependencies (managed with uv)
│
├── frontend/               # React 18 + TypeScript + Vite
│   └── src/
│       ├── components/     # Sidebar, Terminal, SessionSwitcher, ContainerNode, ...
│       ├── hooks/          # Terminal pool, keyboard shortcuts
│       ├── pages/          # MainPage, TemplatesPage, SettingsPage
│       ├── mocks/          # Mock API for development without backend
│       └── api/            # API client
│
├── docker/
│   └── templates/          # Bundled Dockerfile templates
├── docker-compose.yml
└── .env.example
```

## API

### Containers

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/containers` | List all containers (Docker + host + local) |
| POST | `/api/v1/containers` | Create container from template |
| GET | `/api/v1/containers/{id}` | Get container details |
| PATCH | `/api/v1/containers/{id}` | Rename container |
| DELETE | `/api/v1/containers/{id}` | Remove container |
| POST | `/api/v1/containers/{id}/start` | Start container |
| POST | `/api/v1/containers/{id}/stop` | Stop container |

### Sessions & Windows

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/containers/{id}/sessions` | List tmux sessions |
| POST | `/api/v1/containers/{id}/sessions` | Create session |
| PATCH | `/api/v1/containers/{id}/sessions/{sid}` | Rename session |
| DELETE | `/api/v1/containers/{id}/sessions/{sid}` | Kill session |
| POST | `.../sessions/{sid}/windows` | Create window |
| POST | `.../sessions/{sid}/swap-windows` | Swap two windows |
| POST | `.../sessions/{sid}/move-window` | Move window to another session |

### Terminal (WebSocket)

Connect to `WS /ws/terminal/{container_id}/{session_name}/{window_index}` for an interactive terminal. Control messages: `RESIZE:cols:rows`, `SCROLL:up:N`, `SCROLL:down:N`, `SELECT_WINDOW:index`, `DISABLE_MOUSE:`.

### Templates & Settings

| Method | Path | Description |
|---|---|---|
| GET/POST | `/api/v1/templates` | List / create templates |
| GET/PUT/DELETE | `/api/v1/templates/{id}` | Read / update / delete template |
| GET/POST | `/api/v1/settings` | Get / update settings |

## Contributing

### Running Tests

```bash
# Backend
cd backend
uv run pytest

# Frontend
cd frontend
npm test
```

### Linting

```bash
# Backend
cd backend
uv run ruff check app
uv run ruff format --check app

# Frontend
cd frontend
npm run lint
```

### Building for Production

```bash
docker compose up --build
```

## License

MIT
