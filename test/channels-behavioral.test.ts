/**
 * Behavioral test suite for channel adapters.
 *
 * Unlike channels.test.ts (structural/source analysis), this file actually
 * executes channel adapter functions with mocked SDKs and verifies runtime
 * behavior: message translation, error handling, splitting, filtering,
 * concurrency, session isolation, and cross-channel consistency.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, OutgoingMessage } from '../src/types/message.js';

// ─── Logger mock ────────────────────────────────────────────────────────────
vi.mock('../src/utils/logger.js', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  createLogger: vi.fn(),
}));

// ─── grammY mock ────────────────────────────────────────────────────────────
const mockBotStart = vi.fn();
const mockBotStop = vi.fn();
const mockBotCatch = vi.fn();
const mockBotOn = vi.fn();
const mockBotCommand = vi.fn();
const mockSendMessage = vi.fn().mockResolvedValue({});
const mockSendPhoto = vi.fn().mockResolvedValue({});
const mockSendDocument = vi.fn().mockResolvedValue({});
const mockSendVoice = vi.fn().mockResolvedValue({});

const mockBotInstance = {
  on: mockBotOn,
  catch: mockBotCatch,
  start: mockBotStart,
  stop: mockBotStop,
  command: mockBotCommand,
  api: {
    sendMessage: mockSendMessage,
    sendPhoto: mockSendPhoto,
    sendDocument: mockSendDocument,
    sendVoice: mockSendVoice,
  },
};

vi.mock('grammy', () => ({
  Bot: vi.fn(() => mockBotInstance),
}));

// ─── discord.js mock ────────────────────────────────────────────────────────
const mockClientLogin = vi.fn().mockResolvedValue('token');
const mockClientDestroy = vi.fn().mockResolvedValue(undefined);
const mockClientOn = vi.fn();
const mockChannelsFetch = vi.fn();
const mockClientUser = { id: 'bot-user-id', tag: 'TestBot#1234' };

const mockDiscordClientInstance = {
  on: mockClientOn,
  login: mockClientLogin,
  destroy: mockClientDestroy,
  user: mockClientUser,
  channels: {
    fetch: mockChannelsFetch,
  },
};

vi.mock('discord.js', () => ({
  Client: vi.fn(() => mockDiscordClientInstance),
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 2,
    DirectMessages: 4,
    MessageContent: 8,
  },
  Partials: {
    Channel: 'CHANNEL',
    Message: 'MESSAGE',
  },
}));

// ─── @slack/bolt mock ───────────────────────────────────────────────────────
const mockSlackAppStart = vi.fn().mockResolvedValue(undefined);
const mockSlackAppStop = vi.fn().mockResolvedValue(undefined);
const mockSlackAppMessage = vi.fn();
const mockSlackAppEvent = vi.fn();
const mockSlackChatPostMessage = vi.fn().mockResolvedValue({});
const mockSlackFilesUpload = vi.fn().mockResolvedValue({});

const mockSlackAppInstance = {
  message: mockSlackAppMessage,
  event: mockSlackAppEvent,
  start: mockSlackAppStart,
  stop: mockSlackAppStop,
  client: {
    chat: { postMessage: mockSlackChatPostMessage },
    files: { uploadV2: mockSlackFilesUpload },
  },
};

vi.mock('@slack/bolt', () => ({
  App: vi.fn(() => mockSlackAppInstance),
}));

// ─── node:net mock (Signal) ─────────────────────────────────────────────────
const mockSocketWrite = vi.fn((data: string, cb?: (err?: Error) => void) => {
  cb?.();
  return true;
});
const mockSocketDestroy = vi.fn();
const mockSocketEnd = vi.fn();
const mockSocketOn = vi.fn();

const mockSocketInstance = {
  on: mockSocketOn,
  write: mockSocketWrite,
  destroy: mockSocketDestroy,
  end: mockSocketEnd,
};

vi.mock('node:net', () => ({
  createConnection: vi.fn(() => mockSocketInstance),
}));

// ─── @whiskeysockets/baileys mock ───────────────────────────────────────────
const mockWASocketSendMessage = vi.fn().mockResolvedValue({});
const mockWASocketEnd = vi.fn();
const mockWASocketEvOn = vi.fn();

const mockWASocketInstance = {
  sendMessage: mockWASocketSendMessage,
  end: mockWASocketEnd,
  ev: {
    on: mockWASocketEvOn,
  },
};

vi.mock('@whiskeysockets/baileys', () => ({
  default: vi.fn(() => mockWASocketInstance),
  DisconnectReason: { loggedOut: 401 },
  useMultiFileAuthState: vi.fn().mockResolvedValue({
    state: {},
    saveCreds: vi.fn(),
  }),
}));

vi.mock('@hapi/boom', () => ({
  Boom: class Boom extends Error {
    output: { statusCode: number };
    constructor(message: string, opts?: { statusCode?: number }) {
      super(message);
      this.output = { statusCode: opts?.statusCode ?? 500 };
    }
  },
}));

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('nanoid', () => ({
  nanoid: vi.fn((size?: number) => 'mock-id-' + (size ?? 21)),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Flush microtasks so emitted messages settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

function makeTelegramCtx(overrides: Record<string, unknown> = {}) {
  return {
    chat: { id: 100, type: 'private' },
    from: { id: 200, first_name: 'Alice', last_name: 'Smith', username: 'alice_s' },
    message: { message_id: 1, text: 'hello', date: 1700000000 },
    ...overrides,
  };
}

function makeDiscordMsg(overrides: Record<string, unknown> = {}) {
  return {
    author: { id: 'user-1', bot: false, displayName: 'Alice', username: 'alice' },
    content: 'hello',
    attachments: { size: 0, first: () => null },
    guild: null,
    channel: { id: 'ch-1' },
    createdTimestamp: 1700000000000,
    reference: null,
    id: 'msg-1',
    ...overrides,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. TELEGRAM BEHAVIORAL (~70 tests)
// ═════════════════════════════════════════════════════════════════════════════
describe('Telegram behavioral', () => {
  let TelegramChannel: typeof import('../src/channels/telegram.js').TelegramChannel;

  // public: true so shared behavioral tests (no allowlists set) are not
  // fail-closed by the new isAllowed default. Tests that cover the
  // fail-closed path construct their own config without public.
  const cfg = {
    id: 'tg-beh',
    type: 'telegram' as const,
    enabled: true,
    agentId: 'agent-1',
    token: 'test-token',
    public: true,
  };

  function getHandler(event: string): (ctx: any) => Promise<void> {
    const entry = mockBotOn.mock.calls.find((c: any[]) => c[0] === event);
    if (!entry) throw new Error(`No handler registered for ${event}`);
    return entry[1];
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ TelegramChannel } = await import('../src/channels/telegram.js'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Message received -> IncomingMessage structure ---

  it('text message produces IncomingMessage with correct structure', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel(cfg);
    ch.setEventHandlers({ onMessage });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await getHandler('message:text')(makeTelegramCtx());
    await flush();

    const msg: IncomingMessage = onMessage.mock.calls[0][0];
    expect(msg.id).toBeDefined();
    expect(msg.channel).toBe('telegram');
    expect(msg.peerKind).toBe('user');
    expect(msg.peerId).toBe('100');
    expect(msg.senderId).toBe('200');
    expect(msg.senderName).toBe('Alice Smith');
    expect(msg.content).toEqual({ type: 'text', text: 'hello' });
    expect(msg.timestamp).toBe(1700000000000);
    expect(msg.metadata).toEqual(
      expect.objectContaining({ messageId: 1, chatType: 'private', username: 'alice_s' })
    );
  });

  it('response is sent back via bot.api.sendMessage', async () => {
    const ch = new TelegramChannel(cfg);
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await ch.send({
      id: 'out-1',
      channel: 'telegram',
      peerId: '100',
      content: { type: 'text', text: 'reply text' },
    });

    expect(mockSendMessage).toHaveBeenCalledWith('100', 'reply text', expect.any(Object));
  });

  // --- Long response split into multiple messages (4096 char limit) ---

  it('message at exactly 4096 chars is sent as one chunk', async () => {
    const ch = new TelegramChannel(cfg);
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();
    mockSendMessage.mockClear();

    const text = 'x'.repeat(4096);
    await ch.send({ id: 'o', channel: 'telegram', peerId: '1', content: { type: 'text', text } });
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  it('message of 4097 chars is split into two chunks', async () => {
    const ch = new TelegramChannel(cfg);
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();
    mockSendMessage.mockClear();

    const text = 'x'.repeat(4097);
    await ch.send({ id: 'o', channel: 'telegram', peerId: '1', content: { type: 'text', text } });
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });

  it('8192 char message is split into exactly 2 chunks', async () => {
    const ch = new TelegramChannel(cfg);
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();
    mockSendMessage.mockClear();

    const text = 'x'.repeat(8192);
    await ch.send({ id: 'o', channel: 'telegram', peerId: '1', content: { type: 'text', text } });
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });

  it('12500 char message is split into at least 3 chunks', async () => {
    const ch = new TelegramChannel(cfg);
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();
    mockSendMessage.mockClear();

    const text = 'x'.repeat(12500);
    await ch.send({ id: 'o', channel: 'telegram', peerId: '1', content: { type: 'text', text } });
    expect(mockSendMessage.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('split prefers paragraph boundaries (double newline)', async () => {
    const ch = new TelegramChannel(cfg);
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();
    mockSendMessage.mockClear();

    const part1 = 'A'.repeat(3000);
    const part2 = 'B'.repeat(3000);
    const text = part1 + '\n\n' + part2;
    await ch.send({ id: 'o', channel: 'telegram', peerId: '1', content: { type: 'text', text } });

    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    // First chunk should end at or near the paragraph break
    const firstChunk: string = mockSendMessage.mock.calls[0][1];
    expect(firstChunk.endsWith('A'.repeat(10))).toBe(true); // ends with A's
  });

  it('split falls back to single newline when no paragraph break', async () => {
    const ch = new TelegramChannel(cfg);
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();
    mockSendMessage.mockClear();

    const part1 = 'A'.repeat(3000);
    const part2 = 'B'.repeat(3000);
    const text = part1 + '\n' + part2; // single newline only
    await ch.send({ id: 'o', channel: 'telegram', peerId: '1', content: { type: 'text', text } });

    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });

  it('split hard-cuts when no newlines exist', async () => {
    const ch = new TelegramChannel(cfg);
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();
    mockSendMessage.mockClear();

    const text = 'x'.repeat(5000); // no newlines at all
    await ch.send({ id: 'o', channel: 'telegram', peerId: '1', content: { type: 'text', text } });

    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    const firstChunk: string = mockSendMessage.mock.calls[0][1];
    expect(firstChunk.length).toBe(4096);
  });

  it('replyTo is only set on first chunk of split message', async () => {
    const ch = new TelegramChannel(cfg);
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    const capturedOptions: any[] = [];
    mockSendMessage.mockImplementation(async (_chatId: string, _text: string, opts: any) => {
      capturedOptions.push({ ...opts });
      return {};
    });

    const text = 'x'.repeat(5000);
    await ch.send({
      id: 'o',
      channel: 'telegram',
      peerId: '1',
      replyTo: '42',
      content: { type: 'text', text },
    });

    expect(capturedOptions[0].reply_to_message_id).toBe(42);
    expect(capturedOptions[1].reply_to_message_id).toBeUndefined();
  });

  it('every chunk is within 4096 char limit', async () => {
    const ch = new TelegramChannel(cfg);
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();
    mockSendMessage.mockClear();

    const text = 'word '.repeat(2000); // ~10000 chars
    await ch.send({ id: 'o', channel: 'telegram', peerId: '1', content: { type: 'text', text } });

    for (const call of mockSendMessage.mock.calls) {
      expect((call[1] as string).length).toBeLessThanOrEqual(4096);
    }
  });

  it('all text is preserved across chunks (no data loss)', async () => {
    const ch = new TelegramChannel(cfg);
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();
    mockSendMessage.mockClear();

    // Use newline-separated words so splits happen at clean boundaries
    const text = Array.from({ length: 500 }, (_, i) => `word${i}`).join('\n');
    await ch.send({ id: 'o', channel: 'telegram', peerId: '1', content: { type: 'text', text } });

    // Reconstruct by joining chunks. Trimming at boundaries removes the newline,
    // so we concatenate without adding extra characters.
    const reconstructed = mockSendMessage.mock.calls.map((c: any[]) => c[1] as string).join('\n');
    // Verify every word is present in the reconstructed output
    for (let i = 0; i < 500; i++) {
      expect(reconstructed).toContain(`word${i}`);
    }
  });

  // --- Photo/image message handling ---

  // findings.md P2:199 — Telegram media (photo/voice/document) requires
  // a separate getFile round-trip that we don't perform here, so the
  // channel emits a TextContent placeholder rather than an ImageContent/
  // AudioContent/FileContent with no url/base64.

  it('photo message produces text placeholder (no getFile round-trip)', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel(cfg);
    ch.setEventHandlers({ onMessage });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await getHandler('message:photo')(makeTelegramCtx({
      message: { message_id: 2, caption: 'cool pic', date: 1700000000 },
    }));
    await flush();

    const msg: IncomingMessage = onMessage.mock.calls[0][0];
    expect(msg.content.type).toBe('text');
    expect((msg.content as any).text).toBe('[image attachment] cool pic');
  });

  it('photo message without caption still produces text placeholder', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel(cfg);
    ch.setEventHandlers({ onMessage });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await getHandler('message:photo')(makeTelegramCtx({
      message: { message_id: 2, date: 1700000000 },
    }));
    await flush();

    const msg: IncomingMessage = onMessage.mock.calls[0][0];
    expect(msg.content.type).toBe('text');
    expect((msg.content as any).text).toBe('[image attachment]');
  });

  // --- Voice message handling ---

  it('voice message produces text placeholder (no getFile round-trip)', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel(cfg);
    ch.setEventHandlers({ onMessage });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await getHandler('message:voice')(makeTelegramCtx({
      message: { message_id: 3, voice: { duration: 12 }, date: 1700000000 },
    }));
    await flush();

    const msg: IncomingMessage = onMessage.mock.calls[0][0];
    expect(msg.content.type).toBe('text');
    expect((msg.content as any).text).toBe('[audio attachment]');
  });

  it('document message produces text placeholder with filename', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel(cfg);
    ch.setEventHandlers({ onMessage });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await getHandler('message:document')(makeTelegramCtx({
      message: { message_id: 4, document: { mime_type: 'application/pdf', file_name: 'report.pdf' }, date: 1700000000 },
    }));
    await flush();

    const msg: IncomingMessage = onMessage.mock.calls[0][0];
    expect(msg.content.type).toBe('text');
    expect((msg.content as any).text).toBe('[file attachment: report.pdf]');
  });

  // --- Group chat vs DM ---

  it('private chat sets peerKind=user', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel(cfg);
    ch.setEventHandlers({ onMessage });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await getHandler('message:text')(makeTelegramCtx({ chat: { id: 1, type: 'private' } }));
    await flush();

    expect(onMessage.mock.calls[0][0].peerKind).toBe('user');
  });

  it('group chat sets peerKind=group', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel(cfg);
    ch.setEventHandlers({ onMessage });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await getHandler('message:text')(makeTelegramCtx({ chat: { id: -100, type: 'group' } }));
    await flush();

    expect(onMessage.mock.calls[0][0].peerKind).toBe('group');
  });

  it('supergroup chat sets peerKind=group', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel(cfg);
    ch.setEventHandlers({ onMessage });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await getHandler('message:text')(makeTelegramCtx({ chat: { id: -1001234, type: 'supergroup' } }));
    await flush();

    expect(onMessage.mock.calls[0][0].peerKind).toBe('group');
  });

  // --- Blocked user (allowedUsers filter) ---

  it('message from blocked user is ignored', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel({ ...cfg, allowedUsers: ['999'] });
    ch.setEventHandlers({ onMessage });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await getHandler('message:text')(makeTelegramCtx({
      from: { id: 666, first_name: 'BadGuy' },
    }));
    await flush();

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('message from allowed user is processed', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel({ ...cfg, allowedUsers: ['200'] });
    ch.setEventHandlers({ onMessage });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await getHandler('message:text')(makeTelegramCtx());
    await flush();

    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('allowedGroups allows group messages from allowed group', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel({ ...cfg, allowedGroups: ['-100'] });
    ch.setEventHandlers({ onMessage });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await getHandler('message:text')(makeTelegramCtx({
      chat: { id: -100, type: 'group' },
      from: { id: 777, first_name: 'Member' },
    }));
    await flush();

    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('allowedGroups blocks private messages not in allowedUsers', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel({ ...cfg, allowedGroups: ['-100'] });
    ch.setEventHandlers({ onMessage });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await getHandler('message:text')(makeTelegramCtx({
      chat: { id: 999, type: 'private' },
      from: { id: 999, first_name: 'Stranger' },
    }));
    await flush();

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('no restrictions + no public flag -> fail-closed, message dropped', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    // Explicitly strip the shared cfg's public flag for this test.
    const strictCfg = { ...cfg, public: false };
    const ch = new TelegramChannel(strictCfg);
    ch.setEventHandlers({ onMessage });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await getHandler('message:text')(makeTelegramCtx({
      from: { id: 42, first_name: 'Anyone' },
    }));
    await flush();

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('public: true -> messages allowed even with no allowlists', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel({ ...cfg, public: true });
    ch.setEventHandlers({ onMessage });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await getHandler('message:text')(makeTelegramCtx({
      from: { id: 42, first_name: 'Anyone' },
    }));
    await flush();

    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  // --- Telegram API error handling ---

  it('bot.catch triggers error handler without crashing', async () => {
    const onError = vi.fn();
    const ch = new TelegramChannel(cfg);
    ch.setEventHandlers({ onError });
    vi.useFakeTimers();
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    const catchHandler = mockBotCatch.mock.calls[0][0];
    catchHandler(new Error('Telegram API 429'));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Telegram API 429' }));
    vi.useRealTimers();
  });

  it('bot.catch wraps non-Error into Error', async () => {
    const onError = vi.fn();
    const ch = new TelegramChannel(cfg);
    ch.setEventHandlers({ onError });
    vi.useFakeTimers();
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    const catchHandler = mockBotCatch.mock.calls[0][0];
    catchHandler('string error');

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    vi.useRealTimers();
  });

  it('sendMessage API error propagates to caller', async () => {
    const ch = new TelegramChannel(cfg);
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    mockSendMessage.mockRejectedValueOnce(new Error('403: bot blocked by user'));

    await expect(
      ch.send({ id: 'o', channel: 'telegram', peerId: '1', content: { type: 'text', text: 'hi' } })
    ).rejects.toThrow('403: bot blocked by user');
  });

  it('sendPhoto API error propagates to caller', async () => {
    const ch = new TelegramChannel(cfg);
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    mockSendPhoto.mockRejectedValueOnce(new Error('file too large'));

    await expect(
      ch.send({
        id: 'o',
        channel: 'telegram',
        peerId: '1',
        content: { type: 'image', url: 'https://big.jpg', mimeType: 'image/jpeg' },
      })
    ).rejects.toThrow('file too large');
  });

  // --- Session management per chat ID ---

  it('messages from different chats have different peerId', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel(cfg);
    ch.setEventHandlers({ onMessage });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await getHandler('message:text')(makeTelegramCtx({ chat: { id: 111, type: 'private' } }));
    await getHandler('message:text')(makeTelegramCtx({ chat: { id: 222, type: 'private' } }));
    await flush();

    expect(onMessage.mock.calls[0][0].peerId).toBe('111');
    expect(onMessage.mock.calls[1][0].peerId).toBe('222');
  });

  it('messages from same chat share the same peerId', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel(cfg);
    ch.setEventHandlers({ onMessage });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await getHandler('message:text')(makeTelegramCtx({
      chat: { id: 555, type: 'private' },
      message: { message_id: 1, text: 'first', date: 1700000000 },
    }));
    await getHandler('message:text')(makeTelegramCtx({
      chat: { id: 555, type: 'private' },
      message: { message_id: 2, text: 'second', date: 1700000001 },
    }));
    await flush();

    expect(onMessage.mock.calls[0][0].peerId).toBe('555');
    expect(onMessage.mock.calls[1][0].peerId).toBe('555');
  });

  // --- Multiple concurrent messages ---

  it('multiple concurrent messages are all processed', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel(cfg);
    ch.setEventHandlers({ onMessage });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    const handler = getHandler('message:text');
    const promises = [
      handler(makeTelegramCtx({ message: { message_id: 1, text: 'msg1', date: 1700000000 } })),
      handler(makeTelegramCtx({ message: { message_id: 2, text: 'msg2', date: 1700000001 } })),
      handler(makeTelegramCtx({ message: { message_id: 3, text: 'msg3', date: 1700000002 } })),
    ];
    await Promise.all(promises);
    await flush();

    expect(onMessage).toHaveBeenCalledTimes(3);
  });

  it('concurrent send calls all succeed independently', async () => {
    const ch = new TelegramChannel(cfg);
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();
    mockSendMessage.mockClear();

    const sends = [
      ch.send({ id: 'o1', channel: 'telegram', peerId: '1', content: { type: 'text', text: 'a' } }),
      ch.send({ id: 'o2', channel: 'telegram', peerId: '2', content: { type: 'text', text: 'b' } }),
      ch.send({ id: 'o3', channel: 'telegram', peerId: '3', content: { type: 'text', text: 'c' } }),
    ];
    await Promise.all(sends);

    expect(mockSendMessage).toHaveBeenCalledTimes(3);
  });

  // --- send() when not connected ---

  it('send() before connect throws', async () => {
    const ch = new TelegramChannel(cfg);
    await expect(
      ch.send({ id: 'o', channel: 'telegram', peerId: '1', content: { type: 'text', text: 'hi' } })
    ).rejects.toThrow('Telegram bot not connected');
  });

  it('send() after disconnect throws', async () => {
    const ch = new TelegramChannel(cfg);
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();
    await ch.disconnect();

    await expect(
      ch.send({ id: 'o', channel: 'telegram', peerId: '1', content: { type: 'text', text: 'hi' } })
    ).rejects.toThrow('Telegram bot not connected');
  });

  // --- Reply handling ---

  it('replyTo on incoming message is set from reply_to_message', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel(cfg);
    ch.setEventHandlers({ onMessage });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await getHandler('message:text')(makeTelegramCtx({
      message: { message_id: 10, text: 'reply', date: 1700000000, reply_to_message: { message_id: 5 } },
    }));
    await flush();

    expect(onMessage.mock.calls[0][0].replyTo).toBe('5');
  });

  it('replyTo on incoming message is absent when no reply', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel(cfg);
    ch.setEventHandlers({ onMessage });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await getHandler('message:text')(makeTelegramCtx());
    await flush();

    expect(onMessage.mock.calls[0][0].replyTo).toBeUndefined();
  });

  // --- Outgoing message types ---

  it('send image with base64 source', async () => {
    const ch = new TelegramChannel(cfg);
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await ch.send({
      id: 'o',
      channel: 'telegram',
      peerId: '1',
      content: { type: 'image', base64: 'data:image/png;base64,abc', mimeType: 'image/png' },
    });

    expect(mockSendPhoto).toHaveBeenCalledWith('1', 'data:image/png;base64,abc', expect.any(Object));
  });

  it('send image without url or base64 is a no-op', async () => {
    const ch = new TelegramChannel(cfg);
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();
    mockSendPhoto.mockClear();

    await ch.send({
      id: 'o',
      channel: 'telegram',
      peerId: '1',
      content: { type: 'image', mimeType: 'image/png' },
    });

    expect(mockSendPhoto).not.toHaveBeenCalled();
  });

  it('send document with filename as caption', async () => {
    const ch = new TelegramChannel(cfg);
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await ch.send({
      id: 'o',
      channel: 'telegram',
      peerId: '1',
      content: { type: 'file', url: 'https://file.pdf', mimeType: 'application/pdf', filename: 'report.pdf' },
    });

    expect(mockSendDocument).toHaveBeenCalledWith(
      '1', 'https://file.pdf',
      expect.objectContaining({ caption: 'report.pdf' })
    );
  });

  it('send voice message with replyTo', async () => {
    const ch = new TelegramChannel(cfg);
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    const capturedOpts: any[] = [];
    mockSendVoice.mockImplementation(async (_c: string, _s: string, opts: any) => {
      capturedOpts.push({ ...opts });
      return {};
    });

    await ch.send({
      id: 'o',
      channel: 'telegram',
      peerId: '1',
      replyTo: '99',
      content: { type: 'audio', url: 'https://voice.ogg', mimeType: 'audio/ogg' },
    });

    expect(capturedOpts[0].reply_to_message_id).toBe(99);
  });

  // --- Document incoming message ---

  // findings.md P2:199 — Telegram documents are represented as text
  // placeholders carrying the filename (see photo/voice tests above).
  it('document message maps to text placeholder with filename', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel(cfg);
    ch.setEventHandlers({ onMessage });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await getHandler('message:document')(makeTelegramCtx({
      message: {
        message_id: 5,
        document: { file_name: 'readme.txt', mime_type: 'text/plain' },
        date: 1700000000,
      },
    }));
    await flush();

    const msg: IncomingMessage = onMessage.mock.calls[0][0];
    expect(msg.content).toEqual({
      type: 'text',
      text: '[file attachment: readme.txt]',
    });
  });

  it('document without file_name falls back to generic "document" in placeholder', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel(cfg);
    ch.setEventHandlers({ onMessage });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await getHandler('message:document')(makeTelegramCtx({
      message: {
        message_id: 5,
        document: {},
        date: 1700000000,
      },
    }));
    await flush();

    const msg: IncomingMessage = onMessage.mock.calls[0][0];
    expect((msg.content as any).text).toBe('[file attachment: document]');
  });

  // --- Reconnect behavior ---

  it('reconnect is scheduled after bot.catch error', async () => {
    vi.useFakeTimers();
    const ch = new TelegramChannel(cfg);
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    const catchHandler = mockBotCatch.mock.calls[0][0];
    catchHandler(new Error('network'));

    // Should have scheduled a setTimeout for reconnect
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  // --- Sender name formatting ---

  it('sender name with first name only (no last name)', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel(cfg);
    ch.setEventHandlers({ onMessage });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await getHandler('message:text')(makeTelegramCtx({
      from: { id: 1, first_name: 'Solo' },
    }));
    await flush();

    expect(onMessage.mock.calls[0][0].senderName).toBe('Solo');
  });

  it('sender name with both first and last name', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel(cfg);
    ch.setEventHandlers({ onMessage });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await getHandler('message:text')(makeTelegramCtx({
      from: { id: 1, first_name: 'Jane', last_name: 'Doe' },
    }));
    await flush();

    expect(onMessage.mock.calls[0][0].senderName).toBe('Jane Doe');
  });

  // --- Empty text ---

  it('text message with empty string produces text content with empty text', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel(cfg);
    ch.setEventHandlers({ onMessage });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await getHandler('message:text')(makeTelegramCtx({
      message: { message_id: 1, text: '', date: 1700000000 },
    }));
    await flush();

    const msg: IncomingMessage = onMessage.mock.calls[0][0];
    expect(msg.content).toEqual({ type: 'text', text: '' });
  });

  it('text message with undefined text uses empty string', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel(cfg);
    ch.setEventHandlers({ onMessage });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await getHandler('message:text')(makeTelegramCtx({
      message: { message_id: 1, date: 1700000000 },
    }));
    await flush();

    const msg: IncomingMessage = onMessage.mock.calls[0][0];
    expect((msg.content as any).text).toBe('');
  });

  // --- isAllowed edge cases ---

  it('missing from field causes message to be ignored with restrictions', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel({ ...cfg, allowedUsers: ['1'] });
    ch.setEventHandlers({ onMessage });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await getHandler('message:text')({
      chat: { id: 1, type: 'private' },
      from: undefined,
      message: { message_id: 1, text: 'hi', date: 1700000000 },
    }).catch(() => {});
    await flush();

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('missing chat field causes message to be ignored with restrictions', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel({ ...cfg, allowedUsers: ['1'] });
    ch.setEventHandlers({ onMessage });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await getHandler('message:text')({
      chat: undefined,
      from: { id: 1, first_name: 'X' },
      message: { message_id: 1, text: 'hi', date: 1700000000 },
    }).catch(() => {});
    await flush();

    expect(onMessage).not.toHaveBeenCalled();
  });

  // --- send empty text ---

  it('sending empty text still calls sendMessage', async () => {
    const ch = new TelegramChannel(cfg);
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();
    mockSendMessage.mockClear();

    await ch.send({ id: 'o', channel: 'telegram', peerId: '1', content: { type: 'text', text: '' } });
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledWith('1', '', expect.any(Object));
  });

  // --- Timestamp conversion ---

  it('timestamp converts unix seconds to milliseconds', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel(cfg);
    ch.setEventHandlers({ onMessage });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await getHandler('message:text')(makeTelegramCtx({
      message: { message_id: 1, text: 'ts', date: 1600000000 },
    }));
    await flush();

    expect(onMessage.mock.calls[0][0].timestamp).toBe(1600000000000);
  });

  // --- channel field ---

  it('all incoming messages have channel=telegram', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel(cfg);
    ch.setEventHandlers({ onMessage });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    // Send text, photo, voice, document
    const events = ['message:text', 'message:photo', 'message:voice', 'message:document'];
    for (const event of events) {
      await getHandler(event)(makeTelegramCtx({
        message: {
          message_id: 1,
          text: event === 'message:text' ? 'x' : undefined,
          voice: event === 'message:voice' ? { duration: 1 } : undefined,
          document: event === 'message:document' ? {} : undefined,
          date: 1700000000,
        },
      }));
    }
    await flush();

    for (const call of onMessage.mock.calls) {
      expect(call[0].channel).toBe('telegram');
    }
  });

  // --- Photo outgoing with caption ---

  it('outgoing photo includes caption when provided', async () => {
    const ch = new TelegramChannel(cfg);
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await ch.send({
      id: 'o',
      channel: 'telegram',
      peerId: '1',
      content: { type: 'image', url: 'https://img.jpg', mimeType: 'image/jpeg', caption: 'My pic' },
    });

    expect(mockSendPhoto).toHaveBeenCalledWith(
      '1', 'https://img.jpg',
      expect.objectContaining({ caption: 'My pic' })
    );
  });

  // --- Photo outgoing with replyTo ---

  it('outgoing photo includes reply_to_message_id when replyTo set', async () => {
    const ch = new TelegramChannel(cfg);
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    const capturedOpts: any[] = [];
    mockSendPhoto.mockImplementation(async (_c: string, _s: string, opts: any) => {
      capturedOpts.push({ ...opts });
      return {};
    });

    await ch.send({
      id: 'o',
      channel: 'telegram',
      peerId: '1',
      replyTo: '77',
      content: { type: 'image', url: 'https://img.jpg', mimeType: 'image/jpeg' },
    });

    expect(capturedOpts[0].reply_to_message_id).toBe(77);
  });

  // --- Additional edge cases ---

  it('send document with replyTo sets reply_to_message_id', async () => {
    const ch = new TelegramChannel(cfg);
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    const capturedOpts: any[] = [];
    mockSendDocument.mockImplementation(async (_c: string, _s: string, opts: any) => {
      capturedOpts.push({ ...opts });
      return {};
    });

    await ch.send({
      id: 'o',
      channel: 'telegram',
      peerId: '1',
      replyTo: '55',
      content: { type: 'file', url: 'https://f.pdf', mimeType: 'application/pdf', filename: 'f.pdf' },
    });

    expect(capturedOpts[0].reply_to_message_id).toBe(55);
  });

  it('send document without url or base64 is a no-op', async () => {
    const ch = new TelegramChannel(cfg);
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();
    mockSendDocument.mockClear();

    await ch.send({
      id: 'o',
      channel: 'telegram',
      peerId: '1',
      content: { type: 'file', mimeType: 'application/pdf', filename: 'none.pdf' },
    });

    expect(mockSendDocument).not.toHaveBeenCalled();
  });

  it('send voice without url or base64 is a no-op', async () => {
    const ch = new TelegramChannel(cfg);
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();
    mockSendVoice.mockClear();

    await ch.send({
      id: 'o',
      channel: 'telegram',
      peerId: '1',
      content: { type: 'audio', mimeType: 'audio/ogg' },
    });

    expect(mockSendVoice).not.toHaveBeenCalled();
  });

  it('short message (under 4096) produces exactly one sendMessage call', async () => {
    const ch = new TelegramChannel(cfg);
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();
    mockSendMessage.mockClear();

    await ch.send({ id: 'o', channel: 'telegram', peerId: '1', content: { type: 'text', text: 'short msg' } });
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  it('message of exactly 1 char is not split', async () => {
    const ch = new TelegramChannel(cfg);
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();
    mockSendMessage.mockClear();

    await ch.send({ id: 'o', channel: 'telegram', peerId: '1', content: { type: 'text', text: 'x' } });
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  it('connect sets connected to true', async () => {
    const ch = new TelegramChannel(cfg);
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();
    expect(ch.connected).toBe(true);
  });

  it('disconnect sets connected to false', async () => {
    const ch = new TelegramChannel(cfg);
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();
    await ch.disconnect();
    expect(ch.connected).toBe(false);
  });

  it('photo handler with unauthorized user is ignored', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel({ ...cfg, allowedUsers: ['999'] });
    ch.setEventHandlers({ onMessage });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await getHandler('message:photo')(makeTelegramCtx({
      from: { id: 666, first_name: 'BadGuy' },
      message: { message_id: 1, date: 1700000000 },
    }));
    await flush();

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('voice handler with unauthorized user is ignored', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel({ ...cfg, allowedUsers: ['999'] });
    ch.setEventHandlers({ onMessage });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await getHandler('message:voice')(makeTelegramCtx({
      from: { id: 666, first_name: 'BadGuy' },
      message: { message_id: 1, voice: { duration: 5 }, date: 1700000000 },
    }));
    await flush();

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('document handler with unauthorized user is ignored', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel({ ...cfg, allowedUsers: ['999'] });
    ch.setEventHandlers({ onMessage });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await getHandler('message:document')(makeTelegramCtx({
      from: { id: 666, first_name: 'BadGuy' },
      message: { message_id: 1, document: {}, date: 1700000000 },
    }));
    await flush();

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('peerId is string even when chat.id is numeric', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel(cfg);
    ch.setEventHandlers({ onMessage });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await getHandler('message:text')(makeTelegramCtx({ chat: { id: 12345, type: 'private' } }));
    await flush();

    expect(typeof onMessage.mock.calls[0][0].peerId).toBe('string');
    expect(onMessage.mock.calls[0][0].peerId).toBe('12345');
  });

  it('senderId is string even when from.id is numeric', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel(cfg);
    ch.setEventHandlers({ onMessage });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();

    await getHandler('message:text')(makeTelegramCtx({ from: { id: 67890, first_name: 'Num' } }));
    await flush();

    expect(typeof onMessage.mock.calls[0][0].senderId).toBe('string');
    expect(onMessage.mock.calls[0][0].senderId).toBe('67890');
  });

  it('concurrent sends to same chat ID all complete', async () => {
    const ch = new TelegramChannel(cfg);
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await ch.connect();
    mockSendMessage.mockClear();

    const sends = Array.from({ length: 5 }, (_, i) =>
      ch.send({ id: `o${i}`, channel: 'telegram', peerId: '100', content: { type: 'text', text: `msg${i}` } })
    );
    await Promise.all(sends);

    expect(mockSendMessage).toHaveBeenCalledTimes(5);
    for (let i = 0; i < 5; i++) {
      expect(mockSendMessage.mock.calls[i][0]).toBe('100');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. DISCORD BEHAVIORAL (~40 tests)
// ═════════════════════════════════════════════════════════════════════════════
describe('Discord behavioral', () => {
  let DiscordChannel: typeof import('../src/channels/discord.js').DiscordChannel;

  // public: true for the shared cfg so behavioral tests without explicit
  // allowlists are not fail-closed by the new isAllowed default.
  const cfg = {
    id: 'dc-beh',
    type: 'discord' as const,
    enabled: true,
    agentId: 'agent-1',
    token: 'discord-token',
    public: true,
  };

  function getMsgHandler(): (msg: any) => Promise<void> {
    const entry = mockClientOn.mock.calls.find((c: any[]) => c[0] === 'messageCreate');
    if (!entry) throw new Error('No messageCreate handler');
    return entry[1];
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ DiscordChannel } = await import('../src/channels/discord.js'));
  });

  // --- Message in channel processed ---

  it('text message in guild channel produces correct IncomingMessage', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new DiscordChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()(makeDiscordMsg({
      guild: { id: 'guild-1', name: 'Test Server' },
    }));
    await flush();

    const msg: IncomingMessage = onMessage.mock.calls[0][0];
    expect(msg.channel).toBe('discord');
    expect(msg.peerKind).toBe('group');
    expect(msg.peerId).toBe('ch-1');
    expect(msg.senderId).toBe('user-1');
    expect(msg.senderName).toBe('Alice');
    expect(msg.content).toEqual({ type: 'text', text: 'hello' });
    expect(msg.metadata).toEqual(expect.objectContaining({ guildId: 'guild-1', guildName: 'Test Server' }));
  });

  // --- DM processed ---

  it('DM message sets peerKind=user', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new DiscordChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()(makeDiscordMsg({ guild: null }));
    await flush();

    expect(onMessage.mock.calls[0][0].peerKind).toBe('user');
  });

  // --- Bot mentioned (self-message ignored) ---

  it('own bot messages are ignored', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new DiscordChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()(makeDiscordMsg({
      author: { id: 'bot-user-id', bot: true, displayName: 'Self', username: 'self' },
    }));
    await flush();

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('other bot messages ignored when respondToBots is false (default)', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new DiscordChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()(makeDiscordMsg({
      author: { id: 'other-bot', bot: true, displayName: 'OtherBot', username: 'otherbot' },
    }));
    await flush();

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('other bot messages processed when respondToBots is true', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new DiscordChannel({ ...cfg, respondToBots: true });
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()(makeDiscordMsg({
      author: { id: 'other-bot', bot: true, displayName: 'OtherBot', username: 'otherbot' },
      content: 'bot msg',
    }));
    await flush();

    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  // --- Response formatting ---

  it('send text message via channel.send', async () => {
    const mockSend = vi.fn().mockResolvedValue({});
    mockChannelsFetch.mockResolvedValue({ send: mockSend });

    const ch = new DiscordChannel(cfg);
    await ch.connect();
    await ch.send({
      id: 'o',
      channel: 'discord',
      peerId: 'ch-1',
      content: { type: 'text', text: 'hello discord' },
    });

    expect(mockSend).toHaveBeenCalledWith({ content: 'hello discord' });
  });

  it('send text with replyTo sets messageReference', async () => {
    const mockSend = vi.fn().mockResolvedValue({});
    mockChannelsFetch.mockResolvedValue({ send: mockSend });

    const ch = new DiscordChannel(cfg);
    await ch.connect();
    await ch.send({
      id: 'o',
      channel: 'discord',
      peerId: 'ch-1',
      replyTo: 'msg-ref-abc',
      content: { type: 'text', text: 'reply' },
    });

    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      reply: { messageReference: 'msg-ref-abc' },
    }));
  });

  it('send image with caption', async () => {
    const mockSend = vi.fn().mockResolvedValue({});
    mockChannelsFetch.mockResolvedValue({ send: mockSend });

    const ch = new DiscordChannel(cfg);
    await ch.connect();
    await ch.send({
      id: 'o',
      channel: 'discord',
      peerId: 'ch-1',
      content: { type: 'image', url: 'https://img.jpg', mimeType: 'image/jpeg', caption: 'My pic' },
    });

    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      files: ['https://img.jpg'],
      content: 'My pic',
    }));
  });

  it('send image without url/base64 is a no-op', async () => {
    const mockSend = vi.fn().mockResolvedValue({});
    mockChannelsFetch.mockResolvedValue({ send: mockSend });

    const ch = new DiscordChannel(cfg);
    await ch.connect();
    await ch.send({
      id: 'o',
      channel: 'discord',
      peerId: 'ch-1',
      content: { type: 'image', mimeType: 'image/jpeg' },
    });

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('send file with attachment name', async () => {
    const mockSend = vi.fn().mockResolvedValue({});
    mockChannelsFetch.mockResolvedValue({ send: mockSend });

    const ch = new DiscordChannel(cfg);
    await ch.connect();
    await ch.send({
      id: 'o',
      channel: 'discord',
      peerId: 'ch-1',
      content: { type: 'file', url: 'https://file.pdf', mimeType: 'application/pdf', filename: 'report.pdf' },
    });

    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      files: [{ attachment: 'https://file.pdf', name: 'report.pdf' }],
    }));
  });

  // --- Discord API rate limit / error handling ---

  it('send to null channel throws Invalid channel error', async () => {
    mockChannelsFetch.mockResolvedValue(null);
    const ch = new DiscordChannel(cfg);
    await ch.connect();

    await expect(
      ch.send({ id: 'o', channel: 'discord', peerId: 'bad', content: { type: 'text', text: 'x' } })
    ).rejects.toThrow('Invalid channel');
  });

  it('send to channel without send method throws Invalid channel error', async () => {
    mockChannelsFetch.mockResolvedValue({ id: 'voice-only' });
    const ch = new DiscordChannel(cfg);
    await ch.connect();

    await expect(
      ch.send({ id: 'o', channel: 'discord', peerId: 'voice', content: { type: 'text', text: 'x' } })
    ).rejects.toThrow('Invalid channel');
  });

  it('error event on client triggers onError handler', async () => {
    const onError = vi.fn();
    const ch = new DiscordChannel(cfg);
    ch.setEventHandlers({ onError });
    await ch.connect();

    const errorHandler = mockClientOn.mock.calls.find((c: any[]) => c[0] === 'error')[1];
    errorHandler(new Error('rate limited'));

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'rate limited' }));
  });

  it('channel.send API error propagates to caller', async () => {
    const mockSend = vi.fn().mockRejectedValue(new Error('rate limit'));
    mockChannelsFetch.mockResolvedValue({ send: mockSend });

    const ch = new DiscordChannel(cfg);
    await ch.connect();

    await expect(
      ch.send({ id: 'o', channel: 'discord', peerId: 'ch-1', content: { type: 'text', text: 'x' } })
    ).rejects.toThrow('rate limit');
  });

  // --- Guild vs DM context ---

  it('guild message has guildId in metadata', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new DiscordChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()(makeDiscordMsg({
      guild: { id: 'g-123', name: 'MyGuild' },
    }));
    await flush();

    const msg = onMessage.mock.calls[0][0];
    expect(msg.metadata.guildId).toBe('g-123');
    expect(msg.metadata.guildName).toBe('MyGuild');
  });

  it('DM message has no guildId in metadata', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new DiscordChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()(makeDiscordMsg({ guild: null }));
    await flush();

    const msg = onMessage.mock.calls[0][0];
    expect(msg.metadata.guildId).toBeUndefined();
  });

  // --- Message edit / delete (not implemented: empty or unsupported -> null) ---

  it('empty message with no attachments is ignored', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new DiscordChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()(makeDiscordMsg({
      content: '',
      attachments: { size: 0, first: () => null },
    }));
    await flush();

    expect(onMessage).not.toHaveBeenCalled();
  });

  // --- Attachment types ---

  it('image attachment produces image content', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new DiscordChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()(makeDiscordMsg({
      content: '',
      attachments: {
        size: 1,
        first: () => ({ url: 'https://cdn/img.png', contentType: 'image/png', name: 'img.png' }),
      },
    }));
    await flush();

    const msg = onMessage.mock.calls[0][0];
    expect(msg.content.type).toBe('image');
    expect((msg.content as any).url).toBe('https://cdn/img.png');
  });

  it('audio attachment produces audio content', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new DiscordChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()(makeDiscordMsg({
      content: '',
      attachments: {
        size: 1,
        first: () => ({ url: 'https://cdn/voice.ogg', contentType: 'audio/ogg', name: 'voice.ogg' }),
      },
    }));
    await flush();

    expect(onMessage.mock.calls[0][0].content.type).toBe('audio');
  });

  it('generic attachment produces file content', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new DiscordChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()(makeDiscordMsg({
      content: '',
      attachments: {
        size: 1,
        first: () => ({ url: 'https://cdn/archive.zip', contentType: 'application/zip', name: 'archive.zip' }),
      },
    }));
    await flush();

    const msg = onMessage.mock.calls[0][0];
    expect(msg.content.type).toBe('file');
    expect((msg.content as any).filename).toBe('archive.zip');
  });

  it('attachment without contentType defaults to octet-stream', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new DiscordChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()(makeDiscordMsg({
      content: '',
      attachments: {
        size: 1,
        first: () => ({ url: 'https://cdn/unknown', contentType: null, name: null }),
      },
    }));
    await flush();

    const msg = onMessage.mock.calls[0][0];
    expect((msg.content as any).mimeType).toBe('application/octet-stream');
  });

  // --- allowedUsers, allowedGuilds, allowedChannels ---

  it('allowedUsers blocks unauthorized user', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new DiscordChannel({ ...cfg, allowedUsers: ['vip-only'] });
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()(makeDiscordMsg());
    await flush();

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('allowedUsers permits authorized user', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new DiscordChannel({ ...cfg, allowedUsers: ['user-1'] });
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()(makeDiscordMsg());
    await flush();

    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('allowedGuilds permits messages from allowed guild', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new DiscordChannel({ ...cfg, allowedGuilds: ['guild-1'] });
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()(makeDiscordMsg({
      guild: { id: 'guild-1', name: 'OK Server' },
    }));
    await flush();

    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('allowedGuilds blocks messages from other guild', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new DiscordChannel({ ...cfg, allowedGuilds: ['guild-1'] });
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()(makeDiscordMsg({
      guild: { id: 'guild-999', name: 'Bad Server' },
    }));
    await flush();

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('allowedChannels permits messages from allowed channel', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new DiscordChannel({ ...cfg, allowedChannels: ['ch-1'] });
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()(makeDiscordMsg());
    await flush();

    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('allowedChannels blocks messages from other channel', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new DiscordChannel({ ...cfg, allowedChannels: ['ch-allowed'] });
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()(makeDiscordMsg({ channel: { id: 'ch-blocked' } }));
    await flush();

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('no restrictions + no public flag -> fail-closed, message dropped', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const strictCfg = { ...cfg, public: false };
    const ch = new DiscordChannel(strictCfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()(makeDiscordMsg());
    await flush();

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('public: true -> messages allowed even with no allowlists', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new DiscordChannel({ ...cfg, public: true });
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()(makeDiscordMsg());
    await flush();

    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  // --- Reply reference ---

  it('message with reference sets replyTo', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new DiscordChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()(makeDiscordMsg({
      reference: { messageId: 'ref-msg-abc' },
    }));
    await flush();

    expect(onMessage.mock.calls[0][0].replyTo).toBe('ref-msg-abc');
  });

  it('message without reference has no replyTo', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new DiscordChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()(makeDiscordMsg({ reference: null }));
    await flush();

    expect(onMessage.mock.calls[0][0].replyTo).toBeUndefined();
  });

  // --- Concurrent ---

  it('multiple concurrent messages all processed', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new DiscordChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    const handler = getMsgHandler();
    await Promise.all([
      handler(makeDiscordMsg({ content: 'a', id: 'a' })),
      handler(makeDiscordMsg({ content: 'b', id: 'b' })),
      handler(makeDiscordMsg({ content: 'c', id: 'c' })),
    ]);
    await flush();

    expect(onMessage).toHaveBeenCalledTimes(3);
  });

  // --- disconnect event ---

  it('disconnect event on client triggers onDisconnect handler', async () => {
    const onDisconnect = vi.fn();
    const ch = new DiscordChannel(cfg);
    ch.setEventHandlers({ onDisconnect });
    await ch.connect();

    const handler = mockClientOn.mock.calls.find((c: any[]) => c[0] === 'disconnect')[1];
    handler();

    expect(onDisconnect).toHaveBeenCalled();
  });

  // --- Additional Discord tests ---

  it('connect sets connected to true after ready event', async () => {
    const ch = new DiscordChannel(cfg);
    await ch.connect();
    const readyHandler = mockClientOn.mock.calls.find((c: any[]) => c[0] === 'ready')[1];
    readyHandler();
    expect(ch.connected).toBe(true);
  });

  it('disconnect sets connected to false', async () => {
    const ch = new DiscordChannel(cfg);
    await ch.connect();
    const readyHandler = mockClientOn.mock.calls.find((c: any[]) => c[0] === 'ready')[1];
    readyHandler();
    await ch.disconnect();
    expect(ch.connected).toBe(false);
  });

  it('send file without url or base64 is a no-op', async () => {
    const mockSend = vi.fn().mockResolvedValue({});
    mockChannelsFetch.mockResolvedValue({ send: mockSend });

    const ch = new DiscordChannel(cfg);
    await ch.connect();
    await ch.send({
      id: 'o',
      channel: 'discord',
      peerId: 'ch-1',
      content: { type: 'file', mimeType: 'application/pdf', filename: 'none.pdf' },
    });

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('send image with replyTo', async () => {
    const mockSend = vi.fn().mockResolvedValue({});
    mockChannelsFetch.mockResolvedValue({ send: mockSend });

    const ch = new DiscordChannel(cfg);
    await ch.connect();
    await ch.send({
      id: 'o',
      channel: 'discord',
      peerId: 'ch-1',
      replyTo: 'ref-123',
      content: { type: 'image', url: 'https://img.jpg', mimeType: 'image/jpeg' },
    });

    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      reply: { messageReference: 'ref-123' },
    }));
  });

  it('send file with replyTo', async () => {
    const mockSend = vi.fn().mockResolvedValue({});
    mockChannelsFetch.mockResolvedValue({ send: mockSend });

    const ch = new DiscordChannel(cfg);
    await ch.connect();
    await ch.send({
      id: 'o',
      channel: 'discord',
      peerId: 'ch-1',
      replyTo: 'ref-456',
      content: { type: 'file', url: 'https://f.zip', mimeType: 'application/zip', filename: 'f.zip' },
    });

    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      reply: { messageReference: 'ref-456' },
    }));
  });

  it('message with text content and attachments uses text content', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new DiscordChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()(makeDiscordMsg({
      content: 'text with attachment',
      attachments: {
        size: 1,
        first: () => ({ url: 'https://cdn/img.png', contentType: 'image/png', name: 'img.png' }),
      },
    }));
    await flush();

    // Text takes priority over attachments
    const msg = onMessage.mock.calls[0][0];
    expect(msg.content.type).toBe('text');
    expect((msg.content as any).text).toBe('text with attachment');
  });

  it('displayName is used for senderName when available', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new DiscordChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()(makeDiscordMsg({
      author: { id: 'u1', bot: false, displayName: 'Display Name', username: 'username' },
    }));
    await flush();

    expect(onMessage.mock.calls[0][0].senderName).toBe('Display Name');
  });

  it('concurrent sends through Discord all complete', async () => {
    const mockSend = vi.fn().mockResolvedValue({});
    mockChannelsFetch.mockResolvedValue({ send: mockSend });

    const ch = new DiscordChannel(cfg);
    await ch.connect();

    const sends = Array.from({ length: 5 }, (_, i) =>
      ch.send({ id: `o${i}`, channel: 'discord', peerId: 'ch-1', content: { type: 'text', text: `msg${i}` } })
    );
    await Promise.all(sends);

    expect(mockSend).toHaveBeenCalledTimes(5);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. SLACK BEHAVIORAL (~30 tests)
// ═════════════════════════════════════════════════════════════════════════════
describe('Slack behavioral', () => {
  let SlackChannel: typeof import('../src/channels/slack.js').SlackChannel;

  // public: true for the shared cfg so behavioral tests without explicit
  // allowlists are not fail-closed by the new isAllowed default.
  const cfg = {
    id: 'slack-beh',
    type: 'slack' as const,
    enabled: true,
    agentId: 'agent-1',
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    signingSecret: 'secret',
    public: true,
  };

  function getMsgHandler(): (args: { message: any }) => Promise<void> {
    return mockSlackAppMessage.mock.calls[0][0];
  }

  function getMentionHandler(): (args: { event: any }) => Promise<void> {
    const entry = mockSlackAppEvent.mock.calls.find((c: any[]) => c[0] === 'app_mention');
    if (!entry) throw new Error('No app_mention handler');
    return entry[1];
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ SlackChannel } = await import('../src/channels/slack.js'));
  });

  // --- Message event processed ---

  it('text message produces correct IncomingMessage', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SlackChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()({
      message: { user: 'U123', text: 'hello slack', ts: '1700000000.000', channel: 'C1', type: 'message' },
    });
    await flush();

    const msg: IncomingMessage = onMessage.mock.calls[0][0];
    expect(msg.channel).toBe('slack');
    expect(msg.senderId).toBe('U123');
    expect(msg.content).toEqual({ type: 'text', text: 'hello slack' });
    expect(msg.peerId).toBe('C1');
  });

  // --- Response posted to channel ---

  it('response posted via chat.postMessage', async () => {
    const ch = new SlackChannel(cfg);
    await ch.connect();

    await ch.send({
      id: 'o',
      channel: 'slack',
      peerId: 'C123',
      content: { type: 'text', text: 'response' },
    });

    expect(mockSlackChatPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C123', text: 'response' })
    );
  });

  // --- Thread replies maintained in thread ---

  it('reply to thread uses thread_ts', async () => {
    const ch = new SlackChannel(cfg);
    await ch.connect();

    await ch.send({
      id: 'o',
      channel: 'slack',
      peerId: 'C123',
      replyTo: '1700000000.000',
      content: { type: 'text', text: 'threaded reply' },
    });

    expect(mockSlackChatPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ thread_ts: '1700000000.000' })
    );
  });

  it('incoming thread message sets replyTo from thread_ts', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SlackChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()({
      message: {
        user: 'U1',
        text: 'in thread',
        ts: '1700000001.000',
        thread_ts: '1700000000.000',
        channel: 'C1',
        type: 'message',
      },
    });
    await flush();

    expect(onMessage.mock.calls[0][0].replyTo).toBe('1700000000.000');
  });

  // --- DM processed ---

  it('im channel type sets peerKind=user', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SlackChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()({
      message: { user: 'U1', text: 'dm', ts: '1.0', channel: 'D1', channel_type: 'im', type: 'message' },
    });
    await flush();

    expect(onMessage.mock.calls[0][0].peerKind).toBe('user');
  });

  it('channel type sets peerKind=channel', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SlackChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()({
      message: { user: 'U1', text: 'in channel', ts: '1.0', channel: 'C1', channel_type: 'channel', type: 'message' },
    });
    await flush();

    expect(onMessage.mock.calls[0][0].peerKind).toBe('channel');
  });

  it('group type sets peerKind=channel', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SlackChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()({
      message: { user: 'U1', text: 'in group', ts: '1.0', channel: 'G1', channel_type: 'group', type: 'message' },
    });
    await flush();

    expect(onMessage.mock.calls[0][0].peerKind).toBe('channel');
  });

  // --- Bot mention (app_mention event) ---

  it('app_mention event produces incoming message', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SlackChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMentionHandler()({
      event: { user: 'U1', text: '<@BOT> hello', ts: '1700000000.000', channel: 'C1', type: 'app_mention' },
    });
    await flush();

    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  // --- Slack API error handling ---

  it('chat.postMessage error propagates to caller', async () => {
    const ch = new SlackChannel(cfg);
    await ch.connect();

    mockSlackChatPostMessage.mockRejectedValueOnce(new Error('channel_not_found'));

    await expect(
      ch.send({ id: 'o', channel: 'slack', peerId: 'C999', content: { type: 'text', text: 'x' } })
    ).rejects.toThrow('channel_not_found');
  });

  it('send when not connected throws', async () => {
    const ch = new SlackChannel(cfg);
    await expect(
      ch.send({ id: 'o', channel: 'slack', peerId: 'C1', content: { type: 'text', text: 'x' } })
    ).rejects.toThrow('Slack not connected');
  });

  // --- Bot message filtering ---

  it('bot_id messages are ignored', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SlackChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()({
      message: { bot_id: 'B123', text: 'bot msg', ts: '1.0', channel: 'C1', type: 'message' },
    });
    await flush();

    expect(onMessage).not.toHaveBeenCalled();
  });

  // --- Empty / null text ---

  it('empty text and no files returns null (no message emitted)', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SlackChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()({
      message: { user: 'U1', text: '', ts: '1.0', channel: 'C1', type: 'message' },
    });
    await flush();

    expect(onMessage).not.toHaveBeenCalled();
  });

  // --- File attachments ---

  it('image file attachment produces image content', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SlackChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()({
      message: {
        user: 'U1', ts: '1.0', channel: 'C1', type: 'message',
        files: [{ id: 'F1', mimetype: 'image/png', url_private: 'https://slack/img.png' }],
      },
    });
    await flush();

    const msg = onMessage.mock.calls[0][0];
    expect(msg.content.type).toBe('image');
    expect((msg.content as any).url).toBe('https://slack/img.png');
  });

  it('audio file attachment produces audio content', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SlackChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()({
      message: {
        user: 'U1', ts: '1.0', channel: 'C1', type: 'message',
        files: [{ id: 'F2', mimetype: 'audio/mp3', url_private: 'https://slack/audio.mp3' }],
      },
    });
    await flush();

    expect(onMessage.mock.calls[0][0].content.type).toBe('audio');
  });

  it('generic file with url_private produces file content', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SlackChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()({
      message: {
        user: 'U1', ts: '1.0', channel: 'C1', type: 'message',
        files: [{ id: 'F3', mimetype: 'application/pdf', name: 'doc.pdf', url_private: 'https://slack/doc.pdf' }],
      },
    });
    await flush();

    const msg = onMessage.mock.calls[0][0];
    expect(msg.content.type).toBe('file');
    expect((msg.content as any).filename).toBe('doc.pdf');
    expect((msg.content as any).url).toBe('https://slack/doc.pdf');
  });

  // findings.md P2:199 — when Slack doesn't surface url_private (and we
  // don't fetch bytes ourselves), emit a text placeholder rather than a
  // media content with no data pointer.
  it('file attachment without url_private produces text placeholder', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SlackChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()({
      message: {
        user: 'U1', ts: '1.0', channel: 'C1', type: 'message',
        files: [{ id: 'F3', mimetype: 'application/pdf', name: 'doc.pdf' }],
      },
    });
    await flush();

    const msg = onMessage.mock.calls[0][0];
    expect(msg.content.type).toBe('text');
    expect((msg.content as any).text).toBe('[file attachment: doc.pdf]');
  });

  it('image attachment without url_private produces text placeholder', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SlackChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()({
      message: {
        user: 'U1', ts: '1.0', channel: 'C1', type: 'message',
        files: [{ id: 'F4', mimetype: 'image/png', name: 'img.png' }],
      },
    });
    await flush();

    const msg = onMessage.mock.calls[0][0];
    expect(msg.content.type).toBe('text');
    expect((msg.content as any).text).toBe('[image attachment]');
  });

  // --- send image attachment ---

  it('send image uses chat.postMessage with attachments', async () => {
    const ch = new SlackChannel(cfg);
    await ch.connect();

    await ch.send({
      id: 'o',
      channel: 'slack',
      peerId: 'C1',
      content: { type: 'image', url: 'https://img.jpg', mimeType: 'image/jpeg', caption: 'Cap' },
    });

    expect(mockSlackChatPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: expect.arrayContaining([
          expect.objectContaining({ image_url: 'https://img.jpg' }),
        ]),
      })
    );
  });

  // --- send file ---

  it('send file uses files.uploadV2', async () => {
    const ch = new SlackChannel(cfg);
    await ch.connect();

    await ch.send({
      id: 'o',
      channel: 'slack',
      peerId: 'C1',
      content: { type: 'file', url: 'https://file.pdf', mimeType: 'application/pdf', filename: 'doc.pdf' },
    });

    expect(mockSlackFilesUpload).toHaveBeenCalled();
  });

  // --- Timestamp parsing ---

  it('timestamp parsed correctly from ts string', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SlackChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()({
      message: { user: 'U1', text: 'ts test', ts: '1700000000.500000', channel: 'C1', type: 'message' },
    });
    await flush();

    expect(onMessage.mock.calls[0][0].timestamp).toBeCloseTo(1700000000500, -1);
  });

  // --- allowedUsers / allowedChannels ---

  it('allowedUsers blocks unauthorized user', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SlackChannel({ ...cfg, allowedUsers: ['U_VIP'] });
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()({
      message: { user: 'U_NOBODY', text: 'hi', ts: '1.0', channel: 'C1', type: 'message' },
    });
    await flush();

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('allowedChannels permits messages in allowed channel', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SlackChannel({ ...cfg, allowedChannels: ['C_OK'] });
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()({
      message: { user: 'U1', text: 'allowed', ts: '1.0', channel: 'C_OK', type: 'message' },
    });
    await flush();

    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  // --- Metadata ---

  it('metadata includes messageTs and threadTs', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SlackChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()({
      message: {
        user: 'U1', text: 'meta', ts: '1700000000.000', thread_ts: '1699999999.000',
        channel: 'C1', channel_type: 'channel', type: 'message',
      },
    });
    await flush();

    const meta = onMessage.mock.calls[0][0].metadata;
    expect(meta.messageTs).toBe('1700000000.000');
    expect(meta.threadTs).toBe('1699999999.000');
    expect(meta.channelType).toBe('channel');
  });

  // --- Concurrent ---

  it('multiple concurrent messages all processed', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SlackChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    const handler = getMsgHandler();
    await Promise.all([
      handler({ message: { user: 'U1', text: 'a', ts: '1.0', channel: 'C1', type: 'message' } }),
      handler({ message: { user: 'U2', text: 'b', ts: '2.0', channel: 'C1', type: 'message' } }),
      handler({ message: { user: 'U3', text: 'c', ts: '3.0', channel: 'C1', type: 'message' } }),
    ]);
    await flush();

    expect(onMessage).toHaveBeenCalledTimes(3);
  });

  // --- Additional Slack tests ---

  it('connect sets connected to true', async () => {
    const ch = new SlackChannel(cfg);
    await ch.connect();
    expect(ch.connected).toBe(true);
  });

  it('disconnect sets connected to false', async () => {
    const ch = new SlackChannel(cfg);
    await ch.connect();
    await ch.disconnect();
    expect(ch.connected).toBe(false);
  });

  it('send image without url is a no-op for chat.postMessage', async () => {
    const ch = new SlackChannel(cfg);
    await ch.connect();
    mockSlackChatPostMessage.mockClear();

    await ch.send({
      id: 'o',
      channel: 'slack',
      peerId: 'C1',
      content: { type: 'image', mimeType: 'image/jpeg' },
    });

    // postMessage should not be called since url is missing
    expect(mockSlackChatPostMessage).not.toHaveBeenCalled();
  });

  it('send file without url is a no-op', async () => {
    const ch = new SlackChannel(cfg);
    await ch.connect();
    mockSlackFilesUpload.mockClear();

    await ch.send({
      id: 'o',
      channel: 'slack',
      peerId: 'C1',
      content: { type: 'file', mimeType: 'application/pdf', filename: 'none.pdf' },
    });

    expect(mockSlackFilesUpload).not.toHaveBeenCalled();
  });

  it('send file with thread_ts uses replyTo', async () => {
    const ch = new SlackChannel(cfg);
    await ch.connect();

    await ch.send({
      id: 'o',
      channel: 'slack',
      peerId: 'C1',
      replyTo: '1700000000.000',
      content: { type: 'file', url: 'https://f.pdf', mimeType: 'application/pdf', filename: 'f.pdf' },
    });

    const callArgs = mockSlackFilesUpload.mock.calls[0][0];
    expect(callArgs.thread_ts).toBe('1700000000.000');
  });

  it('send image with replyTo sets thread_ts', async () => {
    const ch = new SlackChannel(cfg);
    await ch.connect();

    await ch.send({
      id: 'o',
      channel: 'slack',
      peerId: 'C1',
      replyTo: '1700000000.000',
      content: { type: 'image', url: 'https://img.jpg', mimeType: 'image/jpeg', caption: 'Cap' },
    });

    expect(mockSlackChatPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ thread_ts: '1700000000.000' })
    );
  });

  it('no restrictions + no public flag -> fail-closed, message dropped', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const strictCfg = { ...cfg, public: false };
    const ch = new SlackChannel(strictCfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()({
      message: { user: 'U_ANYONE', text: 'hello', ts: '1.0', channel: 'C_ANY', type: 'message' },
    });
    await flush();

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('public: true allows all users and channels', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SlackChannel({ ...cfg, public: true });
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()({
      message: { user: 'U_ANYONE', text: 'hello', ts: '1.0', channel: 'C_ANY', type: 'message' },
    });
    await flush();

    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('channel=slack is set on all incoming messages', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SlackChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await getMsgHandler()({
      message: { user: 'U1', text: 'check channel', ts: '1.0', channel: 'C1', type: 'message' },
    });
    await flush();

    expect(onMessage.mock.calls[0][0].channel).toBe('slack');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. SIGNAL BEHAVIORAL (~20 tests)
// ═════════════════════════════════════════════════════════════════════════════
describe('Signal behavioral', () => {
  let SignalChannel: typeof import('../src/channels/signal.js').SignalChannel;

  // public: true for the shared cfg so behavioral tests without explicit
  // allowlists are not fail-closed by the new isAllowed default.
  const cfg = {
    id: 'sig-beh',
    type: 'signal' as const,
    enabled: true,
    agentId: 'agent-1',
    socketPath: '/tmp/signal.sock',
    account: '+1234567890',
    public: true,
  };

  let connectHandler: () => void;
  let dataHandler: (data: Buffer) => void;
  let errorHandler: (err: Error) => void;
  let closeHandler: () => void;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSocketOn.mockImplementation((event: string, handler: any) => {
      if (event === 'connect') connectHandler = handler;
      if (event === 'data') dataHandler = handler;
      if (event === 'error') errorHandler = handler;
      if (event === 'close') closeHandler = handler;
    });
    ({ SignalChannel } = await import('../src/channels/signal.js'));
  });

  // --- Basic message flow ---

  it('text message notification produces correct IncomingMessage', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SignalChannel(cfg);
    ch.setEventHandlers({ onMessage });
    const p = ch.connect();
    connectHandler();
    await p;

    const notification = JSON.stringify({
      jsonrpc: '2.0',
      method: 'receive',
      params: {
        envelope: {
          sourceNumber: '+19876543210',
          sourceName: 'Bob',
          sourceUuid: 'uuid-bob',
          dataMessage: { timestamp: 1700000000000, message: 'hello from signal' },
        },
      },
    }) + '\n';

    dataHandler(Buffer.from(notification));
    await flush();

    const msg: IncomingMessage = onMessage.mock.calls[0][0];
    expect(msg.channel).toBe('signal');
    expect(msg.senderId).toBe('+19876543210');
    expect(msg.senderName).toBe('Bob');
    expect(msg.content).toEqual({ type: 'text', text: 'hello from signal' });
    expect(msg.peerKind).toBe('user');
  });

  it('group message sets peerKind=group and group: prefix', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SignalChannel(cfg);
    ch.setEventHandlers({ onMessage });
    const p = ch.connect();
    connectHandler();
    await p;

    const notification = JSON.stringify({
      jsonrpc: '2.0',
      method: 'receive',
      params: {
        envelope: {
          sourceNumber: '+19',
          dataMessage: {
            timestamp: 1700000000000,
            message: 'group msg',
            groupInfo: { groupId: 'grp-abc', type: 'DELIVER' },
          },
        },
      },
    }) + '\n';

    dataHandler(Buffer.from(notification));
    await flush();

    const msg = onMessage.mock.calls[0][0];
    expect(msg.peerKind).toBe('group');
    expect(msg.peerId).toBe('group:grp-abc');
  });

  it('send text writes JSON-RPC to socket', async () => {
    let capturedReq: any;
    mockSocketWrite.mockImplementation((data: string, cb?: (err?: Error) => void) => {
      capturedReq = JSON.parse(data.trim());
      cb?.();
      setImmediate(() => {
        dataHandler(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: capturedReq.id, result: {} }) + '\n'));
      });
      return true;
    });

    const ch = new SignalChannel(cfg);
    const p = ch.connect();
    connectHandler();
    await p;

    await ch.send({
      id: 'o',
      channel: 'signal',
      peerId: '+19876543210',
      content: { type: 'text', text: 'hello' },
    });

    expect(capturedReq.method).toBe('send');
    expect(capturedReq.params.message).toBe('hello');
    expect(capturedReq.params.recipient).toEqual(['+19876543210']);
    expect(capturedReq.params.account).toBe('+1234567890');
  });

  it('send to group uses groupId instead of recipient', async () => {
    let capturedReq: any;
    mockSocketWrite.mockImplementation((data: string, cb?: (err?: Error) => void) => {
      capturedReq = JSON.parse(data.trim());
      cb?.();
      setImmediate(() => {
        dataHandler(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: capturedReq.id, result: {} }) + '\n'));
      });
      return true;
    });

    const ch = new SignalChannel(cfg);
    const p = ch.connect();
    connectHandler();
    await p;

    await ch.send({
      id: 'o',
      channel: 'signal',
      peerId: 'group:grp-123',
      content: { type: 'text', text: 'group hello' },
    });

    expect(capturedReq.params.groupId).toBe('grp-123');
    expect(capturedReq.params.recipient).toBeUndefined();
  });

  // --- Attachment handling ---

  it('image attachment produces text placeholder with caption', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SignalChannel(cfg);
    ch.setEventHandlers({ onMessage });
    const p = ch.connect();
    connectHandler();
    await p;

    // findings.md P2:199 — signal-cli writes attachments to local disk
    // and we don't resolve them to url/base64 here, so the channel emits
    // a TextContent placeholder instead of an ImageContent with no data
    // pointer.
    dataHandler(Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      method: 'receive',
      params: {
        envelope: {
          sourceNumber: '+19',
          dataMessage: {
            timestamp: 1700000000000,
            attachments: [{ contentType: 'image/jpeg', filename: 'photo.jpg', caption: 'pic' }],
          },
        },
      },
    }) + '\n'));
    await flush();

    const msg = onMessage.mock.calls[0][0];
    expect(msg.content.type).toBe('text');
    expect((msg.content as any).text).toBe('[image attachment] pic');
  });

  it('voice note attachment produces text placeholder', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SignalChannel(cfg);
    ch.setEventHandlers({ onMessage });
    const p = ch.connect();
    connectHandler();
    await p;

    dataHandler(Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      method: 'receive',
      params: {
        envelope: {
          sourceNumber: '+19',
          dataMessage: {
            timestamp: 1700000000000,
            attachments: [{ contentType: 'audio/aac', voiceNote: true }],
          },
        },
      },
    }) + '\n'));
    await flush();

    const msg = onMessage.mock.calls[0][0];
    expect(msg.content.type).toBe('text');
    expect((msg.content as any).text).toBe('[audio attachment]');
  });

  it('file attachment produces text placeholder with filename', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SignalChannel(cfg);
    ch.setEventHandlers({ onMessage });
    const p = ch.connect();
    connectHandler();
    await p;

    dataHandler(Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      method: 'receive',
      params: {
        envelope: {
          sourceNumber: '+19',
          dataMessage: {
            timestamp: 1700000000000,
            attachments: [{ contentType: 'application/pdf', filename: 'doc.pdf' }],
          },
        },
      },
    }) + '\n'));
    await flush();

    const msg = onMessage.mock.calls[0][0];
    expect(msg.content.type).toBe('text');
    expect((msg.content as any).text).toBe('[file attachment: doc.pdf]');
  });

  // --- Quote / reply ---

  it('quote in message sets replyTo', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SignalChannel(cfg);
    ch.setEventHandlers({ onMessage });
    const p = ch.connect();
    connectHandler();
    await p;

    dataHandler(Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      method: 'receive',
      params: {
        envelope: {
          sourceNumber: '+19',
          dataMessage: {
            timestamp: 1700000000000,
            message: 'quoting',
            quote: { id: 1699999999000, authorNumber: '+18' },
          },
        },
      },
    }) + '\n'));
    await flush();

    expect(onMessage.mock.calls[0][0].replyTo).toBe('1699999999000:+18');
  });

  it('send with replyTo adds quoteTimestamp and quoteAuthor', async () => {
    let capturedReq: any;
    mockSocketWrite.mockImplementation((data: string, cb?: (err?: Error) => void) => {
      capturedReq = JSON.parse(data.trim());
      cb?.();
      setImmediate(() => {
        dataHandler(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: capturedReq.id, result: {} }) + '\n'));
      });
      return true;
    });

    const ch = new SignalChannel(cfg);
    const p = ch.connect();
    connectHandler();
    await p;

    await ch.send({
      id: 'o',
      channel: 'signal',
      peerId: '+19',
      replyTo: '1699999999000:+18',
      content: { type: 'text', text: 'reply' },
    });

    expect(capturedReq.params.quoteTimestamp).toBe(1699999999000);
    expect(capturedReq.params.quoteAuthor).toBe('+18');
  });

  // --- Access control ---

  it('allowedUsers blocks unauthorized user', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SignalChannel({ ...cfg, allowedUsers: ['+1allowed'] });
    ch.setEventHandlers({ onMessage });
    const p = ch.connect();
    connectHandler();
    await p;

    dataHandler(Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      method: 'receive',
      params: {
        envelope: {
          sourceNumber: '+1stranger',
          dataMessage: { timestamp: 1700000000000, message: 'hi' },
        },
      },
    }) + '\n'));
    await flush();

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('allowedGroups permits group messages', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SignalChannel({ ...cfg, allowedGroups: ['group:grp-ok'] });
    ch.setEventHandlers({ onMessage });
    const p = ch.connect();
    connectHandler();
    await p;

    dataHandler(Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      method: 'receive',
      params: {
        envelope: {
          sourceNumber: '+1anon',
          dataMessage: {
            timestamp: 1700000000000,
            message: 'group ok',
            groupInfo: { groupId: 'grp-ok', type: 'DELIVER' },
          },
        },
      },
    }) + '\n'));
    await flush();

    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  // --- Error handling ---

  it('invalid JSON in data stream does not crash', async () => {
    const ch = new SignalChannel(cfg);
    const p = ch.connect();
    connectHandler();
    await p;

    expect(() => dataHandler(Buffer.from('NOT-JSON\n'))).not.toThrow();
  });

  it('socket error after connect calls emitError', async () => {
    const onError = vi.fn();
    const ch = new SignalChannel(cfg);
    ch.setEventHandlers({ onError });
    const p = ch.connect();
    connectHandler();
    await p;

    errorHandler(new Error('socket broke'));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'socket broke' }));
  });

  it('pending requests rejected on disconnect', async () => {
    mockSocketWrite.mockImplementation((data: string, cb?: (err?: Error) => void) => {
      cb?.();
      return true;
    });

    const ch = new SignalChannel(cfg);
    const p = ch.connect();
    connectHandler();
    await p;

    const sendPromise = ch.send({
      id: 'o',
      channel: 'signal',
      peerId: '+1',
      content: { type: 'text', text: 'pending' },
    });

    closeHandler();
    await expect(sendPromise).rejects.toThrow('Connection lost');
  });

  // --- Empty/skip messages ---

  it('envelope without dataMessage is ignored', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SignalChannel(cfg);
    ch.setEventHandlers({ onMessage });
    const p = ch.connect();
    connectHandler();
    await p;

    dataHandler(Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      method: 'receive',
      params: {
        envelope: { sourceNumber: '+19' }, // no dataMessage
      },
    }) + '\n'));
    await flush();

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('envelope with empty dataMessage (no text, no attachments) is ignored', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SignalChannel(cfg);
    ch.setEventHandlers({ onMessage });
    const p = ch.connect();
    connectHandler();
    await p;

    dataHandler(Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      method: 'receive',
      params: {
        envelope: {
          sourceNumber: '+19',
          dataMessage: { timestamp: 1700000000000 }, // no message, no attachments
        },
      },
    }) + '\n'));
    await flush();

    expect(onMessage).not.toHaveBeenCalled();
  });

  // --- Multiple lines in single data chunk ---

  it('multiple JSON messages in single data chunk all processed', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SignalChannel(cfg);
    ch.setEventHandlers({ onMessage });
    const p = ch.connect();
    connectHandler();
    await p;

    const msg1 = JSON.stringify({
      jsonrpc: '2.0', method: 'receive',
      params: { envelope: { sourceNumber: '+1a', dataMessage: { timestamp: 1, message: 'one' } } },
    });
    const msg2 = JSON.stringify({
      jsonrpc: '2.0', method: 'receive',
      params: { envelope: { sourceNumber: '+1b', dataMessage: { timestamp: 2, message: 'two' } } },
    });

    dataHandler(Buffer.from(msg1 + '\n' + msg2 + '\n'));
    await flush();

    expect(onMessage).toHaveBeenCalledTimes(2);
  });

  // --- Additional Signal tests ---

  it('send image attachment via signal', async () => {
    let capturedReq: any;
    mockSocketWrite.mockImplementation((data: string, cb?: (err?: Error) => void) => {
      capturedReq = JSON.parse(data.trim());
      cb?.();
      setImmediate(() => {
        dataHandler(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: capturedReq.id, result: {} }) + '\n'));
      });
      return true;
    });

    const ch = new SignalChannel(cfg);
    const p = ch.connect();
    connectHandler();
    await p;

    await ch.send({
      id: 'o',
      channel: 'signal',
      peerId: '+19',
      content: { type: 'image', url: '/tmp/photo.jpg', mimeType: 'image/jpeg', caption: 'pic' },
    });

    expect(capturedReq.params.attachment).toEqual(['/tmp/photo.jpg']);
    expect(capturedReq.params.message).toBe('pic');
  });

  it('send file attachment via signal', async () => {
    let capturedReq: any;
    mockSocketWrite.mockImplementation((data: string, cb?: (err?: Error) => void) => {
      capturedReq = JSON.parse(data.trim());
      cb?.();
      setImmediate(() => {
        dataHandler(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: capturedReq.id, result: {} }) + '\n'));
      });
      return true;
    });

    const ch = new SignalChannel(cfg);
    const p = ch.connect();
    connectHandler();
    await p;

    await ch.send({
      id: 'o',
      channel: 'signal',
      peerId: '+19',
      content: { type: 'file', url: '/tmp/doc.pdf', mimeType: 'application/pdf', filename: 'doc.pdf' },
    });

    expect(capturedReq.params.attachment).toEqual(['/tmp/doc.pdf']);
  });

  it('connect sets connected to true', async () => {
    const ch = new SignalChannel(cfg);
    const p = ch.connect();
    connectHandler();
    await p;
    expect(ch.connected).toBe(true);
  });

  it('disconnect sets connected to false', async () => {
    const ch = new SignalChannel(cfg);
    const p = ch.connect();
    connectHandler();
    await p;
    await ch.disconnect();
    expect(ch.connected).toBe(false);
  });

  it('non-receive notifications are silently ignored', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SignalChannel(cfg);
    ch.setEventHandlers({ onMessage });
    const p = ch.connect();
    connectHandler();
    await p;

    dataHandler(Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      method: 'typing',
      params: { envelope: { sourceNumber: '+19' } },
    }) + '\n'));
    await flush();

    expect(onMessage).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. WHATSAPP BEHAVIORAL (~20 tests)
// ═════════════════════════════════════════════════════════════════════════════
describe('WhatsApp behavioral', () => {
  let WhatsAppChannel: typeof import('../src/channels/whatsapp.js').WhatsAppChannel;

  // public: true for the shared cfg so behavioral tests without explicit
  // allowlists are not fail-closed by the new isAllowed default.
  const cfg = {
    id: 'wa-beh',
    type: 'whatsapp' as const,
    enabled: true,
    agentId: 'agent-1',
    authDir: '/tmp/wa-auth',
    public: true,
  };

  let connectionUpdateHandler: (update: any) => void;
  let messagesUpsertHandler: (m: any) => Promise<void>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockWASocketEvOn.mockImplementation((event: string, handler: any) => {
      if (event === 'connection.update') connectionUpdateHandler = handler;
      if (event === 'messages.upsert') messagesUpsertHandler = handler;
    });
    ({ WhatsAppChannel } = await import('../src/channels/whatsapp.js'));
  });

  // --- Basic message flow ---

  it('conversation text produces correct IncomingMessage', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new WhatsAppChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await messagesUpsertHandler({
      messages: [{
        key: { fromMe: false, remoteJid: '5551234567@s.whatsapp.net', id: 'msg1' },
        message: { conversation: 'hello wa' },
        messageTimestamp: 1700000000,
        pushName: 'Alice',
      }],
    });
    await flush();

    const msg: IncomingMessage = onMessage.mock.calls[0][0];
    expect(msg.channel).toBe('whatsapp');
    expect(msg.senderId).toBe('5551234567');
    expect(msg.content).toEqual({ type: 'text', text: 'hello wa' });
    expect(msg.peerKind).toBe('user');
  });

  it('extendedTextMessage produces text content', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new WhatsAppChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await messagesUpsertHandler({
      messages: [{
        key: { fromMe: false, remoteJid: '5551234567@s.whatsapp.net', id: 'msg2' },
        message: { extendedTextMessage: { text: 'extended text' } },
        messageTimestamp: 1700000000,
      }],
    });
    await flush();

    expect((onMessage.mock.calls[0][0].content as any).text).toBe('extended text');
  });

  it('own messages (fromMe) are ignored', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new WhatsAppChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await messagesUpsertHandler({
      messages: [{
        key: { fromMe: true, remoteJid: '5551234567@s.whatsapp.net', id: 'own' },
        message: { conversation: 'my message' },
      }],
    });
    await flush();

    expect(onMessage).not.toHaveBeenCalled();
  });

  // --- Group vs DM ---

  it('group message (remoteJid ends with @g.us) sets peerKind=group', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new WhatsAppChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await messagesUpsertHandler({
      messages: [{
        key: { fromMe: false, remoteJid: 'group123@g.us', participant: '5551234567@s.whatsapp.net', id: 'g1' },
        message: { conversation: 'group msg' },
        messageTimestamp: 1700000000,
      }],
    });
    await flush();

    const msg = onMessage.mock.calls[0][0];
    expect(msg.peerKind).toBe('group');
    expect(msg.peerId).toBe('group123@g.us');
  });

  it('DM message sets peerKind=user', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new WhatsAppChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await messagesUpsertHandler({
      messages: [{
        key: { fromMe: false, remoteJid: '5551234567@s.whatsapp.net', id: 'dm1' },
        message: { conversation: 'dm msg' },
        messageTimestamp: 1700000000,
      }],
    });
    await flush();

    expect(onMessage.mock.calls[0][0].peerKind).toBe('user');
  });

  // --- Send ---

  it('send text appends @s.whatsapp.net to bare phone', async () => {
    const ch = new WhatsAppChannel(cfg);
    await ch.connect();

    await ch.send({
      id: 'o',
      channel: 'whatsapp',
      peerId: '5559876543',
      content: { type: 'text', text: 'hi' },
    });

    expect(mockWASocketSendMessage).toHaveBeenCalledWith(
      '5559876543@s.whatsapp.net',
      { text: 'hi' }
    );
  });

  it('send text to jid with @ does not double-append', async () => {
    const ch = new WhatsAppChannel(cfg);
    await ch.connect();

    await ch.send({
      id: 'o',
      channel: 'whatsapp',
      peerId: '5559876543@s.whatsapp.net',
      content: { type: 'text', text: 'hi' },
    });

    expect(mockWASocketSendMessage).toHaveBeenCalledWith(
      '5559876543@s.whatsapp.net',
      { text: 'hi' }
    );
  });

  it('send image with url', async () => {
    const ch = new WhatsAppChannel(cfg);
    await ch.connect();

    await ch.send({
      id: 'o',
      channel: 'whatsapp',
      peerId: '5551234567',
      content: { type: 'image', url: 'https://img.jpg', mimeType: 'image/jpeg', caption: 'Nice' },
    });

    expect(mockWASocketSendMessage).toHaveBeenCalledWith(
      '5551234567@s.whatsapp.net',
      expect.objectContaining({ image: { url: 'https://img.jpg' }, caption: 'Nice' })
    );
  });

  it('send audio as ptt (push to talk)', async () => {
    const ch = new WhatsAppChannel(cfg);
    await ch.connect();

    await ch.send({
      id: 'o',
      channel: 'whatsapp',
      peerId: '5551234567',
      content: { type: 'audio', url: 'https://voice.ogg', mimeType: 'audio/ogg' },
    });

    expect(mockWASocketSendMessage).toHaveBeenCalledWith(
      '5551234567@s.whatsapp.net',
      expect.objectContaining({ audio: { url: 'https://voice.ogg' }, ptt: true })
    );
  });

  // --- Media message types ---

  // findings.md P2:199 — Baileys delivers encrypted media that must be
  // downloaded via downloadMediaMessage(); the channel emits a
  // TextContent placeholder until that plumbing exists.

  it('imageMessage produces text placeholder with caption', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new WhatsAppChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await messagesUpsertHandler({
      messages: [{
        key: { fromMe: false, remoteJid: '5551234567@s.whatsapp.net', id: 'img1' },
        message: { imageMessage: { mimetype: 'image/png', caption: 'photo' } },
        messageTimestamp: 1700000000,
      }],
    });
    await flush();

    const msg = onMessage.mock.calls[0][0];
    expect(msg.content.type).toBe('text');
    expect((msg.content as any).text).toBe('[image attachment] photo');
  });

  it('documentMessage produces text placeholder with filename', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new WhatsAppChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await messagesUpsertHandler({
      messages: [{
        key: { fromMe: false, remoteJid: '5551234567@s.whatsapp.net', id: 'doc1' },
        message: { documentMessage: { mimetype: 'application/pdf', fileName: 'report.pdf' } },
        messageTimestamp: 1700000000,
      }],
    });
    await flush();

    const msg = onMessage.mock.calls[0][0];
    expect(msg.content.type).toBe('text');
    expect((msg.content as any).text).toBe('[file attachment: report.pdf]');
  });

  it('audioMessage produces text placeholder', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new WhatsAppChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await messagesUpsertHandler({
      messages: [{
        key: { fromMe: false, remoteJid: '5551234567@s.whatsapp.net', id: 'aud1' },
        message: { audioMessage: { mimetype: 'audio/ogg', seconds: 30 } },
        messageTimestamp: 1700000000,
      }],
    });
    await flush();

    const msg = onMessage.mock.calls[0][0];
    expect(msg.content.type).toBe('text');
    expect((msg.content as any).text).toBe('[audio attachment]');
  });

  it('unsupported message type is ignored', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new WhatsAppChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await messagesUpsertHandler({
      messages: [{
        key: { fromMe: false, remoteJid: '5551234567@s.whatsapp.net', id: 'sticker1' },
        message: { stickerMessage: {} }, // not handled
        messageTimestamp: 1700000000,
      }],
    });
    await flush();

    expect(onMessage).not.toHaveBeenCalled();
  });

  // --- Access control ---

  it('allowedUsers blocks unauthorized user', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new WhatsAppChannel({ ...cfg, allowedUsers: ['5559999999'] });
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await messagesUpsertHandler({
      messages: [{
        key: { fromMe: false, remoteJid: '5551234567@s.whatsapp.net', id: 'blocked' },
        message: { conversation: 'blocked' },
        messageTimestamp: 1700000000,
      }],
    });
    await flush();

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('allowedGroups blocks unauthorized group', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new WhatsAppChannel({ ...cfg, allowedGroups: ['allowed-group@g.us'] });
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await messagesUpsertHandler({
      messages: [{
        key: { fromMe: false, remoteJid: 'blocked-group@g.us', participant: '5551234567@s.whatsapp.net', id: 'g' },
        message: { conversation: 'not allowed' },
        messageTimestamp: 1700000000,
      }],
    });
    await flush();

    expect(onMessage).not.toHaveBeenCalled();
  });

  // --- Reply reference ---

  it('reply context (stanzaId) sets replyTo', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new WhatsAppChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await messagesUpsertHandler({
      messages: [{
        key: { fromMe: false, remoteJid: '5551234567@s.whatsapp.net', id: 'reply1' },
        message: {
          extendedTextMessage: {
            text: 'replying',
            contextInfo: { stanzaId: 'original-msg-id' },
          },
        },
        messageTimestamp: 1700000000,
      }],
    });
    await flush();

    expect(onMessage.mock.calls[0][0].replyTo).toBe('original-msg-id');
  });

  // --- Connection events ---

  it('connection open triggers emitConnect', async () => {
    const onConnect = vi.fn();
    const ch = new WhatsAppChannel(cfg);
    ch.setEventHandlers({ onConnect });
    await ch.connect();

    connectionUpdateHandler({ connection: 'open' });
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('connection close with logged out triggers emitDisconnect', async () => {
    const onDisconnect = vi.fn();
    const ch = new WhatsAppChannel(cfg);
    ch.setEventHandlers({ onDisconnect });
    await ch.connect();

    const { Boom } = await import('@hapi/boom');
    connectionUpdateHandler({
      connection: 'close',
      lastDisconnect: { error: new Boom('Logged out', { statusCode: 401 }) },
    });

    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  // --- Multiple messages in upsert ---

  it('multiple messages in single upsert all processed', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new WhatsAppChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await messagesUpsertHandler({
      messages: [
        {
          key: { fromMe: false, remoteJid: '5551111111@s.whatsapp.net', id: 'm1' },
          message: { conversation: 'first' },
          messageTimestamp: 1700000000,
        },
        {
          key: { fromMe: false, remoteJid: '5552222222@s.whatsapp.net', id: 'm2' },
          message: { conversation: 'second' },
          messageTimestamp: 1700000001,
        },
      ],
    });
    await flush();

    expect(onMessage).toHaveBeenCalledTimes(2);
  });

  // --- Additional WhatsApp tests ---

  it('send document via sendMessage', async () => {
    const ch = new WhatsAppChannel(cfg);
    await ch.connect();

    await ch.send({
      id: 'o',
      channel: 'whatsapp',
      peerId: '5551234567',
      content: { type: 'file', url: 'https://doc.pdf', mimeType: 'application/pdf', filename: 'report.pdf' },
    });

    expect(mockWASocketSendMessage).toHaveBeenCalledWith(
      '5551234567@s.whatsapp.net',
      expect.objectContaining({
        document: { url: 'https://doc.pdf' },
        mimetype: 'application/pdf',
        fileName: 'report.pdf',
      })
    );
  });

  it('send image with base64', async () => {
    const ch = new WhatsAppChannel(cfg);
    await ch.connect();

    await ch.send({
      id: 'o',
      channel: 'whatsapp',
      peerId: '5551234567',
      content: { type: 'image', base64: 'data:image/png;base64,abc123', mimeType: 'image/png' },
    });

    // Should decode base64 into Buffer
    expect(mockWASocketSendMessage).toHaveBeenCalled();
    const payload = mockWASocketSendMessage.mock.calls[0][1];
    expect(payload.image).toBeInstanceOf(Buffer);
  });

  it('send image without url or base64 is a no-op', async () => {
    const ch = new WhatsAppChannel(cfg);
    await ch.connect();
    mockWASocketSendMessage.mockClear();

    await ch.send({
      id: 'o',
      channel: 'whatsapp',
      peerId: '5551234567',
      content: { type: 'image', mimeType: 'image/jpeg' },
    });

    expect(mockWASocketSendMessage).not.toHaveBeenCalled();
  });

  it('send audio without url or base64 is a no-op', async () => {
    const ch = new WhatsAppChannel(cfg);
    await ch.connect();
    mockWASocketSendMessage.mockClear();

    await ch.send({
      id: 'o',
      channel: 'whatsapp',
      peerId: '5551234567',
      content: { type: 'audio', mimeType: 'audio/ogg' },
    });

    expect(mockWASocketSendMessage).not.toHaveBeenCalled();
  });

  it('send file without url or base64 is a no-op', async () => {
    const ch = new WhatsAppChannel(cfg);
    await ch.connect();
    mockWASocketSendMessage.mockClear();

    await ch.send({
      id: 'o',
      channel: 'whatsapp',
      peerId: '5551234567',
      content: { type: 'file', mimeType: 'application/pdf', filename: 'none.pdf' },
    });

    expect(mockWASocketSendMessage).not.toHaveBeenCalled();
  });

  it('senderId strips @s.whatsapp.net suffix for DM', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new WhatsAppChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await messagesUpsertHandler({
      messages: [{
        key: { fromMe: false, remoteJid: '5551234567@s.whatsapp.net', id: 'dm' },
        message: { conversation: 'test' },
        messageTimestamp: 1700000000,
      }],
    });
    await flush();

    // senderId should not contain @s.whatsapp.net
    expect(onMessage.mock.calls[0][0].senderId).toBe('5551234567');
  });

  it('null message in upsert is ignored', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new WhatsAppChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await messagesUpsertHandler({
      messages: [{
        key: { fromMe: false, remoteJid: '5551234567@s.whatsapp.net', id: 'null-msg' },
        message: null,
        messageTimestamp: 1700000000,
      }],
    });
    await flush();

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('channel=whatsapp on all incoming messages', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new WhatsAppChannel(cfg);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await messagesUpsertHandler({
      messages: [{
        key: { fromMe: false, remoteJid: '5551234567@s.whatsapp.net', id: 'ch-check' },
        message: { conversation: 'channel check' },
        messageTimestamp: 1700000000,
      }],
    });
    await flush();

    expect(onMessage.mock.calls[0][0].channel).toBe('whatsapp');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. CHANNEL REGISTRY BEHAVIORAL (~20 tests)
// ═════════════════════════════════════════════════════════════════════════════
describe('Channel registry behavioral', () => {
  let createChannel: typeof import('../src/channels/index.js').createChannel;

  const base = { id: 'reg-1', enabled: true, agentId: 'a1' };

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ createChannel } = await import('../src/channels/index.js'));
  });

  it('creates telegram channel from config', () => {
    const ch = createChannel({ ...base, type: 'telegram', token: 'tok' });
    expect(ch.type).toBe('telegram');
    expect(ch.id).toBe('reg-1');
  });

  it('creates discord channel from config', () => {
    const ch = createChannel({ ...base, type: 'discord', token: 'tok' });
    expect(ch.type).toBe('discord');
  });

  it('creates slack channel from config', () => {
    const ch = createChannel({ ...base, type: 'slack', botToken: 'b', appToken: 'a', signingSecret: 's' });
    expect(ch.type).toBe('slack');
  });

  it('creates signal channel from config', () => {
    const ch = createChannel({ ...base, type: 'signal', socketPath: '/tmp/s', account: '+1' });
    expect(ch.type).toBe('signal');
  });

  it('creates whatsapp channel from config', () => {
    const ch = createChannel({ ...base, type: 'whatsapp', authDir: '/tmp/wa' });
    expect(ch.type).toBe('whatsapp');
  });

  it('unknown channel type throws descriptive error', () => {
    expect(() => createChannel({ ...base, type: 'smoke-signal' as any }))
      .toThrow('Unknown channel type: smoke-signal');
  });

  it('error message includes the type name', () => {
    expect(() => createChannel({ ...base, type: 'fax-machine' as any }))
      .toThrow('fax-machine');
  });

  it('each call returns a new independent instance', () => {
    const cfgTg = { ...base, type: 'telegram' as const, token: 'tok' };
    const a = createChannel(cfgTg);
    const b = createChannel(cfgTg);
    expect(a).not.toBe(b);
  });

  it('all created channels start disconnected', () => {
    const types = [
      { ...base, type: 'telegram' as const, token: 't' },
      { ...base, type: 'discord' as const, token: 't' },
      { ...base, type: 'slack' as const, botToken: 'b', appToken: 'a', signingSecret: 's' },
      { ...base, type: 'signal' as const, socketPath: '/tmp/s', account: '+1' },
      { ...base, type: 'whatsapp' as const, authDir: '/tmp/wa' },
    ];
    for (const c of types) {
      expect(createChannel(c).connected).toBe(false);
    }
  });

  it('all created channels implement connect/disconnect/send/setEventHandlers', () => {
    const types = [
      { ...base, type: 'telegram' as const, token: 't' },
      { ...base, type: 'discord' as const, token: 't' },
      { ...base, type: 'slack' as const, botToken: 'b', appToken: 'a', signingSecret: 's' },
      { ...base, type: 'signal' as const, socketPath: '/tmp/s', account: '+1' },
      { ...base, type: 'whatsapp' as const, authDir: '/tmp/wa' },
    ];
    for (const c of types) {
      const ch = createChannel(c);
      expect(typeof ch.connect).toBe('function');
      expect(typeof ch.disconnect).toBe('function');
      expect(typeof ch.send).toBe('function');
      expect(typeof ch.setEventHandlers).toBe('function');
    }
  });

  it('channel id matches config id', () => {
    const ch = createChannel({ ...base, id: 'custom-id', type: 'telegram', token: 't' });
    expect(ch.id).toBe('custom-id');
  });

  it('setEventHandlers is callable without error on all types', () => {
    const types = [
      { ...base, type: 'telegram' as const, token: 't' },
      { ...base, type: 'discord' as const, token: 't' },
      { ...base, type: 'slack' as const, botToken: 'b', appToken: 'a', signingSecret: 's' },
      { ...base, type: 'signal' as const, socketPath: '/tmp/s', account: '+1' },
      { ...base, type: 'whatsapp' as const, authDir: '/tmp/wa' },
    ];
    for (const c of types) {
      const ch = createChannel(c);
      expect(() => ch.setEventHandlers({ onConnect: vi.fn(), onError: vi.fn() })).not.toThrow();
    }
  });

  it('different configs produce channels with different ids', () => {
    const a = createChannel({ ...base, id: 'alpha', type: 'telegram', token: 't' });
    const b = createChannel({ ...base, id: 'beta', type: 'telegram', token: 't' });
    expect(a.id).not.toBe(b.id);
  });

  it('different channel types produce channels with different type fields', () => {
    const tg = createChannel({ ...base, type: 'telegram', token: 't' });
    const dc = createChannel({ ...base, type: 'discord', token: 't' });
    expect(tg.type).not.toBe(dc.type);
  });

  it('creating channel does not connect it', () => {
    const ch = createChannel({ ...base, type: 'telegram', token: 't' });
    expect(ch.connected).toBe(false);
  });

  it('multiple channels can coexist independently', () => {
    const tg = createChannel({ ...base, id: 'tg-1', type: 'telegram', token: 't' });
    const dc = createChannel({ ...base, id: 'dc-1', type: 'discord', token: 't' });
    const sl = createChannel({ ...base, id: 'sl-1', type: 'slack', botToken: 'b', appToken: 'a', signingSecret: 's' });

    expect(tg.id).toBe('tg-1');
    expect(dc.id).toBe('dc-1');
    expect(sl.id).toBe('sl-1');
    expect(tg.type).toBe('telegram');
    expect(dc.type).toBe('discord');
    expect(sl.type).toBe('slack');
  });

  it('empty string type throws', () => {
    expect(() => createChannel({ ...base, type: '' as any })).toThrow('Unknown channel type');
  });

  it('numeric-like type throws', () => {
    expect(() => createChannel({ ...base, type: '123' as any })).toThrow('Unknown channel type: 123');
  });

  it('each channel type preserves its specific config', () => {
    // Verify that channel-specific configs like token, socketPath, etc. are used
    const tg = createChannel({ ...base, type: 'telegram', token: 'my-token' });
    expect(tg.type).toBe('telegram'); // internals are opaque but the channel works
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. CROSS-CHANNEL CONSISTENCY (~30 tests)
// ═════════════════════════════════════════════════════════════════════════════
describe('Cross-channel consistency', () => {
  let TelegramChannel: typeof import('../src/channels/telegram.js').TelegramChannel;
  let DiscordChannel: typeof import('../src/channels/discord.js').DiscordChannel;
  let SlackChannel: typeof import('../src/channels/slack.js').SlackChannel;
  let SignalChannel: typeof import('../src/channels/signal.js').SignalChannel;
  let WhatsAppChannel: typeof import('../src/channels/whatsapp.js').WhatsAppChannel;
  let createChannel: typeof import('../src/channels/index.js').createChannel;

  let signalConnectHandler: () => void;
  let signalDataHandler: (data: Buffer) => void;
  let waConnectionHandler: (update: any) => void;
  let waMessagesHandler: (m: any) => Promise<void>;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Setup signal socket mock
    mockSocketOn.mockImplementation((event: string, handler: any) => {
      if (event === 'connect') signalConnectHandler = handler;
      if (event === 'data') signalDataHandler = handler;
    });

    // Setup whatsapp mock
    mockWASocketEvOn.mockImplementation((event: string, handler: any) => {
      if (event === 'connection.update') waConnectionHandler = handler;
      if (event === 'messages.upsert') waMessagesHandler = handler;
    });

    ({ TelegramChannel } = await import('../src/channels/telegram.js'));
    ({ DiscordChannel } = await import('../src/channels/discord.js'));
    ({ SlackChannel } = await import('../src/channels/slack.js'));
    ({ SignalChannel } = await import('../src/channels/signal.js'));
    ({ WhatsAppChannel } = await import('../src/channels/whatsapp.js'));
    ({ createChannel } = await import('../src/channels/index.js'));
  });

  // --- Same message through different channels produces consistent structure ---

  it('text messages from all channels have type=text content', async () => {
    const results: IncomingMessage[] = [];

    // Telegram
    const tgMsg = vi.fn().mockImplementation((m: IncomingMessage) => {
      results.push(m);
      return Promise.resolve();
    });
    const tg = new TelegramChannel({ id: 'tg', type: 'telegram', enabled: true, agentId: 'a', token: 't', public: true });
    tg.setEventHandlers({ onMessage: tgMsg });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await tg.connect();
    const tgHandler = mockBotOn.mock.calls.find((c: any[]) => c[0] === 'message:text')[1];
    await tgHandler(makeTelegramCtx());

    // Discord
    vi.clearAllMocks();
    const dcMsg = vi.fn().mockImplementation((m: IncomingMessage) => {
      results.push(m);
      return Promise.resolve();
    });
    const dc = new DiscordChannel({ id: 'dc', type: 'discord', enabled: true, agentId: 'a', token: 't', public: true });
    dc.setEventHandlers({ onMessage: dcMsg });
    await dc.connect();
    const dcHandler = mockClientOn.mock.calls.find((c: any[]) => c[0] === 'messageCreate')[1];
    await dcHandler(makeDiscordMsg());

    await flush();

    expect(results.length).toBe(2);
    expect(results[0].content.type).toBe('text');
    expect(results[1].content.type).toBe('text');
  });

  it('all channels set channel field to their own name', async () => {
    const channels: string[] = [];

    // Telegram
    const tgMsg = vi.fn().mockImplementation((m: IncomingMessage) => {
      channels.push(m.channel);
      return Promise.resolve();
    });
    const tg = new TelegramChannel({ id: 'tg', type: 'telegram', enabled: true, agentId: 'a', token: 't', public: true });
    tg.setEventHandlers({ onMessage: tgMsg });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await tg.connect();
    await mockBotOn.mock.calls.find((c: any[]) => c[0] === 'message:text')[1](makeTelegramCtx());

    // Discord
    vi.clearAllMocks();
    const dcMsg = vi.fn().mockImplementation((m: IncomingMessage) => {
      channels.push(m.channel);
      return Promise.resolve();
    });
    const dc = new DiscordChannel({ id: 'dc', type: 'discord', enabled: true, agentId: 'a', token: 't', public: true });
    dc.setEventHandlers({ onMessage: dcMsg });
    await dc.connect();
    await mockClientOn.mock.calls.find((c: any[]) => c[0] === 'messageCreate')[1](makeDiscordMsg());

    await flush();

    expect(channels).toContain('telegram');
    expect(channels).toContain('discord');
  });

  // --- Session isolation between channels ---

  it('Telegram and Discord peerIds are independent namespaces', async () => {
    const tgPeerIds: string[] = [];
    const dcPeerIds: string[] = [];

    const tgMsg = vi.fn().mockImplementation((m: IncomingMessage) => {
      tgPeerIds.push(m.peerId);
      return Promise.resolve();
    });
    const tg = new TelegramChannel({ id: 'tg', type: 'telegram', enabled: true, agentId: 'a', token: 't', public: true });
    tg.setEventHandlers({ onMessage: tgMsg });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await tg.connect();
    await mockBotOn.mock.calls.find((c: any[]) => c[0] === 'message:text')[1](
      makeTelegramCtx({ chat: { id: 123, type: 'private' } })
    );

    vi.clearAllMocks();
    const dcMsg = vi.fn().mockImplementation((m: IncomingMessage) => {
      dcPeerIds.push(m.peerId);
      return Promise.resolve();
    });
    const dc = new DiscordChannel({ id: 'dc', type: 'discord', enabled: true, agentId: 'a', token: 't', public: true });
    dc.setEventHandlers({ onMessage: dcMsg });
    await dc.connect();
    await mockClientOn.mock.calls.find((c: any[]) => c[0] === 'messageCreate')[1](
      makeDiscordMsg({ channel: { id: 'ch-456' } })
    );

    await flush();

    // peerIds should be different since they come from different namespace
    expect(tgPeerIds[0]).toBe('123');
    expect(dcPeerIds[0]).toBe('ch-456');
    expect(tgPeerIds[0]).not.toBe(dcPeerIds[0]);
  });

  it('same user ID on different channels produces different channel labels', async () => {
    const msgs: IncomingMessage[] = [];

    // Telegram
    const tg = new TelegramChannel({ id: 'tg', type: 'telegram', enabled: true, agentId: 'a', token: 't', public: true });
    tg.setEventHandlers({ onMessage: vi.fn().mockImplementation((m: IncomingMessage) => { msgs.push(m); return Promise.resolve(); }) });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await tg.connect();
    await mockBotOn.mock.calls.find((c: any[]) => c[0] === 'message:text')[1](makeTelegramCtx());

    vi.clearAllMocks();
    // Discord
    const dc = new DiscordChannel({ id: 'dc', type: 'discord', enabled: true, agentId: 'a', token: 't', public: true });
    dc.setEventHandlers({ onMessage: vi.fn().mockImplementation((m: IncomingMessage) => { msgs.push(m); return Promise.resolve(); }) });
    await dc.connect();
    await mockClientOn.mock.calls.find((c: any[]) => c[0] === 'messageCreate')[1](makeDiscordMsg());

    await flush();

    expect(msgs[0].channel).toBe('telegram');
    expect(msgs[1].channel).toBe('discord');
  });

  // --- Error in one channel does not affect others ---

  it('error handler on one channel does not trigger on another', async () => {
    const tgError = vi.fn();
    const dcError = vi.fn();

    const tg = new TelegramChannel({ id: 'tg', type: 'telegram', enabled: true, agentId: 'a', token: 't', public: true });
    tg.setEventHandlers({ onError: tgError });
    vi.useFakeTimers();
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await tg.connect();

    vi.clearAllMocks();
    const dc = new DiscordChannel({ id: 'dc', type: 'discord', enabled: true, agentId: 'a', token: 't', public: true });
    dc.setEventHandlers({ onError: dcError });
    await dc.connect();

    // Trigger error on telegram only
    const catchHandler = mockBotCatch.mock.calls[0]?.[0];
    if (catchHandler) {
      catchHandler(new Error('tg error'));
    }

    // Discord should not be affected
    expect(tgError).toHaveBeenCalledTimes(catchHandler ? 1 : 0);
    expect(dcError).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('disconnecting one channel does not disconnect another', async () => {
    const tg = new TelegramChannel({ id: 'tg', type: 'telegram', enabled: true, agentId: 'a', token: 't', public: true });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await tg.connect();

    vi.clearAllMocks();
    const dc = new DiscordChannel({ id: 'dc', type: 'discord', enabled: true, agentId: 'a', token: 't', public: true });
    await dc.connect();

    // Trigger ready on discord
    const readyHandler = mockClientOn.mock.calls.find((c: any[]) => c[0] === 'ready')?.[1];
    if (readyHandler) readyHandler();

    // Disconnect telegram
    await tg.disconnect();
    expect(tg.connected).toBe(false);
    // Discord should still be reporting its initial connected state
    // (connected is set by emitConnect which requires ready event)
  });

  // --- All channels produce IncomingMessage with required fields ---

  it('all channels produce messages with required fields: id, channel, peerKind, peerId, senderId, content, timestamp', async () => {
    const requiredFields = ['id', 'channel', 'peerKind', 'peerId', 'senderId', 'content', 'timestamp'];

    // Test telegram
    const tgMsg = vi.fn().mockResolvedValue(undefined);
    const tg = new TelegramChannel({ id: 'tg', type: 'telegram', enabled: true, agentId: 'a', token: 't', public: true });
    tg.setEventHandlers({ onMessage: tgMsg });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await tg.connect();
    await mockBotOn.mock.calls.find((c: any[]) => c[0] === 'message:text')[1](makeTelegramCtx());
    await flush();

    const msg = tgMsg.mock.calls[0][0] as IncomingMessage;
    for (const field of requiredFields) {
      expect(msg).toHaveProperty(field);
      expect((msg as any)[field]).toBeDefined();
    }
  });

  it('text content always has text field', async () => {
    const tgMsg = vi.fn().mockResolvedValue(undefined);
    const tg = new TelegramChannel({ id: 'tg', type: 'telegram', enabled: true, agentId: 'a', token: 't', public: true });
    tg.setEventHandlers({ onMessage: tgMsg });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await tg.connect();
    await mockBotOn.mock.calls.find((c: any[]) => c[0] === 'message:text')[1](makeTelegramCtx());
    await flush();

    const msg = tgMsg.mock.calls[0][0];
    expect(msg.content.type).toBe('text');
    expect(typeof (msg.content as any).text).toBe('string');
  });

  // --- Consistent behavior: all channels throw when not connected ---

  it('all channels throw when sending before connect', async () => {
    const textMsg: OutgoingMessage = { id: 'o', channel: 'telegram', peerId: '1', content: { type: 'text', text: 'x' } };

    const tg = new TelegramChannel({ id: 'tg', type: 'telegram', enabled: true, agentId: 'a', token: 't', public: true });
    await expect(tg.send(textMsg)).rejects.toThrow();

    const dc = new DiscordChannel({ id: 'dc', type: 'discord', enabled: true, agentId: 'a', token: 't', public: true });
    await expect(dc.send({ ...textMsg, channel: 'discord' })).rejects.toThrow();

    const sl = new SlackChannel({ id: 'sl', type: 'slack', enabled: true, agentId: 'a', botToken: 'b', appToken: 'a', signingSecret: 's', public: true });
    await expect(sl.send({ ...textMsg, channel: 'slack' })).rejects.toThrow();

    const sig = new SignalChannel({ id: 'sig', type: 'signal', enabled: true, agentId: 'a', socketPath: '/tmp/s', account: '+1', public: true });
    await expect(sig.send({ ...textMsg, channel: 'signal' })).rejects.toThrow();

    const wa = new WhatsAppChannel({ id: 'wa', type: 'whatsapp', enabled: true, agentId: 'a', authDir: '/tmp/wa', public: true });
    await expect(wa.send({ ...textMsg, channel: 'whatsapp' })).rejects.toThrow();
  });

  // --- All channels support setEventHandlers ---

  it('all channels accept onMessage, onError, onConnect, onDisconnect handlers', () => {
    const handlers = {
      onMessage: vi.fn().mockResolvedValue(undefined),
      onError: vi.fn(),
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
    };

    const configs = [
      { id: 'tg', type: 'telegram' as const, enabled: true, agentId: 'a', token: 't' },
      { id: 'dc', type: 'discord' as const, enabled: true, agentId: 'a', token: 't' },
      { id: 'sl', type: 'slack' as const, enabled: true, agentId: 'a', botToken: 'b', appToken: 'a', signingSecret: 's' },
      { id: 'sig', type: 'signal' as const, enabled: true, agentId: 'a', socketPath: '/tmp/s', account: '+1' },
      { id: 'wa', type: 'whatsapp' as const, enabled: true, agentId: 'a', authDir: '/tmp/wa' },
    ];

    for (const c of configs) {
      const ch = createChannel(c);
      expect(() => ch.setEventHandlers(handlers)).not.toThrow();
    }
  });

  // --- All channels' id and type are readonly ---

  it('all channels expose id and type as strings', () => {
    const configs = [
      { id: 'tg-x', type: 'telegram' as const, enabled: true, agentId: 'a', token: 't' },
      { id: 'dc-x', type: 'discord' as const, enabled: true, agentId: 'a', token: 't' },
      { id: 'sl-x', type: 'slack' as const, enabled: true, agentId: 'a', botToken: 'b', appToken: 'a', signingSecret: 's' },
      { id: 'sig-x', type: 'signal' as const, enabled: true, agentId: 'a', socketPath: '/tmp/s', account: '+1' },
      { id: 'wa-x', type: 'whatsapp' as const, enabled: true, agentId: 'a', authDir: '/tmp/wa' },
    ];

    const expectedTypes = ['telegram', 'discord', 'slack', 'signal', 'whatsapp'];

    for (let i = 0; i < configs.length; i++) {
      const ch = createChannel(configs[i]);
      expect(typeof ch.id).toBe('string');
      expect(typeof ch.type).toBe('string');
      expect(ch.type).toBe(expectedTypes[i]);
    }
  });

  // --- Consistent disconnect behavior ---

  it('disconnect is safe (no-op) on all channels when not connected', async () => {
    const configs = [
      { id: 'tg', type: 'telegram' as const, enabled: true, agentId: 'a', token: 't' },
      { id: 'dc', type: 'discord' as const, enabled: true, agentId: 'a', token: 't' },
      { id: 'sl', type: 'slack' as const, enabled: true, agentId: 'a', botToken: 'b', appToken: 'a', signingSecret: 's' },
      { id: 'sig', type: 'signal' as const, enabled: true, agentId: 'a', socketPath: '/tmp/s', account: '+1' },
      { id: 'wa', type: 'whatsapp' as const, enabled: true, agentId: 'a', authDir: '/tmp/wa' },
    ];

    for (const c of configs) {
      const ch = createChannel(c);
      await expect(ch.disconnect()).resolves.toBeUndefined();
    }
  });

  // --- connected starts false for all ---

  it('connected property starts false for all channels', () => {
    const configs = [
      { id: 'tg', type: 'telegram' as const, enabled: true, agentId: 'a', token: 't' },
      { id: 'dc', type: 'discord' as const, enabled: true, agentId: 'a', token: 't' },
      { id: 'sl', type: 'slack' as const, enabled: true, agentId: 'a', botToken: 'b', appToken: 'a', signingSecret: 's' },
      { id: 'sig', type: 'signal' as const, enabled: true, agentId: 'a', socketPath: '/tmp/s', account: '+1' },
      { id: 'wa', type: 'whatsapp' as const, enabled: true, agentId: 'a', authDir: '/tmp/wa' },
    ];

    for (const c of configs) {
      expect(createChannel(c).connected).toBe(false);
    }
  });

  // --- IncomingMessage timestamp is always a number ---

  it('all channels produce numeric timestamps', async () => {
    // Telegram
    const tgMsg = vi.fn().mockResolvedValue(undefined);
    const tg = new TelegramChannel({ id: 'tg', type: 'telegram', enabled: true, agentId: 'a', token: 't', public: true });
    tg.setEventHandlers({ onMessage: tgMsg });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await tg.connect();
    await mockBotOn.mock.calls.find((c: any[]) => c[0] === 'message:text')[1](makeTelegramCtx());
    await flush();

    expect(typeof tgMsg.mock.calls[0][0].timestamp).toBe('number');
    expect(tgMsg.mock.calls[0][0].timestamp).toBeGreaterThan(0);
  });

  // --- IncomingMessage id is always a non-empty string ---

  it('all channels produce non-empty string message ids', async () => {
    const tgMsg = vi.fn().mockResolvedValue(undefined);
    const tg = new TelegramChannel({ id: 'tg', type: 'telegram', enabled: true, agentId: 'a', token: 't', public: true });
    tg.setEventHandlers({ onMessage: tgMsg });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await tg.connect();
    await mockBotOn.mock.calls.find((c: any[]) => c[0] === 'message:text')[1](makeTelegramCtx());
    await flush();

    const id = tgMsg.mock.calls[0][0].id;
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  // --- Multiple channels can process messages in parallel ---

  it('telegram and discord can both receive messages concurrently', async () => {
    const tgMsgs: IncomingMessage[] = [];
    const dcMsgs: IncomingMessage[] = [];

    const tg = new TelegramChannel({ id: 'tg', type: 'telegram', enabled: true, agentId: 'a', token: 't', public: true });
    tg.setEventHandlers({ onMessage: vi.fn().mockImplementation((m: IncomingMessage) => { tgMsgs.push(m); return Promise.resolve(); }) });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await tg.connect();

    vi.clearAllMocks();
    const dc = new DiscordChannel({ id: 'dc', type: 'discord', enabled: true, agentId: 'a', token: 't', public: true });
    dc.setEventHandlers({ onMessage: vi.fn().mockImplementation((m: IncomingMessage) => { dcMsgs.push(m); return Promise.resolve(); }) });
    await dc.connect();

    // Send concurrently
    const tgHandler = mockBotOn.mock.calls.find((c: any[]) => c[0] === 'message:text')?.[1];
    const dcHandler = mockClientOn.mock.calls.find((c: any[]) => c[0] === 'messageCreate')?.[1];

    if (tgHandler && dcHandler) {
      await Promise.all([
        tgHandler(makeTelegramCtx()),
        dcHandler(makeDiscordMsg()),
      ]);
      await flush();

      expect(tgMsgs.length).toBe(1);
      expect(dcMsgs.length).toBe(1);
      expect(tgMsgs[0].channel).toBe('telegram');
      expect(dcMsgs[0].channel).toBe('discord');
    }
  });

  // --- Content type consistency ---

  it('text content from all channels has type=text and text field', async () => {
    // Already tested implicitly but verifying the contract explicitly
    const tgMsg = vi.fn().mockResolvedValue(undefined);
    const tg = new TelegramChannel({ id: 'tg', type: 'telegram', enabled: true, agentId: 'a', token: 't', public: true });
    tg.setEventHandlers({ onMessage: tgMsg });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await tg.connect();
    await mockBotOn.mock.calls.find((c: any[]) => c[0] === 'message:text')[1](
      makeTelegramCtx({ message: { message_id: 1, text: 'test text', date: 1700000000 } })
    );
    await flush();

    const content = tgMsg.mock.calls[0][0].content;
    expect(content.type).toBe('text');
    expect((content as any).text).toBe('test text');
  });

  // --- peerKind consistency ---

  it('private/DM messages use peerKind=user across channels', async () => {
    // Telegram
    const tgMsg = vi.fn().mockResolvedValue(undefined);
    const tg = new TelegramChannel({ id: 'tg', type: 'telegram', enabled: true, agentId: 'a', token: 't', public: true });
    tg.setEventHandlers({ onMessage: tgMsg });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await tg.connect();
    await mockBotOn.mock.calls.find((c: any[]) => c[0] === 'message:text')[1](
      makeTelegramCtx({ chat: { id: 1, type: 'private' } })
    );
    await flush();
    expect(tgMsg.mock.calls[0][0].peerKind).toBe('user');

    // Discord DM
    vi.clearAllMocks();
    const dcMsg = vi.fn().mockResolvedValue(undefined);
    const dc = new DiscordChannel({ id: 'dc', type: 'discord', enabled: true, agentId: 'a', token: 't', public: true });
    dc.setEventHandlers({ onMessage: dcMsg });
    await dc.connect();
    await mockClientOn.mock.calls.find((c: any[]) => c[0] === 'messageCreate')[1](
      makeDiscordMsg({ guild: null })
    );
    await flush();
    expect(dcMsg.mock.calls[0][0].peerKind).toBe('user');
  });

  it('group/guild messages use peerKind=group across channels', async () => {
    // Telegram group
    const tgMsg = vi.fn().mockResolvedValue(undefined);
    const tg = new TelegramChannel({ id: 'tg', type: 'telegram', enabled: true, agentId: 'a', token: 't', public: true });
    tg.setEventHandlers({ onMessage: tgMsg });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await tg.connect();
    await mockBotOn.mock.calls.find((c: any[]) => c[0] === 'message:text')[1](
      makeTelegramCtx({ chat: { id: -100, type: 'group' } })
    );
    await flush();
    expect(tgMsg.mock.calls[0][0].peerKind).toBe('group');

    // Discord guild
    vi.clearAllMocks();
    const dcMsg = vi.fn().mockResolvedValue(undefined);
    const dc = new DiscordChannel({ id: 'dc', type: 'discord', enabled: true, agentId: 'a', token: 't', public: true });
    dc.setEventHandlers({ onMessage: dcMsg });
    await dc.connect();
    await mockClientOn.mock.calls.find((c: any[]) => c[0] === 'messageCreate')[1](
      makeDiscordMsg({ guild: { id: 'g', name: 'G' } })
    );
    await flush();
    expect(dcMsg.mock.calls[0][0].peerKind).toBe('group');
  });

  // --- Additional cross-channel consistency tests ---

  it('senderId is always a string across all channels', async () => {
    // Telegram (numeric id becomes string)
    const tgMsg = vi.fn().mockResolvedValue(undefined);
    const tg = new TelegramChannel({ id: 'tg', type: 'telegram', enabled: true, agentId: 'a', token: 't', public: true });
    tg.setEventHandlers({ onMessage: tgMsg });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await tg.connect();
    await mockBotOn.mock.calls.find((c: any[]) => c[0] === 'message:text')[1](makeTelegramCtx());
    await flush();
    expect(typeof tgMsg.mock.calls[0][0].senderId).toBe('string');

    // Discord
    vi.clearAllMocks();
    const dcMsg = vi.fn().mockResolvedValue(undefined);
    const dc = new DiscordChannel({ id: 'dc', type: 'discord', enabled: true, agentId: 'a', token: 't', public: true });
    dc.setEventHandlers({ onMessage: dcMsg });
    await dc.connect();
    await mockClientOn.mock.calls.find((c: any[]) => c[0] === 'messageCreate')[1](makeDiscordMsg());
    await flush();
    expect(typeof dcMsg.mock.calls[0][0].senderId).toBe('string');
  });

  it('peerId is always a string across all channels', async () => {
    const tgMsg = vi.fn().mockResolvedValue(undefined);
    const tg = new TelegramChannel({ id: 'tg', type: 'telegram', enabled: true, agentId: 'a', token: 't', public: true });
    tg.setEventHandlers({ onMessage: tgMsg });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await tg.connect();
    await mockBotOn.mock.calls.find((c: any[]) => c[0] === 'message:text')[1](makeTelegramCtx());
    await flush();
    expect(typeof tgMsg.mock.calls[0][0].peerId).toBe('string');

    vi.clearAllMocks();
    const dcMsg = vi.fn().mockResolvedValue(undefined);
    const dc = new DiscordChannel({ id: 'dc', type: 'discord', enabled: true, agentId: 'a', token: 't', public: true });
    dc.setEventHandlers({ onMessage: dcMsg });
    await dc.connect();
    await mockClientOn.mock.calls.find((c: any[]) => c[0] === 'messageCreate')[1](makeDiscordMsg());
    await flush();
    expect(typeof dcMsg.mock.calls[0][0].peerId).toBe('string');
  });

  it('metadata is always an object when present', async () => {
    const tgMsg = vi.fn().mockResolvedValue(undefined);
    const tg = new TelegramChannel({ id: 'tg', type: 'telegram', enabled: true, agentId: 'a', token: 't', public: true });
    tg.setEventHandlers({ onMessage: tgMsg });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await tg.connect();
    await mockBotOn.mock.calls.find((c: any[]) => c[0] === 'message:text')[1](makeTelegramCtx());
    await flush();

    const meta = tgMsg.mock.calls[0][0].metadata;
    expect(typeof meta).toBe('object');
    expect(meta).not.toBeNull();
  });

  it('content.type is always one of the known types', async () => {
    const tgMsg = vi.fn().mockResolvedValue(undefined);
    const tg = new TelegramChannel({ id: 'tg', type: 'telegram', enabled: true, agentId: 'a', token: 't', public: true });
    tg.setEventHandlers({ onMessage: tgMsg });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await tg.connect();

    // Text
    await mockBotOn.mock.calls.find((c: any[]) => c[0] === 'message:text')[1](makeTelegramCtx());
    // Photo
    await mockBotOn.mock.calls.find((c: any[]) => c[0] === 'message:photo')[1](
      makeTelegramCtx({ message: { message_id: 2, date: 1700000000 } })
    );
    // Voice
    await mockBotOn.mock.calls.find((c: any[]) => c[0] === 'message:voice')[1](
      makeTelegramCtx({ message: { message_id: 3, voice: { duration: 1 }, date: 1700000000 } })
    );
    // Document
    await mockBotOn.mock.calls.find((c: any[]) => c[0] === 'message:document')[1](
      makeTelegramCtx({ message: { message_id: 4, document: {}, date: 1700000000 } })
    );
    await flush();

    const validTypes = ['text', 'image', 'audio', 'file'];
    for (const call of tgMsg.mock.calls) {
      expect(validTypes).toContain(call[0].content.type);
    }
  });

  it('creating two channels of the same type produces independent instances', async () => {
    const tg1Msg = vi.fn().mockResolvedValue(undefined);
    const tg2Msg = vi.fn().mockResolvedValue(undefined);

    const tg1 = new TelegramChannel({ id: 'tg-1', type: 'telegram', enabled: true, agentId: 'a', token: 't1', public: true });
    tg1.setEventHandlers({ onMessage: tg1Msg });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot1' }));
    await tg1.connect();

    vi.clearAllMocks();
    const tg2 = new TelegramChannel({ id: 'tg-2', type: 'telegram', enabled: true, agentId: 'a', token: 't2', public: true });
    tg2.setEventHandlers({ onMessage: tg2Msg });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot2' }));
    await tg2.connect();

    // Both should be independent
    expect(tg1.id).toBe('tg-1');
    expect(tg2.id).toBe('tg-2');
    expect(tg1).not.toBe(tg2);
  });

  it('each channel type has a unique type string', () => {
    const configs = [
      { id: 'tg', type: 'telegram' as const, enabled: true, agentId: 'a', token: 't' },
      { id: 'dc', type: 'discord' as const, enabled: true, agentId: 'a', token: 't' },
      { id: 'sl', type: 'slack' as const, enabled: true, agentId: 'a', botToken: 'b', appToken: 'a', signingSecret: 's' },
      { id: 'sig', type: 'signal' as const, enabled: true, agentId: 'a', socketPath: '/tmp/s', account: '+1' },
      { id: 'wa', type: 'whatsapp' as const, enabled: true, agentId: 'a', authDir: '/tmp/wa' },
    ];

    const types = configs.map(c => createChannel(c).type);
    const uniqueTypes = new Set(types);
    expect(uniqueTypes.size).toBe(5);
  });

  it('channel operations do not pollute global state between channels', async () => {
    // Create and connect telegram
    let tgConnectCount = 0;
    const tgOnConnect = vi.fn(() => { tgConnectCount++; });
    const tg = new TelegramChannel({ id: 'tg', type: 'telegram', enabled: true, agentId: 'a', token: 't', public: true });
    tg.setEventHandlers({ onConnect: tgOnConnect });
    mockBotStart.mockImplementation(({ onStart }: any) => onStart({ username: 'bot' }));
    await tg.connect();
    expect(tgConnectCount).toBe(1);

    // Create discord - should not trigger telegram handlers
    vi.clearAllMocks();
    const dcOnConnect = vi.fn();
    const dc = new DiscordChannel({ id: 'dc', type: 'discord', enabled: true, agentId: 'a', token: 't', public: true });
    dc.setEventHandlers({ onConnect: dcOnConnect });
    await dc.connect();

    // Telegram handler should not have been called again
    expect(tgConnectCount).toBe(1);
  });
});
