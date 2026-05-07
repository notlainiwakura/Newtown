"""Configuration management for Lain Voice Call Service."""

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",  # Allow extra fields from shared .env
    )

    # Telegram settings
    telegram_api_id: int = Field(..., description="Telegram API ID from my.telegram.org")
    telegram_api_hash: str = Field(..., description="Telegram API hash from my.telegram.org")
    telegram_phone_number: str = Field(..., description="Phone number for Telegram user account")
    telegram_session_path: str = Field(
        default="lain_voice_session",
        description="Path to Pyrogram session file (without .session extension)",
    )

    # ElevenLabs settings
    elevenlabs_api_key: str = Field(..., description="ElevenLabs API key")
    elevenlabs_voice_id: str = Field(
        default="qv79skz136a7s2EdIdYa",
        description="ElevenLabs voice ID for Lain's voice",
    )
    elevenlabs_model_id: str = Field(
        default="eleven_turbo_v2_5",
        description="ElevenLabs model for low-latency streaming",
    )

    # Whisper settings
    whisper_model: str = Field(
        default="base",
        description="Whisper model size (tiny, base, small, medium, large)",
    )
    openai_api_key: str | None = Field(
        default=None,
        description="OpenAI API key for using Whisper API instead of local",
    )

    # Service settings
    voice_service_host: str = Field(default="127.0.0.1", description="Service bind host")
    voice_service_port: int = Field(default=8765, description="Service bind port")
    lain_agent_url: str = Field(
        default="http://localhost:3000",
        description="URL of the Lain Node.js agent",
    )

    # Audio settings
    audio_sample_rate: int = Field(default=48000, description="Audio sample rate in Hz")
    audio_channels: int = Field(default=1, description="Number of audio channels")
    audio_bit_depth: int = Field(default=16, description="Audio bit depth")

    # Call settings
    silence_threshold: float = Field(
        default=0.01,
        description="RMS threshold for silence detection",
    )
    silence_duration_ms: int = Field(
        default=1000,
        description="Duration of silence to trigger end of speech (ms)",
    )
    max_call_duration_seconds: int = Field(
        default=3600,
        description="Maximum call duration in seconds (1 hour default)",
    )

    # Logging
    log_level: str = Field(default="INFO", description="Logging level")

    @property
    def use_openai_whisper(self) -> bool:
        """Whether to use OpenAI API for Whisper instead of local model."""
        return self.openai_api_key is not None


@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
