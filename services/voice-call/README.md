# Lain Voice Call Service

Real-time Telegram voice calls for Lain using pytgcalls, Whisper STT, and ElevenLabs TTS.

## Prerequisites

- Python 3.11+
- Telegram user account (not bot) with API credentials from https://my.telegram.org
- ElevenLabs API key with Lain's voice ID
- (Optional) OpenAI API key for cloud Whisper

## Setup

1. **Create virtual environment**
   ```bash
   cd services/voice-call
   python -m venv .venv
   source .venv/bin/activate  # or .venv\Scripts\activate on Windows
   ```

2. **Install dependencies**
   ```bash
   pip install -r requirements.txt
   ```

3. **Configure environment**
   ```bash
   cp .env.example .env
   # Edit .env with your credentials
   ```

4. **Authenticate with Telegram**
   ```bash
   python scripts/setup_telegram.py
   ```
   This will prompt for the verification code sent to your phone.

## Running

```bash
# From services/voice-call directory
python -m lain_voice.main

# Or with uvicorn directly
uvicorn lain_voice.main:app --host 127.0.0.1 --port 8765
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/calls/initiate` | Start a call to a user |
| POST | `/calls/{id}/hangup` | End an active call |
| GET | `/calls/{id}/status` | Get call status |
| GET | `/calls` | List all active calls |
| GET | `/health` | Health check |
| WS | `/ws/calls` | WebSocket for all call events |
| WS | `/ws/calls/{id}` | WebSocket for specific call events |

### Initiate Call

```bash
curl -X POST http://localhost:8765/calls/initiate \
  -H "Content-Type: application/json" \
  -d '{"user_id": "123456789", "reason": "discuss the project"}'
```

Response:
```json
{
  "call_id": "uuid-here",
  "user_id": 123456789,
  "status": "ringing",
  "reason": "discuss the project"
}
```

## Architecture

```
┌─────────────────────┐         ┌──────────────────────────┐
│  Lain Node.js       │  HTTP   │  Python Voice Service    │
│  Agent              │◄───────►│  (FastAPI + pytgcalls)   │
│                     │         │                          │
│  telegram_call tool │         │  ┌────────────────────┐  │
│  triggers calls     │         │  │ Pyrogram (MTProto) │  │
└─────────────────────┘         │  │ + pytgcalls        │  │
                                │  └─────────┬──────────┘  │
                                │            │             │
                                │  ┌─────────▼──────────┐  │
                                │  │ Audio Pipeline     │  │
                                │  │ - Whisper STT      │  │
                                │  │ - ElevenLabs TTS   │  │
                                │  └────────────────────┘  │
                                └──────────────────────────┘
```

## Conversation Flow

1. Lain's `telegram_call` tool calls Python service
2. Service initiates call via pytgcalls
3. User answers on Telegram
4. **Loop:**
   - User speaks → Whisper STT → transcript
   - Transcript → Lain agent → response
   - Response → ElevenLabs TTS → audio
   - Audio → pytgcalls → user hears Lain
5. Call ends (user hangup or Lain ends)

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `TELEGRAM_API_ID` | Telegram API ID from my.telegram.org | Required |
| `TELEGRAM_API_HASH` | Telegram API hash | Required |
| `TELEGRAM_PHONE_NUMBER` | Phone number for Telegram account | Required |
| `ELEVENLABS_API_KEY` | ElevenLabs API key | Required |
| `ELEVENLABS_VOICE_ID` | Voice ID for Lain | `qv79skz136a7s2EdIdYa` |
| `WHISPER_MODEL` | Local Whisper model size | `base` |
| `OPENAI_API_KEY` | Optional: Use OpenAI Whisper API | None |
| `VOICE_SERVICE_HOST` | Service bind host | `127.0.0.1` |
| `VOICE_SERVICE_PORT` | Service bind port | `8765` |
| `LAIN_AGENT_URL` | URL of Lain Node.js agent | `http://localhost:3000` |

## Notes

- pytgcalls private calls feature requires the dev branch
- Requires a separate Telegram user account (not the bot)
- Audio must be PCM 16-bit 48kHz mono for pytgcalls
- First-time auth requires interactive phone verification
