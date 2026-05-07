"""REST API routes for voice call service."""

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from lain_voice.call.manager import CallInfo, CallManager, CallStatus, get_call_manager

logger = logging.getLogger(__name__)

router = APIRouter()


class InitiateCallRequest(BaseModel):
    """Request body for initiating a call."""

    user_id: str = Field(..., description="Telegram user ID or username")
    reason: str | None = Field(None, description="Reason for the call")
    metadata: dict[str, Any] | None = Field(None, description="Additional metadata")


class CallResponse(BaseModel):
    """Response body for call operations."""

    call_id: str
    user_id: int
    status: str
    reason: str | None = None
    error: str | None = None


class HealthResponse(BaseModel):
    """Health check response."""

    status: str
    version: str
    telegram_connected: bool
    active_calls: int


def _call_info_to_response(call_info: CallInfo) -> CallResponse:
    """Convert CallInfo to API response."""
    return CallResponse(
        call_id=call_info.call_id,
        user_id=call_info.user_id,
        status=call_info.status.value,
        reason=call_info.reason,
        error=call_info.error,
    )


@router.post("/calls/initiate", response_model=CallResponse)
async def initiate_call(request: InitiateCallRequest) -> CallResponse:
    """Initiate a voice call to a Telegram user."""
    manager = await get_call_manager()

    try:
        call_info = await manager.initiate_call(
            user_id=request.user_id,
            reason=request.reason,
            metadata=request.metadata,
        )
        return _call_info_to_response(call_info)

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to initiate call: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to initiate call: {e}")


@router.post("/calls/{call_id}/hangup", response_model=CallResponse)
async def hangup_call(call_id: str) -> CallResponse:
    """End an active call."""
    manager = await get_call_manager()

    call_info = await manager.end_call(call_id)
    if call_info is None:
        raise HTTPException(status_code=404, detail=f"Call {call_id} not found")

    return _call_info_to_response(call_info)


@router.get("/calls/{call_id}/status", response_model=CallResponse)
async def get_call_status(call_id: str) -> CallResponse:
    """Get the status of a call."""
    manager = await get_call_manager()

    call_info = manager.get_call(call_id)
    if call_info is None:
        raise HTTPException(status_code=404, detail=f"Call {call_id} not found")

    return _call_info_to_response(call_info)


@router.get("/calls", response_model=list[CallResponse])
async def list_active_calls() -> list[CallResponse]:
    """List all active calls."""
    manager = await get_call_manager()
    return [_call_info_to_response(call) for call in manager.get_active_calls()]


@router.get("/health", response_model=HealthResponse)
async def health_check() -> HealthResponse:
    """Health check endpoint."""
    from lain_voice import __version__
    from lain_voice.telegram.client import _telegram_client

    manager = await get_call_manager()

    return HealthResponse(
        status="healthy",
        version=__version__,
        telegram_connected=_telegram_client is not None and _telegram_client._client is not None,
        active_calls=len(manager.get_active_calls()),
    )
