"""pytgcalls integration for Telegram voice calls."""

import asyncio
import logging
import tempfile
import wave
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from pytgcalls import PyTgCalls
from pytgcalls.types import AudioQuality, MediaStream, RecordStream

from lain_voice.config import Settings, get_settings
from lain_voice.telegram.client import TelegramClient, get_telegram_client

logger = logging.getLogger(__name__)


class CallState(Enum):
    """Voice call state machine states."""

    IDLE = "idle"
    INITIATING = "initiating"
    RINGING = "ringing"
    ACTIVE = "active"
    ENDING = "ending"
    ENDED = "ended"
    FAILED = "failed"


@dataclass
class CallSession:
    """Represents an active voice call session."""

    call_id: str
    user_id: int
    state: CallState = CallState.IDLE
    reason: str | None = None
    error: str | None = None

    # Audio buffers
    incoming_audio_buffer: asyncio.Queue[bytes] = field(default_factory=lambda: asyncio.Queue(maxsize=100))
    outgoing_audio_buffer: asyncio.Queue[bytes] = field(default_factory=lambda: asyncio.Queue(maxsize=100))

    # Callbacks
    on_audio_received: Callable[[bytes], None] | None = None
    on_state_changed: Callable[[CallState], None] | None = None


class CallHandler:
    """Handler for Telegram voice calls using pytgcalls."""

    def __init__(
        self,
        telegram_client: TelegramClient | None = None,
        settings: Settings | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self._telegram_client = telegram_client
        self._pytgcalls: PyTgCalls | None = None
        self._sessions: dict[str, CallSession] = {}
        self._user_to_call: dict[int, str] = {}  # user_id -> call_id
        self._stream_end_events: dict[int, asyncio.Event] = {}  # chat_id -> event

    @property
    def pytgcalls(self) -> PyTgCalls:
        """Get the PyTgCalls instance."""
        if self._pytgcalls is None:
            raise RuntimeError("CallHandler not initialized. Call start() first.")
        return self._pytgcalls

    async def start(self) -> None:
        """Initialize and start the pytgcalls client."""
        if self._pytgcalls is not None:
            logger.warning("CallHandler already started")
            return

        if self._telegram_client is None:
            self._telegram_client = await get_telegram_client()

        logger.info("Initializing pytgcalls...")
        self._pytgcalls = PyTgCalls(self._telegram_client.client)

        # Register event handlers
        self._register_handlers()

        await self._pytgcalls.start()
        logger.info("pytgcalls started successfully")

    async def stop(self) -> None:
        """Stop the pytgcalls client and end all active calls."""
        if self._pytgcalls is None:
            return

        logger.info("Stopping pytgcalls...")

        # End all active calls
        for call_id in list(self._sessions.keys()):
            await self.end_call(call_id)

        self._pytgcalls = None

    def _register_handlers(self) -> None:
        """Register pytgcalls event handlers."""

        @self._pytgcalls.on_update()
        async def on_update(client: Any, update: Any) -> None:
            """Handle updates from pytgcalls."""
            update_type = type(update).__name__
            update_attrs = {k: v for k, v in vars(update).items() if not k.startswith("_")} if hasattr(update, "__dict__") else {}
            logger.info(f"PyTgCalls update: {update_type} {update_attrs}")

            if update_type == "StreamEnded":
                chat_id = getattr(update, "chat_id", None)
                if chat_id:
                    # Signal any waiters that playback finished
                    event = self._stream_end_events.pop(chat_id, None)
                    if event:
                        event.set()

                    # First stream end after ringing = call connected
                    if chat_id in self._user_to_call:
                        call_id = self._user_to_call[chat_id]
                        session = self._sessions.get(call_id)
                        if session and session.state == CallState.RINGING:
                            logger.info(f"Call {call_id}: stream ended while ringing → active")
                            await self._update_call_state(call_id, CallState.ACTIVE)

            elif update_type == "LeftCall":
                chat_id = getattr(update, "chat_id", None)
                if chat_id and chat_id in self._user_to_call:
                    call_id = self._user_to_call[chat_id]
                    await self._update_call_state(call_id, CallState.ENDED)

            elif update_type == "ChatUpdate":
                chat_id = getattr(update, "chat_id", None)
                status = getattr(update, "status", None)
                status_name = getattr(status, "name", "") if status else ""
                # DISCARDED_CALL fires when the remote user hangs up
                if "DISCARDED" in status_name and chat_id and chat_id in self._user_to_call:
                    call_id = self._user_to_call[chat_id]
                    logger.info(f"Call {call_id}: remote user hung up (ChatUpdate {status_name})")
                    await self._update_call_state(call_id, CallState.ENDED)

    async def initiate_call(
        self,
        user_id: int,
        call_id: str,
        reason: str | None = None,
    ) -> CallSession:
        """Initiate a voice call to a user."""
        if user_id in self._user_to_call:
            existing_call = self._sessions[self._user_to_call[user_id]]
            if existing_call.state in (CallState.ACTIVE, CallState.INITIATING, CallState.RINGING):
                raise ValueError(f"Already in call with user {user_id}")

        # Create session
        session = CallSession(
            call_id=call_id,
            user_id=user_id,
            state=CallState.INITIATING,
            reason=reason,
        )
        self._sessions[call_id] = session
        self._user_to_call[user_id] = call_id

        logger.info(f"Initiating call {call_id} to user {user_id}")

        try:
            # Create audio stream for the call
            # pytgcalls expects PCM 16-bit audio at 48kHz
            audio_source = self._create_audio_stream(session)

            # Start the private call
            # Note: py-tgcalls 2.x API
            await self.pytgcalls.play(
                user_id,
                MediaStream(
                    media_path=audio_source,
                    audio_parameters=AudioQuality.HIGH,  # 48kHz stereo
                ),
            )

            await self._update_call_state(call_id, CallState.RINGING)
            logger.info(f"Call {call_id} is now ringing")

        except Exception as e:
            logger.error(f"Failed to initiate call {call_id}: {e}")
            session.error = str(e)
            await self._update_call_state(call_id, CallState.FAILED)
            raise

        return session

    def _create_audio_stream(self, session: CallSession) -> str:
        """Create a silent audio file for pytgcalls to stream.

        pytgcalls requires a valid audio file path. We generate a short
        silent WAV so the call connects, then TTS audio can be fed later.
        """
        silence_dir = Path(tempfile.gettempdir()) / "lain_voice"
        silence_dir.mkdir(exist_ok=True)
        silence_path = silence_dir / f"silence_{session.call_id}.wav"

        # Generate 1 second of silence at 48kHz mono 16-bit
        # Short silence establishes the call. StreamEnded fires once
        # pytgcalls finishes playing it, triggering RINGING → ACTIVE.
        sample_rate = 48000
        duration_seconds = 1
        num_frames = sample_rate * duration_seconds
        silence_data = b'\x00\x00' * num_frames

        with wave.open(str(silence_path), 'wb') as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            wf.writeframes(silence_data)

        logger.debug(f"Created silence audio at {silence_path}")
        return str(silence_path)

    async def send_audio(self, call_id: str, audio_data: bytes) -> None:
        """Send audio data to an active call."""
        if call_id not in self._sessions:
            raise ValueError(f"No call with ID {call_id}")

        session = self._sessions[call_id]
        if session.state != CallState.ACTIVE:
            raise ValueError(f"Call {call_id} is not active (state: {session.state})")

        await session.outgoing_audio_buffer.put(audio_data)

    async def play_audio(self, call_id: str, wav_path: str) -> asyncio.Event:
        """Play a WAV file on the active call.

        Returns an asyncio.Event that is set when playback finishes.
        """
        session = self._sessions[call_id]
        event = asyncio.Event()
        self._stream_end_events[session.user_id] = event

        await self.pytgcalls.play(
            session.user_id,
            MediaStream(wav_path, audio_parameters=AudioQuality.HIGH),
        )
        return event

    async def start_recording(self, call_id: str, output_path: str) -> None:
        """Start capturing user audio to a file.

        Calling again with a new path stops the previous recording.
        """
        session = self._sessions[call_id]
        await self.pytgcalls.record(
            session.user_id,
            RecordStream(audio=output_path, audio_parameters=AudioQuality.HIGH),
        )

    async def end_call(self, call_id: str) -> None:
        """End an active call."""
        if call_id not in self._sessions:
            logger.warning(f"No call with ID {call_id} to end")
            return

        session = self._sessions[call_id]
        logger.info(f"Ending call {call_id}")

        await self._update_call_state(call_id, CallState.ENDING)

        try:
            await self.pytgcalls.leave_call(session.user_id)
        except Exception as e:
            logger.error(f"Error leaving call {call_id}: {e}")

        await self._update_call_state(call_id, CallState.ENDED)

        # Cleanup
        del self._user_to_call[session.user_id]
        del self._sessions[call_id]

    async def _update_call_state(self, call_id: str, state: CallState) -> None:
        """Update call state and notify listeners."""
        if call_id not in self._sessions:
            return

        session = self._sessions[call_id]
        old_state = session.state
        session.state = state

        logger.info(f"Call {call_id} state: {old_state.value} -> {state.value}")

        if session.on_state_changed:
            try:
                session.on_state_changed(state)
            except Exception as e:
                logger.error(f"Error in state change callback: {e}")

    def get_session(self, call_id: str) -> CallSession | None:
        """Get a call session by ID."""
        return self._sessions.get(call_id)

    def get_active_calls(self) -> list[CallSession]:
        """Get all active call sessions."""
        return [
            s for s in self._sessions.values()
            if s.state in (CallState.ACTIVE, CallState.RINGING, CallState.INITIATING)
        ]


# Global singleton instance
_call_handler: CallHandler | None = None


async def get_call_handler() -> CallHandler:
    """Get or create the global call handler instance."""
    global _call_handler
    if _call_handler is None:
        _call_handler = CallHandler()
        await _call_handler.start()
    return _call_handler


async def shutdown_call_handler() -> None:
    """Shutdown the global call handler."""
    global _call_handler
    if _call_handler is not None:
        await _call_handler.stop()
        _call_handler = None
