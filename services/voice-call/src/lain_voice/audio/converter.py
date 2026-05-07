"""Audio format conversion utilities."""

import asyncio
import io
import logging
import wave
from pathlib import Path
from typing import BinaryIO

import numpy as np

from lain_voice.config import Settings, get_settings

logger = logging.getLogger(__name__)


class AudioConverter:
    """Convert between audio formats for pytgcalls compatibility."""

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()

    @property
    def target_sample_rate(self) -> int:
        """Target sample rate for pytgcalls (48kHz)."""
        return self.settings.audio_sample_rate

    @property
    def target_channels(self) -> int:
        """Target channels for pytgcalls (mono)."""
        return self.settings.audio_channels

    @property
    def target_bit_depth(self) -> int:
        """Target bit depth for pytgcalls (16-bit)."""
        return self.settings.audio_bit_depth

    def pcm_to_wav(self, pcm_data: bytes, sample_rate: int | None = None) -> bytes:
        """Convert raw PCM to WAV format."""
        if sample_rate is None:
            sample_rate = self.target_sample_rate

        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as wav:
            wav.setnchannels(self.target_channels)
            wav.setsampwidth(self.target_bit_depth // 8)
            wav.setframerate(sample_rate)
            wav.writeframes(pcm_data)

        return buffer.getvalue()

    def wav_to_pcm(self, wav_data: bytes) -> tuple[bytes, int]:
        """Convert WAV to raw PCM, returning (pcm_data, sample_rate)."""
        buffer = io.BytesIO(wav_data)
        with wave.open(buffer, "rb") as wav:
            sample_rate = wav.getframerate()
            pcm_data = wav.readframes(wav.getnframes())

        return pcm_data, sample_rate

    async def convert_to_pytgcalls_format(
        self,
        audio_data: bytes,
        source_format: str = "pcm",
        source_sample_rate: int = 48000,
    ) -> bytes:
        """Convert audio to pytgcalls-compatible format (PCM 16-bit 48kHz mono)."""
        if source_format == "wav":
            audio_data, source_sample_rate = self.wav_to_pcm(audio_data)

        # Resample if needed
        if source_sample_rate != self.target_sample_rate:
            audio_data = await self._resample(audio_data, source_sample_rate)

        return audio_data

    async def convert_from_pytgcalls_format(
        self,
        audio_data: bytes,
        target_format: str = "pcm",
        target_sample_rate: int = 16000,
    ) -> bytes:
        """Convert from pytgcalls format to target format."""
        # Resample to target rate (usually 16kHz for Whisper)
        if target_sample_rate != self.target_sample_rate:
            audio_data = await self._resample(
                audio_data,
                self.target_sample_rate,
                target_sample_rate,
            )

        if target_format == "wav":
            audio_data = self.pcm_to_wav(audio_data, target_sample_rate)

        return audio_data

    async def _resample(
        self,
        audio_data: bytes,
        source_rate: int,
        target_rate: int | None = None,
    ) -> bytes:
        """Resample audio data."""
        if target_rate is None:
            target_rate = self.target_sample_rate

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


def calculate_audio_duration_ms(audio_data: bytes, sample_rate: int = 48000) -> int:
    """Calculate audio duration in milliseconds."""
    # 16-bit audio = 2 bytes per sample
    num_samples = len(audio_data) // 2
    return int(num_samples / sample_rate * 1000)


def calculate_rms(audio_data: bytes) -> float:
    """Calculate RMS (root mean square) of audio data."""
    if len(audio_data) == 0:
        return 0.0

    audio_np = np.frombuffer(audio_data, dtype=np.int16).astype(np.float32) / 32768.0
    return float(np.sqrt(np.mean(audio_np ** 2)))


def is_silence(audio_data: bytes, threshold: float = 0.01) -> bool:
    """Check if audio data is silence."""
    return calculate_rms(audio_data) < threshold


def split_audio_chunks(
    audio_data: bytes,
    chunk_duration_ms: int = 20,
    sample_rate: int = 48000,
) -> list[bytes]:
    """Split audio into chunks of specified duration."""
    bytes_per_ms = sample_rate * 2 // 1000  # 16-bit = 2 bytes per sample
    chunk_size = bytes_per_ms * chunk_duration_ms

    chunks = []
    for i in range(0, len(audio_data), chunk_size):
        chunk = audio_data[i:i + chunk_size]
        # Pad last chunk if needed
        if len(chunk) < chunk_size:
            chunk = chunk + b"\x00" * (chunk_size - len(chunk))
        chunks.append(chunk)

    return chunks
