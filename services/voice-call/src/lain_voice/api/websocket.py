"""WebSocket endpoints for real-time call events."""

import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from lain_voice.call.manager import CallInfo, CallStatus, get_call_manager

logger = logging.getLogger(__name__)

router = APIRouter()


class ConnectionManager:
    """Manages WebSocket connections for real-time events."""

    def __init__(self) -> None:
        self._connections: dict[str, set[WebSocket]] = {}  # call_id -> connections
        self._global_connections: set[WebSocket] = set()

    async def connect(self, websocket: WebSocket, call_id: str | None = None) -> None:
        """Accept a new WebSocket connection."""
        await websocket.accept()

        if call_id:
            if call_id not in self._connections:
                self._connections[call_id] = set()
            self._connections[call_id].add(websocket)
        else:
            self._global_connections.add(websocket)

        logger.info(f"WebSocket connected for call_id={call_id}")

    def disconnect(self, websocket: WebSocket, call_id: str | None = None) -> None:
        """Remove a WebSocket connection."""
        if call_id and call_id in self._connections:
            self._connections[call_id].discard(websocket)
            if not self._connections[call_id]:
                del self._connections[call_id]
        else:
            self._global_connections.discard(websocket)

        logger.info(f"WebSocket disconnected for call_id={call_id}")

    async def broadcast_call_event(
        self,
        call_id: str,
        event_type: str,
        data: dict[str, Any],
    ) -> None:
        """Broadcast an event to all connections interested in a call."""
        message = json.dumps({
            "type": event_type,
            "call_id": call_id,
            "data": data,
        })

        # Send to call-specific connections
        if call_id in self._connections:
            for connection in self._connections[call_id]:
                try:
                    await connection.send_text(message)
                except Exception as e:
                    logger.error(f"Failed to send to WebSocket: {e}")

        # Send to global connections
        for connection in self._global_connections:
            try:
                await connection.send_text(message)
            except Exception as e:
                logger.error(f"Failed to send to global WebSocket: {e}")

    async def broadcast_global_event(
        self,
        event_type: str,
        data: dict[str, Any],
    ) -> None:
        """Broadcast an event to all global connections."""
        message = json.dumps({
            "type": event_type,
            "data": data,
        })

        for connection in self._global_connections:
            try:
                await connection.send_text(message)
            except Exception as e:
                logger.error(f"Failed to send to global WebSocket: {e}")


# Global connection manager
connection_manager = ConnectionManager()


@router.websocket("/ws/calls")
async def websocket_all_calls(websocket: WebSocket) -> None:
    """WebSocket endpoint for all call events."""
    await connection_manager.connect(websocket)

    try:
        while True:
            # Keep connection alive, handle any incoming messages
            data = await websocket.receive_text()
            logger.debug(f"Received from client: {data}")

    except WebSocketDisconnect:
        connection_manager.disconnect(websocket)


@router.websocket("/ws/calls/{call_id}")
async def websocket_call(websocket: WebSocket, call_id: str) -> None:
    """WebSocket endpoint for specific call events."""
    manager = await get_call_manager()
    call_info = manager.get_call(call_id)

    if call_info is None:
        await websocket.close(code=4004, reason="Call not found")
        return

    await connection_manager.connect(websocket, call_id)

    try:
        # Send current state
        await websocket.send_json({
            "type": "call_state",
            "call_id": call_id,
            "data": {
                "status": call_info.status.value,
                "user_id": call_info.user_id,
            },
        })

        while True:
            data = await websocket.receive_text()
            logger.debug(f"Received from client for call {call_id}: {data}")

    except WebSocketDisconnect:
        connection_manager.disconnect(websocket, call_id)


async def emit_call_status_change(call_info: CallInfo) -> None:
    """Emit a call status change event."""
    await connection_manager.broadcast_call_event(
        call_id=call_info.call_id,
        event_type="status_changed",
        data={
            "status": call_info.status.value,
            "user_id": call_info.user_id,
            "error": call_info.error,
        },
    )


async def emit_transcript(call_id: str, speaker: str, text: str) -> None:
    """Emit a transcript event."""
    await connection_manager.broadcast_call_event(
        call_id=call_id,
        event_type="transcript",
        data={
            "speaker": speaker,
            "text": text,
        },
    )
