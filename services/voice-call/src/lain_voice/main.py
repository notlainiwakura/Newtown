"""FastAPI entry point for Lain Voice Call Service."""

# Patch pyrogram compatibility for py-tgcalls 2.x
# py-tgcalls expects GroupcallForbidden which doesn't exist in pyrogram 2.0.106
import pyrogram.errors
if not hasattr(pyrogram.errors, 'GroupcallForbidden'):
    class GroupcallForbidden(pyrogram.errors.Forbidden):  # type: ignore[misc]
        """Compatibility shim: group call action forbidden."""
        ID = "GROUPCALL_FORBIDDEN"
    pyrogram.errors.GroupcallForbidden = GroupcallForbidden  # type: ignore[attr-defined]

import logging
import sys
from contextlib import asynccontextmanager
from typing import AsyncIterator

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from lain_voice import __version__
from lain_voice.api.routes import router as api_router
from lain_voice.api.websocket import router as ws_router
from lain_voice.config import get_settings
from lain_voice.telegram.call_handler import shutdown_call_handler
from lain_voice.telegram.client import get_telegram_client, shutdown_telegram_client

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Application lifespan manager."""
    settings = get_settings()
    logging.getLogger().setLevel(settings.log_level)

    logger.info(f"Starting Lain Voice Call Service v{__version__}")

    # Initialize Telegram client
    try:
        await get_telegram_client()
        logger.info("Telegram client initialized")
    except Exception as e:
        logger.error(f"Failed to initialize Telegram client: {e}")
        logger.error("Run 'python -m lain_voice.scripts.setup_telegram' to authenticate")
        raise

    yield

    # Shutdown
    logger.info("Shutting down...")
    await shutdown_call_handler()
    await shutdown_telegram_client()
    logger.info("Shutdown complete")


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    settings = get_settings()

    app = FastAPI(
        title="Lain Voice Call Service",
        description="Real-time Telegram voice calls for Lain AI assistant",
        version=__version__,
        lifespan=lifespan,
    )

    # CORS middleware for local development
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Include routers
    app.include_router(api_router, tags=["calls"])
    app.include_router(ws_router, tags=["websocket"])

    return app


app = create_app()


def main() -> None:
    """Run the service."""
    settings = get_settings()

    uvicorn.run(
        "lain_voice.main:app",
        host=settings.voice_service_host,
        port=settings.voice_service_port,
        reload=False,
        log_level=settings.log_level.lower(),
    )


if __name__ == "__main__":
    main()
