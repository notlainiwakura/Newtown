"""Pyrogram client wrapper for Telegram MTProto user authentication."""

import asyncio
import logging
import sqlite3
from pathlib import Path
from typing import Self

from pyrogram import Client
from pyrogram.types import User

from lain_voice.config import Settings, get_settings

# Resolve session paths relative to the service root (where .env lives)
_SERVICE_ROOT = Path(__file__).parent.parent.parent.parent

logger = logging.getLogger(__name__)


def _validate_session(session_file: Path) -> bool:
    """Check if a session file exists and contains a valid authenticated session.
    Prevents Pyrogram from overwriting a good session with a blank re-auth attempt.
    """
    if not session_file.exists():
        return False
    try:
        db = sqlite3.connect(str(session_file))
        row = db.execute("SELECT user_id FROM sessions LIMIT 1").fetchone()
        db.close()
        return row is not None and row[0] is not None
    except Exception:
        return False


class TelegramClient:
    """Wrapper around Pyrogram client for Telegram user account operations."""

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self._client: Client | None = None
        self._me: User | None = None

    @property
    def client(self) -> Client:
        """Get the Pyrogram client instance."""
        if self._client is None:
            raise RuntimeError("Telegram client not initialized. Call start() first.")
        return self._client

    @property
    def me(self) -> User:
        """Get the authenticated user info."""
        if self._me is None:
            raise RuntimeError("Telegram client not authenticated. Call start() first.")
        return self._me

    async def start(self) -> Self:
        """Initialize and start the Pyrogram client."""
        if self._client is not None:
            logger.warning("Telegram client already started")
            return self

        logger.info("Initializing Pyrogram client...")
        # Resolve session path: if already absolute, use as-is; otherwise resolve relative to service root
        raw_path = self.settings.telegram_session_path
        if Path(raw_path).is_absolute():
            session_path = Path(raw_path)
        else:
            # Try service root first, then cwd
            candidate = _SERVICE_ROOT / raw_path
            if Path(str(candidate) + '.session').exists():
                session_path = candidate
            else:
                session_path = Path.cwd() / raw_path
        logger.info(f"Session path: {session_path}")

        # Validate session before starting — refuse to overwrite with a blank re-auth
        session_file = Path(str(session_path) + '.session')
        if not _validate_session(session_file):
            raise RuntimeError(
                f"No valid session at {session_file}. "
                "Run 'python3 scripts/setup_telegram.py' to authenticate first."
            )

        self._client = Client(
            name=str(session_path),
            api_id=self.settings.telegram_api_id,
            api_hash=self.settings.telegram_api_hash,
            phone_number=self.settings.telegram_phone_number,
        )

        await self._client.start()
        self._me = await self._client.get_me()
        logger.info(f"Authenticated as {self._me.first_name} (@{self._me.username})")

        return self

    async def stop(self) -> None:
        """Stop the Pyrogram client."""
        if self._client is not None:
            logger.info("Stopping Pyrogram client...")
            await self._client.stop()
            self._client = None
            self._me = None

    async def get_user_by_id(self, user_id: int | str) -> User | None:
        """Get user info by ID or username."""
        try:
            return await self.client.get_users(user_id)
        except Exception as e:
            logger.error(f"Failed to get user {user_id}: {e}")
            return None

    async def resolve_peer(self, identifier: int | str) -> int:
        """Resolve a user identifier to a numeric ID."""
        if isinstance(identifier, int):
            return identifier

        user = await self.get_user_by_id(identifier)
        if user is None:
            raise ValueError(f"Could not resolve user: {identifier}")
        return user.id


# Global singleton instance
_telegram_client: TelegramClient | None = None


async def get_telegram_client() -> TelegramClient:
    """Get or create the global Telegram client instance."""
    global _telegram_client
    if _telegram_client is None:
        _telegram_client = TelegramClient()
        await _telegram_client.start()
    return _telegram_client


async def shutdown_telegram_client() -> None:
    """Shutdown the global Telegram client."""
    global _telegram_client
    if _telegram_client is not None:
        await _telegram_client.stop()
        _telegram_client = None
