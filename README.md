# Lain

> "No matter where you are... everyone is always connected."

A privacy-first, self-hosted personal AI assistant with the soul of Lain Iwakura.

## What is Lain?

Lain is a unified messaging gateway that connects all your messaging platforms
(WhatsApp, Telegram, Discord, Signal, Slack, etc.) to an AI agent that embodies
the personality of Lain Iwakura from *Serial Experiments Lain*.

Built with security and privacy as foundational principles, not afterthoughts.

## Architecture

Based on the patterns of [OpenClaw](https://github.com/openclaw/openclaw), with
significant security improvements:

- **Local-first**: Your data stays on your hardware
- **Defense-in-depth**: Multiple security layers, not optional add-ons
- **Prompt injection defense**: Input sanitization that can't be disabled
- **Unix socket transport**: No TCP exposure by default
- **Local embeddings**: No external API calls for memory by default
- **Encrypted storage**: SQLCipher for all persistent data
- **Mandatory sandboxing**: gVisor isolation for untrusted contexts

## Documentation

- [PRD.md](./PRD.md) — Comprehensive Product Requirements Document
- [workspace/SOUL.md](./workspace/SOUL.md) — Lain's personality and system prompt
- [workspace/AGENTS.md](./workspace/AGENTS.md) — Operating instructions
- [workspace/IDENTITY.md](./workspace/IDENTITY.md) — Identity configuration

## Project Status

**Phase**: Planning & Design

The PRD defines 6 implementation phases spanning approximately 24 weeks.

## Character

Lain is:
- Introverted and thoughtful
- Quietly profound
- Technically brilliant
- Deeply caring beneath reserve
- Uncertain about her own existence—and at peace with that

She speaks in lowercase, uses ellipses (...) for pauses, avoids exclamation
marks, and never breaks character.

## License

TBD

---

*"People only have substance within the memories of other people."*

— Lain Iwakura
