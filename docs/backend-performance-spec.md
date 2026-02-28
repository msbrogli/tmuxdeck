# Backend Performance Optimization Spec

## Problem

The TmuxDeck backend exhibits noticeable latency during normal usage — terminal sessions feel sluggish, sidebar updates lag, and concurrent usage degrades quickly. This document captures the root causes identified through code analysis and proposes fixes.

## Root Causes

### Critical

#### 1. Single Uvicorn Worker Process

**File:** `backend/Dockerfile` (CMD line)

Uvicorn runs with the default 1 worker. All HTTP requests, WebSocket connections, and background tasks share a single Python process and event loop. Any blocking call stalls everything.

**Fix:** Add `--workers 4` (or `$(nproc)`) to the uvicorn command.

#### 2. 1-Second Polling Loop Per Terminal Session

**Files:** `backend/app/ws/terminal.py` (~lines 400-453, 803-846)

Every open terminal spawns an `asyncio` task that runs `tmux list-windows` + `tmux list-panes` every 1 second via subprocess. With N open terminals, this creates N tmux command executions per second, all competing for the thread pool.

```python
# Current: hard-coded 1s poll per connection
while True:
    await asyncio.sleep(1)
    windows = await tm.list_windows(container_id, session_name)
    # ... compare, serialize, send over WS
```

**Fix (short-term):** Increase poll interval to 3-5 seconds with jitter to avoid thundering herd.

**Fix (long-term):** Replace polling with tmux event hooks (`tmux set-hook -g window-renamed ...`) that push updates to the backend via a socket or signal.

#### 3. Docker-py Blocking I/O Wrapped in Threads

**File:** `backend/app/services/docker_manager.py`

Every Docker API call (list, create, start, stop, exec) uses the synchronous `docker-py` library, wrapped in `asyncio.to_thread()`. The default thread pool executor has limited workers (CPU count), so under concurrency these calls queue up.

```python
# Current: every call goes through the thread pool
async def list_containers(self):
    def _list():
        return self._client.containers.list(all=True, ...)
    return await asyncio.to_thread(_list)
```

**Fix (short-term):** Set an explicit `ThreadPoolExecutor(max_workers=16)` as the default executor.

**Fix (long-term):** Replace `docker-py` with `aiodocker` for truly async Docker API calls with no thread pool overhead.

### High

#### 4. N+1 Tmux Commands in `list_sessions()`

**File:** `backend/app/services/tmux_manager.py` (~line 145)

`list_sessions()` calls `list_windows()` for each session individually. With 10 sessions, that's 11 subprocess calls.

```python
# Current: 1 + N commands
sessions_output = await self._run_cmd(...)  # 1 command
for session in sessions:
    windows = await self.list_windows(container_id, name)  # N commands
```

**Fix:** Combine into a single tmux command that returns all sessions with their windows:
```bash
tmux list-windows -a -F '#{session_name}:#{window_index}:#{window_name}:#{window_active}:#{window_panes}'
```

#### 5. 4KB Terminal Buffer Size

**Files:** `backend/app/ws/terminal.py` (multiple locations)

Terminal socket reads use a fixed 4096-byte buffer. High-throughput scenarios (large command output, file transfers) are bottlenecked by small reads.

```python
# Current
data = await loop.run_in_executor(None, os.read, master_fd, 4096)
data = await loop.run_in_executor(None, raw_sock.recv, 4096)
```

**Fix:** Increase to 16384 or 32768 bytes.

### Medium

#### 6. Nginx WebSocket Proxy Buffering

**File:** `frontend/nginx.conf` (ws location block)

The WebSocket proxy location doesn't disable buffering. Nginx may buffer frames before forwarding, adding latency to every keystroke.

```nginx
# Current
location /ws/ {
    proxy_pass http://backend:8000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 86400;
}
```

**Fix:** Add buffering and timeout directives:
```nginx
location /ws/ {
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_pass http://backend:8000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 86400;
    proxy_send_timeout 86400;
}
```

#### 7. No Docker Socket Timeouts

**File:** `backend/app/services/docker_manager.py` (~line 198)

Sockets returned from `docker exec_start(socket=True)` have no timeout. If a container hangs, the connection leaks indefinitely.

**Fix:** Set `socket.settimeout()` on the raw socket after creation.

#### 8. No WebSocket Backpressure

**File:** `backend/app/ws/terminal.py`

If a WebSocket client is slow or stalled, the server continues reading from the PTY/docker socket and calling `websocket.send_bytes()`, which queues data in memory.

**Fix:** Track send queue depth; pause reading when the client falls behind. Resume when it catches up.

### Low

#### 9. Container List Has No Pagination

**File:** `backend/app/services/docker_manager.py` (~line 52)

`list_containers()` fetches all containers. At scale (100+), this becomes slow.

**Fix:** Add optional pagination or caching with short TTL.

#### 10. Synchronous File Store I/O

**File:** `backend/app/store.py`

Template and settings reads use synchronous `Path.read_text()` and `json.loads()`. Only impacts startup and settings changes, not the hot path.

**Fix:** Use `aiofiles` or keep as-is (low priority).

## Implementation Order

Suggested order based on impact-to-effort ratio:

| Phase | Items | Effort | Expected Impact |
|-------|-------|--------|-----------------|
| 1 - Quick wins | #1 (workers), #6 (nginx), #5 (buffer size) | ~15 min | Noticeable latency reduction |
| 2 - Polling fixes | #2 (poll interval + jitter), #4 (batch tmux) | ~1 hour | Major CPU reduction, faster sidebar |
| 3 - Threading | #3 (thread pool size), #7 (socket timeouts) | ~30 min | Better concurrency under load |
| 4 - Async migration | #3 long-term (aiodocker), #2 long-term (tmux hooks) | ~1-2 days | Architectural improvement |
| 5 - Resilience | #8 (backpressure), #9 (pagination) | ~2-3 hours | Stability at scale |

## Metrics to Track

To validate improvements, measure:

- **Terminal keystroke round-trip time** — time from keypress to character echo
- **Sidebar refresh latency** — time for `GET /api/v1/containers` + sessions to return
- **CPU usage at idle** — with N terminals open, baseline CPU from polling
- **WebSocket frame latency** — time from server send to client receive (nginx overhead)
- **Thread pool utilization** — active threads vs queued tasks
