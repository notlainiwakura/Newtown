"""Speech-to-text using Whisper (local or OpenAI API)."""

import asyncio
import io
import logging
import tempfile
from abc import ABC, abstractmethod
from pathlib import Path

import numpy as np

from lain_voice.config import Settings, get_settings

logger = logging.getLogger(__name__)


class STTProvider(ABC):
    """Abstract base class for speech-to-text providers."""

    @abstractmethod
    async def transcribe(self, audio_data: bytes, sample_rate: int = 48000) -> str:
        """Transcribe audio data to text."""
        pass

    @abstractmethod
    async def transcribe_file(self, file_path: str | Path) -> str:
        """Transcribe audio from a file path."""
        pass


class LocalWhisperSTT(STTProvider):
    """Local Whisper model for speech-to-text."""

    def __init__(self, model_name: str = "base") -> None:
        self.model_name = model_name
        self._model = None

    def _load_model(self):
        """Lazy load the Whisper model."""
        if self._model is None:
            import whisper
            logger.info(f"Loading Whisper model: {self.model_name}")
            self._model = whisper.load_model(self.model_name)
        return self._model

    async def transcribe(self, audio_data: bytes, sample_rate: int = 48000) -> str:
        """Transcribe audio data to text using local Whisper."""
        model = self._load_model()

        # Convert bytes to numpy array
        audio_np = np.frombuffer(audio_data, dtype=np.int16).astype(np.float32) / 32768.0

        # Resample to 16kHz if needed (Whisper expects 16kHz)
        if sample_rate != 16000:
            import av

            # Create temporary file for resampling
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                tmp_path = Path(tmp.name)

            try:
                # Write original audio
                self._write_wav(tmp_path, audio_np, sample_rate)

                # Resample using av
                resampled = await asyncio.to_thread(
                    self._resample_audio, tmp_path, 16000
                )
                audio_np = resampled
            finally:
                tmp_path.unlink(missing_ok=True)

        # Run transcription in thread pool
        result = await asyncio.to_thread(
            model.transcribe,
            audio_np,
            language="en",
            fp16=False,
        )

        return result["text"].strip()

    async def transcribe_file(self, file_path: str | Path) -> str:
        """Transcribe audio from a file using local Whisper."""
        model = self._load_model()
        result = await asyncio.to_thread(
            model.transcribe, str(file_path), language="en", fp16=False,
        )
        return result["text"].strip()

    def _write_wav(self, path: Path, audio: np.ndarray, sample_rate: int) -> None:
        """Write audio data to WAV file."""
        import wave

        with wave.open(str(path), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(sample_rate)
            wav.writeframes((audio * 32768).astype(np.int16).tobytes())

    def _resample_audio(self, path: Path, target_rate: int) -> np.ndarray:
        """Resample audio file to target rate."""
        import av

        container = av.open(str(path))
        audio_stream = container.streams.audio[0]

        resampler = av.audio.resampler.AudioResampler(
            format="s16",
            layout="mono",
            rate=target_rate,
        )

        frames = []
        for frame in container.decode(audio_stream):
            resampled = resampler.resample(frame)
            for r in resampled:
                frames.append(r.to_ndarray().flatten())

        container.close()
        audio = np.concatenate(frames).astype(np.float32) / 32768.0
        return audio


class OpenAIWhisperSTT(STTProvider):
    """OpenAI Whisper API for speech-to-text."""

    def __init__(self, api_key: str) -> None:
        self.api_key = api_key
        self._client = None

    def _get_client(self):
        """Lazy initialize OpenAI client."""
        if self._client is None:
            from openai import AsyncOpenAI
            self._client = AsyncOpenAI(api_key=self.api_key)
        return self._client

    async def transcribe(self, audio_data: bytes, sample_rate: int = 48000) -> str:
        """Transcribe audio data to text using OpenAI Whisper API."""
        client = self._get_client()

        # Convert raw PCM to WAV format
        wav_buffer = io.BytesIO()
        self._write_wav_to_buffer(wav_buffer, audio_data, sample_rate)
        wav_buffer.seek(0)
        wav_buffer.name = "audio.wav"

        response = await client.audio.transcriptions.create(
            model="whisper-1",
            file=wav_buffer,
            language="en",
        )

        return response.text.strip()

    async def transcribe_file(self, file_path: str | Path) -> str:
        """Transcribe audio from a file using OpenAI Whisper API."""
        client = self._get_client()
        with open(file_path, "rb") as f:
            response = await client.audio.transcriptions.create(
                model="whisper-1", file=f,
            )
        return response.text.strip()

    def _write_wav_to_buffer(
        self,
        buffer: io.BytesIO,
        audio_data: bytes,
        sample_rate: int,
    ) -> None:
        """Write PCM audio data to WAV format in buffer."""
        import wave

        with wave.open(buffer, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(sample_rate)
            wav.writeframes(audio_data)


class SpeechToText:
    """Main STT interface that delegates to the configured provider."""

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self._provider: STTProvider | None = None

    @property
    def provider(self) -> STTProvider:
        """Get or create the STT provider."""
        if self._provider is None:
            if self.settings.use_openai_whisper:
                logger.info("Using OpenAI Whisper API for STT")
                self._provider = OpenAIWhisperSTT(self.settings.openai_api_key)
            else:
                logger.info(f"Using local Whisper model ({self.settings.whisper_model}) for STT")
                self._provider = LocalWhisperSTT(self.settings.whisper_model)
        return self._provider

    async def transcribe(self, audio_data: bytes, sample_rate: int | None = None) -> str:
        """Transcribe audio data to text."""
        if sample_rate is None:
            sample_rate = self.settings.audio_sample_rate

        if len(audio_data) == 0:
            return ""

        try:
            return await self.provider.transcribe(audio_data, sample_rate)
        except Exception as e:
            logger.error(f"STT transcription failed: {e}")
            raise

    async def transcribe_file(self, file_path: str | Path) -> str:
        """Transcribe audio from a file path."""
        try:
            return await self.provider.transcribe_file(file_path)
        except Exception as e:
            logger.error(f"STT file transcription failed: {e}")
            raise
