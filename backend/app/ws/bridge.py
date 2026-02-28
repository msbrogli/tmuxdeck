"""WebSocket endpoint for bridge agent connections.

One persistent WebSocket per bridge carries:
- JSON text frames for control messages
- Binary frames with 2-byte channel header for multiplexed terminal I/O
"""

from __future__ import annotations

import json
import logging
import struct

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .. import store
from ..services.bridge_manager import BridgeManager

logger = logging.getLogger(__name__)
router = APIRouter()


@router.websocket("/ws/bridge")
async def bridge_ws(websocket: WebSocket):
    await websocket.accept()

    bridge_id: str | None = None
    conn = None
    bm = BridgeManager.get()

    try:
        # Step 1: Wait for auth message
        raw = await websocket.receive_text()
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            await websocket.send_text(json.dumps({
                "type": "auth_error", "reason": "Invalid JSON",
            }))
            await websocket.close(code=4000)
            return

        if msg.get("type") != "auth":
            await websocket.send_text(json.dumps({
                "type": "auth_error", "reason": "Expected auth message",
            }))
            await websocket.close(code=4000)
            return

        token = msg.get("token", "")
        name = msg.get("name", "unnamed")

        bridge_config = store.get_bridge_by_token(token)
        if not bridge_config:
            await websocket.send_text(json.dumps({
                "type": "auth_error", "reason": "Invalid token",
            }))
            await websocket.close(code=4001)
            return

        bridge_id = bridge_config["id"]

        # Disconnect existing connection for this bridge if any
        existing = bm.get_bridge(bridge_id)
        if existing:
            logger.info("Replacing existing bridge connection: %s", bridge_id)
            await existing.close_all_terminals()
            bm.unregister(bridge_id)

        conn = bm.register(bridge_id, name, websocket)
        await websocket.send_text(json.dumps({
            "type": "auth_ok", "bridge_id": bridge_id,
        }))
        logger.info("Bridge authenticated: %s (%s)", bridge_id, name)

        # Step 2: Main message loop
        while True:
            message = await websocket.receive()

            if message.get("type") == "websocket.disconnect":
                break

            # Binary frame: route to user WebSocket
            if "bytes" in message and message["bytes"]:
                data = message["bytes"]
                if len(data) < 2:
                    continue
                channel_id = struct.unpack(">H", data[:2])[0]
                payload = data[2:]
                user_ws = conn.get_terminal_ws(channel_id)
                if user_ws:
                    try:
                        await user_ws.send_bytes(payload)
                    except Exception:
                        conn.unregister_terminal(channel_id)

            # Text frame: JSON control message
            elif "text" in message and message["text"]:
                try:
                    msg = json.loads(message["text"])
                except json.JSONDecodeError:
                    continue

                msg_type = msg.get("type", "")

                if msg_type == "sessions":
                    conn.sessions = msg.get("sessions", [])

                elif msg_type == "attach_ok":
                    req_id = msg.get("id")
                    if req_id:
                        conn.resolve_pending(req_id, msg)

                elif msg_type == "attach_error":
                    req_id = msg.get("id")
                    if req_id:
                        conn.resolve_pending(req_id, msg)

                elif msg_type == "detached":
                    channel_id = msg.get("channel_id", 0)
                    user_ws = conn.get_terminal_ws(channel_id)
                    if user_ws:
                        try:
                            await user_ws.close(code=1000, reason="Detached")
                        except Exception:
                            pass
                        conn.unregister_terminal(channel_id)

                elif msg_type == "cmd_result":
                    req_id = msg.get("id")
                    if req_id:
                        conn.resolve_pending(req_id, msg)

                elif msg_type == "pong":
                    pass  # keepalive response, nothing to do

                else:
                    logger.debug("Unknown bridge message type: %s", msg_type)

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.error("Bridge WebSocket error: %s", e)
    finally:
        if conn:
            await conn.close_all_terminals()
        if bridge_id:
            bm.unregister(bridge_id)
        try:
            await websocket.close()
        except Exception:
            pass
