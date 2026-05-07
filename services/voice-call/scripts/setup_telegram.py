#!/usr/bin/env python3
"""Interactive Telegram authentication setup script.

Run this script first to authenticate with Telegram:
    python -m lain_voice.scripts.setup_telegram

This will create a session file that the voice service uses.
"""

import asyncio
import sys
from pathlib import Path

# Add src to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))


async def main() -> None:
    """Run interactive Telegram authentication."""
    from dotenv import load_dotenv

    # Load environment variables
    env_path = Path(__file__).parent.parent / ".env"
    if env_path.exists():
        load_dotenv(env_path)
    else:
        print(f"Warning: .env file not found at {env_path}")
        print("Make sure environment variables are set.")

    from pyrogram import Client

    from lain_voice.config import get_settings

    settings = get_settings()

    print("=" * 60)
    print("Lain Voice Call Service - Telegram Setup")
    print("=" * 60)
    print()
    print("This script will authenticate your Telegram user account.")
    print("You'll need to enter the verification code sent to your phone.")
    print()
    print(f"API ID: {settings.telegram_api_id}")
    print(f"Phone: {settings.telegram_phone_number}")
    print(f"Session: {settings.telegram_session_path}")
    print()

    # Create Pyrogram client
    client = Client(
        name=str(settings.telegram_session_path),
        api_id=settings.telegram_api_id,
        api_hash=settings.telegram_api_hash,
        phone_number=settings.telegram_phone_number,
    )

    try:
        print("Connecting to Telegram...")
        await client.start()

        me = await client.get_me()
        print()
        print("=" * 60)
        print("Authentication successful!")
        print("=" * 60)
        print(f"Logged in as: {me.first_name} {me.last_name or ''}")
        print(f"Username: @{me.username}" if me.username else "Username: (not set)")
        print(f"User ID: {me.id}")
        print()
        print(f"Session saved to: {settings.telegram_session_path}.session")
        print()
        print("You can now start the voice service:")
        print("  python -m lain_voice.main")
        print()

    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)

    finally:
        await client.stop()


if __name__ == "__main__":
    asyncio.run(main())
