"""Voice conversation loop handler — turn-based."""

import asyncio
import logging
import shutil
import tempfile
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

import httpx

from lain_voice.audio.stt import SpeechToText
from lain_voice.audio.tts import TextToSpeech
from lain_voice.config import Settings, get_settings
from lain_voice.telegram.call_handler import CallSession, CallState

if TYPE_CHECKING:
    from lain_voice.telegram.call_handler import CallHandler

logger = logging.getLogger(__name__)


@dataclass
class ConversationTurn:
    """Represents a single turn in the conversation."""

    speaker: str  # "user" or "lain"
    text: str
    timestamp: float = 0.0


@dataclass
class ConversationState:
    """State of the voice conversation."""

    turns: list[ConversationTurn] = field(default_factory=list)


class ConversationHandler:
    """Handles the voice conversation loop for a call.

    Uses half-duplex turn-taking:
      1. Lain speaks (TTS → WAV → play on call → wait for stream end)
      2. User speaks (record to file → transcribe with Whisper)
      3. Agent thinks (POST /api/chat → get text response)
      4. Repeat
    """

    def __init__(
        self,
        call_id: str,
        session: CallSession,
        call_handler: "CallHandler",
        settings: Settings | None = None,
    ) -> None:
        self.call_id = call_id
        self.session = session
        self.call_handler = call_handler
        self.settings = settings or get_settings()

        self.stt = SpeechToText(settings)
        self.tts = TextToSpeech(settings)

        self.state = ConversationState()
        self._running = False
        self._http_client: httpx.AsyncClient | None = None
        self._temp_dir: Path | None = None
        self._rec_counter = 0

    def _temp_path(self, filename: str) -> str:
        """Get a path inside the temp directory."""
        assert self._temp_dir is not None
        return str(self._temp_dir / filename)

    def _write_temp_wav(self, pcm_data: bytes) -> str:
        """Write PCM audio data (48kHz 16-bit mono) to a temporary WAV file."""
        path = self._temp_path(f"tts_{self._rec_counter}.wav")
        with wave.open(path, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(48000)
            wf.writeframes(pcm_data)
        return path

    async def run(self) -> None:
        """Main conversation loop."""
        self._running = True
        self._temp_dir = Path(tempfile.mkdtemp(prefix="lain_conv_"))
        logger.info(f"Starting conversation for call {self.call_id} (temp: {self._temp_dir})")

        self._http_client = httpx.AsyncClient(timeout=30.0)

        try:
            # Send initial greeting from Lain
            await self._send_lain_greeting()

            # Main conversation loop
            await self._conversation_loop()

        except asyncio.CancelledError:
            logger.info(f"Conversation {self.call_id} cancelled")
        except Exception as e:
            logger.error(f"Conversation {self.call_id} error: {e}")
        finally:
            self._running = False
            if self._http_client:
                await self._http_client.aclose()
            if self._temp_dir and self._temp_dir.exists():
                shutil.rmtree(self._temp_dir, ignore_errors=True)
            logger.info(f"Conversation {self.call_id} ended")

    async def _send_lain_greeting(self) -> None:
        """Send Lain's initial greeting."""
        greeting = "hey... it's lain. you there?"

        if self.session.reason:
            greeting = f"hey... it's lain. i wanted to talk about {self.session.reason}... you there?"

        await self._speak(greeting)

    async def _conversation_loop(self) -> None:
        """Turn-based conversation: listen → think → speak → repeat.

        First listen uses a long duration (user may still be answering).
        Subsequent listens use shorter duration with silence detection.
        """
        empty_count = 0
        max_empty = 2
        first_turn = True

        while self._running and self.session.state == CallState.ACTIVE:
            try:
                # First turn: long listen (user needs time to answer the call)
                # Subsequent turns: shorter with silence detection
                duration = 15.0 if first_turn else 12.0
                transcript = await self._listen(max_duration=duration)
                first_turn = False

                if not transcript.strip():
                    empty_count += 1
                    if empty_count >= max_empty:
                        # Don't try to speak — play() on a dead call re-initiates
                        # a new call via pytgcalls. Just hang up silently.
                        logger.info(f"Call {self.call_id}: {max_empty} empty transcripts, ending call")
                        self._request_hangup()
                        return
                    logger.debug(f"Call {self.call_id}: empty transcript ({empty_count}/{max_empty})")
                    continue

                empty_count = 0
                logger.info(f"User said: {transcript}")

                self.state.turns.append(ConversationTurn(
                    speaker="user",
                    text=transcript,
                    timestamp=asyncio.get_event_loop().time(),
                ))

                response = await self._get_lain_response(transcript)
                if response:
                    await self._speak(response)

            except asyncio.CancelledError:
                raise
            except asyncio.TimeoutError:
                logger.info(f"Call {self.call_id} dropped: playback timed out")
                self._request_hangup()
                return
            except Exception as e:
                error_msg = str(e).lower()
                # These errors mean the call has dropped — stop immediately
                # to avoid pytgcalls re-initiating a new call
                if any(s in error_msg for s in ("busy", "timed out", "not in a call", "declined")):
                    logger.info(f"Call {self.call_id} dropped: {e}")
                    self._request_hangup()
                    return
                logger.error(f"Error in conversation loop: {e}")
                await asyncio.sleep(0.5)

    async def _listen(self, max_duration: float = 15.0) -> str:
        """Record user audio and transcribe it.

        Waits a minimum of 3s (ffmpeg needs time to start writing), then
        monitors file growth to detect end-of-speech and cut recording short.
        """
        recording_path = self._temp_path(f"rec_{self._rec_counter}.mp3")
        self._rec_counter += 1

        logger.debug(f"Starting recording → {recording_path}")
        await self.call_handler.start_recording(self.call_id, recording_path)

        rec_path = Path(recording_path)

        # Minimum 5s wait — ffmpeg needs time to start writing the MP3 file,
        # and the P2P call connection may still be establishing.
        await asyncio.sleep(5.0)

        if not rec_path.exists():
            logger.debug("Recording file not found after 5s — call may not be connected yet")
            return ""

        # Monitor file growth — stop recording when user stops talking
        last_size = rec_path.stat().st_size
        silence_checks = 0
        elapsed = 5.0

        while elapsed < max_duration:
            await asyncio.sleep(0.5)
            elapsed += 0.5

            try:
                current_size = rec_path.stat().st_size
            except OSError:
                return ""

            growth = current_size - last_size
            last_size = current_size

            # Low growth = silence. MP3 VBR: speech ~4-12KB/0.5s, silence <2KB/0.5s.
            if growth < 2000:
                silence_checks += 1
                if silence_checks >= 3:  # ~1.5s of silence
                    logger.debug(f"Silence detected at {elapsed:.1f}s, stopping recording")
                    break
            else:
                silence_checks = 0

        # Switch recording to a dummy file to finalize the previous one
        dummy_path = self._temp_path("dummy.mp3")
        await self.call_handler.start_recording(self.call_id, dummy_path)
        await asyncio.sleep(0.3)  # Let ffmpeg finalize

        logger.debug(f"Transcribing {recording_path} ({last_size} bytes, {elapsed:.1f}s)")
        transcript = ""
        try:
            transcript = await self.stt.transcribe_file(recording_path)
        except Exception as e:
            logger.error(f"STT failed: {e}")

        Path(recording_path).unlink(missing_ok=True)
        Path(dummy_path).unlink(missing_ok=True)

        return transcript

    async def _speak(self, text: str) -> None:
        """Have Lain speak via TTS → WAV → play on call."""
        if not text or not self._running or self.session.state != CallState.ACTIVE:
            return

        logger.info(f"Lain says: {text}")

        self.state.turns.append(ConversationTurn(
            speaker="lain",
            text=text,
            timestamp=asyncio.get_event_loop().time(),
        ))

        try:
            audio_data = await self.tts.synthesize(text)
            if not audio_data:
                return

            wav_path = self._write_temp_wav(audio_data)

            try:
                # Check call is still alive before playing — play() on a
                # dead P2P call re-initiates a new call to the user.
                if self.session.state != CallState.ACTIVE:
                    return
                event = await self.call_handler.play_audio(self.call_id, wav_path)
                # Wait for playback to finish. If the call died, StreamEnded
                # won't fire. Use a timeout based on audio length — PCM at
                # 48kHz 16-bit mono = 96000 bytes/sec. Add 10s buffer.
                audio_duration = len(audio_data) / 96000
                timeout = max(15, audio_duration + 10)
                await asyncio.wait_for(event.wait(), timeout=timeout)
            except Exception:
                # If play or wait failed, the call may be dead and pytgcalls
                # may have re-initiated a new call. Force leave to stop it.
                try:
                    await self.call_handler.pytgcalls.leave_call(self.session.user_id)
                except Exception:
                    pass
                raise
            finally:
                Path(wav_path).unlink(missing_ok=True)

        except asyncio.TimeoutError:
            # Playback timed out — call likely dead
            raise
        except Exception as e:
            error_msg = str(e).lower()
            # Re-raise call-dropped errors so conversation loop can handle them
            if any(s in error_msg for s in ("busy", "timed out", "not in a call", "declined")):
                raise
            logger.error(f"Error speaking: {e}")

    async def _get_lain_response(self, user_message: str) -> str | None:
        """Get Lain's response from the agent."""
        if not self._http_client:
            return "sorry... something's wrong with my connection..."

        try:
            response = await self._http_client.post(
                f"{self.settings.lain_agent_url}/api/chat",
                json={
                    "message": user_message,
                    "sessionId": f"voice:{self.call_id}",
                },
            )

            if response.status_code != 200:
                logger.error(f"Agent request failed: {response.status_code}")
                return "hmm... i can't think right now..."

            data = response.json()
            return data.get("response", "")

        except httpx.TimeoutException:
            logger.error("Agent request timed out")
            return "sorry... i'm a bit slow today..."
        except Exception as e:
            logger.error(f"Agent request failed: {e}")
            return "something went wrong..."

    def _request_hangup(self) -> None:
        """Request the call to be ended."""
        self._running = False
        asyncio.create_task(self.call_handler.end_call(self.call_id))

    def stop(self) -> None:
        """Stop the conversation."""
        self._running = False
