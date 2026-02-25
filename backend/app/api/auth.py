"""Auth API endpoints for PIN-based authentication."""

from __future__ import annotations

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, Field

from .. import auth

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])

SESSION_COOKIE = "session"
COOKIE_MAX_AGE = auth.SESSION_MAX_AGE


class PinBody(BaseModel):
    pin: str = Field(..., min_length=4, max_length=4, pattern=r"^\d{4}$")


class ChangePinBody(BaseModel):
    current_pin: str = Field(..., alias="currentPin", min_length=4, max_length=4, pattern=r"^\d{4}$")
    new_pin: str = Field(..., alias="newPin", min_length=4, max_length=4, pattern=r"^\d{4}$")



def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        httponly=True,
        samesite="lax",
        secure=False,
        max_age=COOKIE_MAX_AGE,
        path="/",
    )


def _is_authenticated(request: Request) -> bool:
    token = request.cookies.get(SESSION_COOKIE)
    return token is not None and auth.validate_session(token)


@router.get("/status")
async def auth_status(request: Request):
    return {
        "authenticated": _is_authenticated(request),
        "pinSet": auth.is_pin_set(),
    }


@router.post("/setup")
async def auth_setup(body: PinBody, response: Response):
    if auth.is_pin_set():
        return Response(
            content='{"detail":"PIN already configured"}',
            status_code=400,
            media_type="application/json",
        )
    pin_hash = auth.hash_pin(body.pin)
    auth.set_pin_hash(pin_hash)
    token = auth.create_session()
    _set_session_cookie(response, token)
    return {"ok": True}


@router.post("/login")
async def auth_login(body: PinBody, response: Response):
    stored = auth.get_pin_hash()
    if stored is None:
        return Response(
            content='{"detail":"No PIN configured"}',
            status_code=400,
            media_type="application/json",
        )
    if not auth.verify_pin(body.pin, stored):
        return Response(
            content='{"detail":"Invalid PIN"}',
            status_code=401,
            media_type="application/json",
        )
    token = auth.create_session()
    _set_session_cookie(response, token)
    return {"ok": True}


@router.post("/logout")
async def auth_logout(request: Request, response: Response):
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        auth.destroy_session(token)
    response.delete_cookie(key=SESSION_COOKIE, path="/")
    return {"ok": True}


@router.post("/change-pin")
async def auth_change_pin(request: Request, body: ChangePinBody, response: Response):
    # Must be authenticated
    if not _is_authenticated(request):
        return Response(
            content='{"detail":"Not authenticated"}',
            status_code=401,
            media_type="application/json",
        )
    stored = auth.get_pin_hash()
    if stored is None or not auth.verify_pin(body.current_pin, stored):
        return Response(
            content='{"detail":"Current PIN is incorrect"}',
            status_code=401,
            media_type="application/json",
        )
    new_hash = auth.hash_pin(body.new_pin)
    auth.set_pin_hash(new_hash)
    # Issue a fresh session
    old_token = request.cookies.get(SESSION_COOKIE)
    if old_token:
        auth.destroy_session(old_token)
    token = auth.create_session()
    _set_session_cookie(response, token)
    return {"ok": True}
