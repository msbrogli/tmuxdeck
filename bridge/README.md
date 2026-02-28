# tmuxdeck-bridge

A lightweight agent that connects remote tmux sessions to a [TmuxDeck](https://github.com/your-org/tmuxdeck) backend via a reverse WebSocket connection.

The bridge runs on any machine with tmux and connects *back* to TmuxDeck, so it works through firewalls and NATs without needing SSH access from the backend to the remote server.

## Architecture

```
Remote Server                        TmuxDeck Backend                  Browser
┌──────────────┐   single WS conn   ┌────────────────┐   per-terminal  ┌──────────┐
│ tmuxdeck-    │ ← ─ ─ ─ ─ ─ ─ ─ → │  /ws/bridge     │ ← ─ ─ ─ ─ ─ → │ xterm.js │
│ bridge       │  multiplexed:      │                │  /ws/terminal/  │          │
│              │  JSON control +    │  BridgeManager │  bridge:id/...  │          │
│  tmux ←→ PTY │  binary I/O       │                │                 │          │
└──────────────┘                    └────────────────┘                 └──────────┘
```

One persistent WebSocket carries everything: JSON text frames for control messages and binary frames with a 2-byte channel header for multiplexed terminal I/O.

## Installation

```bash
# With uv (recommended)
uv pip install -e bridge/

# Or with pip
pip install -e bridge/
```

## Quick Start

1. **Create a bridge** on the TmuxDeck backend:

   ```bash
   curl -X POST http://localhost:8000/api/v1/bridges \
     -H 'Content-Type: application/json' \
     -d '{"name": "my-server"}'
   ```

   Save the `token` from the response — it's only shown once.

2. **Run the bridge** on the remote server:

   ```bash
   tmuxdeck-bridge \
     --url ws://tmuxdeck-host:8000/ws/bridge \
     --token <token> \
     --name my-server
   ```

   Or as a module:

   ```bash
   python -m tmuxdeck_bridge \
     --url ws://tmuxdeck-host:8000/ws/bridge \
     --token <token>
   ```

3. Sessions appear in the TmuxDeck sidebar under "my-server" and work like any other container.

## Tmux Discovery Modes

The bridge discovers tmux sessions from multiple sources, mirroring the TmuxDeck backend:

### Local (default)

Discovers tmux sessions running directly on the machine:

```bash
tmuxdeck-bridge --url ws://... --token ...
```

### Host Socket

Connects to a tmux server via a Unix socket (useful when tmux runs under a different user or in a specific namespace):

```bash
tmuxdeck-bridge --url ws://... --token ... \
  --host-tmux-socket /tmp/tmux-1000/default
```

> **Note:** Host socket mode requires the tmux socket to be directly accessible. When running the bridge inside **Docker Desktop** (macOS/Windows), Unix domain sockets mounted from the host are not connectable because the container runs inside a Linux VM. The bridge detects this at startup and disables the host source automatically. To use host tmux sockets on Docker Desktop, run the bridge natively instead of in a container.

### Docker Containers

Discovers tmux sessions inside Docker containers:

```bash
tmuxdeck-bridge --url ws://... --token ... \
  --docker-socket /var/run/docker.sock \
  --docker-label tmuxdeck=true
```

Requires the `docker` Python package (`uv pip install docker`).

### Combining Modes

All modes can be used simultaneously:

```bash
tmuxdeck-bridge --url ws://... --token ... \
  --host-tmux-socket /tmp/tmux-1000/default \
  --docker-socket /var/run/docker.sock
```

Use `--no-local` to skip local tmux discovery if you only want socket or Docker sessions.

## CLI Reference

```
usage: tmuxdeck-bridge [-h] --url URL --token TOKEN [--name NAME]
                       [--no-local] [--host-tmux-socket PATH]
                       [--docker-socket PATH] [--docker-label LABEL]
                       [--report-interval SECONDS]

Options:
  --url URL                WebSocket URL of TmuxDeck backend
  --token TOKEN            Bridge authentication token
  --name NAME              Display name (default: hostname)
  --no-local               Disable local tmux discovery
  --host-tmux-socket PATH  Path to host tmux socket
  --docker-socket PATH     Path to Docker socket
  --docker-label LABEL     Docker label filter for containers
  --report-interval SECS   Session report interval (default: 5)
```

### Environment Variables

| Variable            | Equivalent CLI Flag      |
|---------------------|--------------------------|
| `BRIDGE_NAME`       | `--name`                 |
| `HOST_TMUX_SOCKET`  | `--host-tmux-socket`     |
| `DOCKER_SOCKET`     | `--docker-socket`        |
| `DOCKER_LABEL`      | `--docker-label`         |

## Behavior

- **Auto-reconnect**: exponential backoff from 5s to 60s on connection loss
- **Auth failure**: permanent stop (invalid token won't retry)
- **Session reporting**: pushes session list to backend every 5s (configurable)
- **Multiplexed I/O**: up to 65k concurrent terminal sessions per bridge
- **Graceful shutdown**: `SIGINT`/`SIGTERM` cleanly disconnects

## Development

```bash
# Install dev dependencies
make install

# Run linter
make lint

# Run tests
make test

# Format code
make format
```
