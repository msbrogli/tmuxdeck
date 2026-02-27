"""HTTP authentication middleware for TmuxDeck."""

from __future__ import annotations

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from . import auth

# Paths that skip authentication
_PUBLIC_PREFIXES = ("/api/v1/auth/", "/health")

# Notification endpoints called from hook scripts (no auth)
_PUBLIC_EXACT_POST = (
    "/api/v1/notifications",
    "/api/v1/notifications/dismiss",
)


class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path

        # Skip public endpoints
        if any(path.startswith(p) for p in _PUBLIC_PREFIXES):
            return await call_next(request)

        # Skip static file serving (SPA entry point + non-API paths served by StaticFiles)
        if not path.startswith("/api/") and not path.startswith("/ws/"):
            return await call_next(request)

        # Skip notification POST endpoints (hook calls from containers)
        if request.method == "POST" and path in _PUBLIC_EXACT_POST:
            return await call_next(request)

        # Skip if no PIN is configured (first-time setup mode)
        if not auth.is_pin_set():
            return await call_next(request)

        # Check session cookie
        token = request.cookies.get("session")
        if not token or not auth.validate_session(token):
            return JSONResponse(
                {"detail": "Not authenticated"},
                status_code=401,
            )

        return await call_next(request)
