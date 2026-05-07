"""Call lifecycle management."""

import asyncio
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any

from lain_voice.config import Settings, get_settings
from lain_voice.telegram.call_handler import CallHandler, CallSession, CallState, get_call_handler

logger = logging.getLogger(__name__)


class CallStatus(str, Enum):
    """Public call status for API responses."""

    PENDING = "pending"
    RINGING = "ringing"
    ACTIVE = "active"
    ENDING = "ending"
    ENDED = "ended"
    FAILED = "failed"


@dataclass
class CallInfo:
    """Public call information for API responses."""

    call_id: str
    user_id: int
    status: CallStatus
    reason: str | None = None
    started_at: datetime | None = None
    ended_at: datetime | None = None
    error: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


class CallManager:
    """Manages call lifecycle and coordinates with the conversation handler."""

    def __init__(
        self,
        call_handler: CallHandler | None = None,
        settings: Settings | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self._call_handler = call_handler
        self._calls: dict[str, CallInfo] = {}
        self._active_conversations: dict[str, asyncio.Task] = {}

    async def _get_call_handler(self) -> CallHandler:
        """Get or initialize the call handler."""
        if self._call_handler is None:
            self._call_handler = await get_call_handler()
        return self._call_handler

    def _map_state_to_status(self, state: CallState) -> CallStatus:
        """Map internal CallState to public CallStatus."""
        mapping = {
            CallState.IDLE: CallStatus.PENDING,
            CallState.INITIATING: CallStatus.PENDING,
            CallState.RINGING: CallStatus.RINGING,
            CallState.ACTIVE: CallStatus.ACTIVE,
            CallState.ENDING: CallStatus.ENDING,
            CallState.ENDED: CallStatus.ENDED,
            CallState.FAILED: CallStatus.FAILED,
        }
        return mapping.get(state, CallStatus.PENDING)

    async def initiate_call(
        self,
        user_id: int | str,
        reason: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> CallInfo:
        """Initiate a new call to a user."""
        call_handler = await self._get_call_handler()
        call_id = str(uuid.uuid4())

        # Resolve user ID if needed
        from lain_voice.telegram.client import get_telegram_client
        client = await get_telegram_client()
        numeric_user_id = await client.resolve_peer(user_id)

        # Create call info
        call_info = CallInfo(
            call_id=call_id,
            user_id=numeric_user_id,
            status=CallStatus.PENDING,
            reason=reason,
            started_at=datetime.utcnow(),
            metadata=metadata or {},
        )
        self._calls[call_id] = call_info

        logger.info(f"Initiating call {call_id} to user {numeric_user_id}")

        try:
            # Initiate the call via pytgcalls
            session = await call_handler.initiate_call(
                user_id=numeric_user_id,
                call_id=call_id,
                reason=reason,
            )

            # Set up state change callback
            session.on_state_changed = lambda state: self._on_state_changed(call_id, state)

            # Update status based on session state
            call_info.status = self._map_state_to_status(session.state)

            # Start conversation handler when call becomes active
            asyncio.create_task(self._wait_for_active_and_start_conversation(call_id, session))

        except Exception as e:
            logger.error(f"Failed to initiate call {call_id}: {e}")
            call_info.status = CallStatus.FAILED
            call_info.error = str(e)
            call_info.ended_at = datetime.utcnow()
            raise

        return call_info

    async def _wait_for_active_and_start_conversation(
        self,
        call_id: str,
        session: CallSession,
    ) -> None:
        """Wait for call to become active, then start conversation loop."""
        timeout = 60  # 60 seconds to answer
        start = asyncio.get_event_loop().time()

        while session.state in (CallState.INITIATING, CallState.RINGING):
            if asyncio.get_event_loop().time() - start > timeout:
                logger.warning(f"Call {call_id} timed out waiting for answer")
                await self.end_call(call_id)
                return
            await asyncio.sleep(0.5)

        if session.state == CallState.ACTIVE:
            # Start conversation handler
            from lain_voice.call.conversation import ConversationHandler

            conversation = ConversationHandler(call_id, session, call_handler=self._call_handler)
            task = asyncio.create_task(conversation.run())
            self._active_conversations[call_id] = task

            # Update call info
            if call_id in self._calls:
                self._calls[call_id].status = CallStatus.ACTIVE

    def _on_state_changed(self, call_id: str, state: CallState) -> None:
        """Handle call state changes."""
        if call_id not in self._calls:
            return

        call_info = self._calls[call_id]
        call_info.status = self._map_state_to_status(state)

        if state in (CallState.ENDED, CallState.FAILED):
            call_info.ended_at = datetime.utcnow()

            # Cancel conversation task if running
            if call_id in self._active_conversations:
                self._active_conversations[call_id].cancel()
                del self._active_conversations[call_id]

    async def end_call(self, call_id: str) -> CallInfo | None:
        """End an active call."""
        if call_id not in self._calls:
            logger.warning(f"No call with ID {call_id}")
            return None

        call_info = self._calls[call_id]
        logger.info(f"Ending call {call_id}")

        # Cancel conversation
        if call_id in self._active_conversations:
            self._active_conversations[call_id].cancel()
            del self._active_conversations[call_id]

        # End the call
        call_handler = await self._get_call_handler()
        await call_handler.end_call(call_id)

        call_info.status = CallStatus.ENDED
        call_info.ended_at = datetime.utcnow()

        return call_info

    def get_call(self, call_id: str) -> CallInfo | None:
        """Get call information by ID."""
        return self._calls.get(call_id)

    def get_active_calls(self) -> list[CallInfo]:
        """Get all active calls."""
        return [
            call for call in self._calls.values()
            if call.status in (CallStatus.PENDING, CallStatus.RINGING, CallStatus.ACTIVE)
        ]

    async def cleanup_ended_calls(self, max_age_seconds: int = 3600) -> int:
        """Remove ended calls older than max_age_seconds."""
        now = datetime.utcnow()
        to_remove = []

        for call_id, call_info in self._calls.items():
            if call_info.ended_at is not None:
                age = (now - call_info.ended_at).total_seconds()
                if age > max_age_seconds:
                    to_remove.append(call_id)

        for call_id in to_remove:
            del self._calls[call_id]

        return len(to_remove)


# Global singleton
_call_manager: CallManager | None = None


async def get_call_manager() -> CallManager:
    """Get or create the global call manager instance."""
    global _call_manager
    if _call_manager is None:
        _call_manager = CallManager()
    return _call_manager
