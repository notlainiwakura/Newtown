"""Text-to-speech using ElevenLabs API."""

import asyncio
import io
import logging
from collections.abc import AsyncIterator

import numpy as np

from lain_voice.config import Settings, get_settings

logger = logging.getLogger(__name__)


class TextToSpeech:
    """ElevenLabs text-to-speech for Lain's voice."""

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self._client = None

    def _get_client(self):
        """Lazy initialize ElevenLabs client."""
        if self._client is None:
            from elevenlabs.client import AsyncElevenLabs
            self._client = AsyncElevenLabs(api_key=self.settings.elevenlabs_api_key)
        return self._client

    async def synthesize(self, text: str) -> bytes:
        """Synthesize text to PCM audio data."""
        if not text.strip():
            return b""

        client = self._get_client()

        try:
            # Generate audio using ElevenLabs
            audio_generator = client.text_to_speech.convert(
                voice_id=self.settings.elevenlabs_voice_id,
                text=text,
                model_id=self.settings.elevenlabs_model_id,
                output_format="pcm_24000",  # 24kHz 16-bit PCM
            )

            # Collect all chunks
            chunks = []
            async for chunk in audio_generator:
                chunks.append(chunk)

            audio_data = b"".join(chunks)

            # Resample to 48kHz for pytgcalls
            if self.settings.audio_sample_rate != 24000:
                audio_data = await self._resample_pcm(
                    audio_data,
                    source_rate=24000,
                    target_rate=self.settings.audio_sample_rate,
                )

            return audio_data

        except Exception as e:
            logger.error(f"TTS synthesis failed: {e}")
            raise

    async def synthesize_stream(self, text: str) -> AsyncIterator[bytes]:
        """Stream synthesized audio chunks."""
        if not text.strip():
            return

        client = self._get_client()

        try:
            audio_generator = client.text_to_speech.convert(
                voice_id=self.settings.elevenlabs_voice_id,
                text=text,
                model_id=self.settings.elevenlabs_model_id,
                output_format="pcm_24000",
            )

            buffer = b""
            chunk_size = 4800  # 100ms at 24kHz 16-bit mono

            async for chunk in audio_generator:
                buffer += chunk

                while len(buffer) >= chunk_size:
                    audio_chunk = buffer[:chunk_size]
                    buffer = buffer[chunk_size:]

                    # Resample if needed
                    if self.settings.audio_sample_rate != 24000:
                        audio_chunk = await self._resample_pcm(
                            audio_chunk,
                            source_rate=24000,
                            target_rate=self.settings.audio_sample_rate,
                        )

                    yield audio_chunk

            # Yield remaining buffer
            if buffer:
                if self.settings.audio_sample_rate != 24000:
                    buffer = await self._resample_pcm(
                        buffer,
                        source_rate=24000,
                        target_rate=self.settings.audio_sample_rate,
                    )
                yield buffer

        except Exception as e:
            logger.error(f"TTS streaming failed: {e}")
            raise

    async def _resample_pcm(
        self,
        audio_data: bytes,
        source_rate: int,
        target_rate: int,
    ) -> bytes:
        """Resample PCM audio data to target sample rate."""
        if source_rate == target_rate:
            return audio_data

        # Convert to numpy
        audio_np = np.frombuffer(audio_data, dtype=np.int16).astype(np.float32)

        # Calculate new length
        ratio = target_rate / source_rate
        new_length = int(len(audio_np) * ratio)

        # Resample using linear interpolation
        indices = np.linspace(0, len(audio_np) - 1, new_length)
        resampled = np.interp(indices, np.arange(len(audio_np)), audio_np)

        return resampled.astype(np.int16).tobytes()
