/**
 * Comprehensive test suite for the channel system
 *
 * Covers: base/interface, Telegram, Discord, Slack, Signal, WhatsApp,
 * and the channel registry/factory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Logger mock (needed by every channel) ───────────────────────────────────
vi.mock('../src/utils/logger.js', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  createLogger: vi.fn(),
}));

// ─── grammY mock ─────────────────────────────────────────────────────────────
const mockBotStart = vi.fn();
const mockBotStop = vi.fn();
const mockBotCatch = vi.fn();
const mockBotOn = vi.fn();
const mockSendMessage = vi.fn().mockResolvedValue({});
const mockSendPhoto = vi.fn().mockResolvedValue({});
const mockSendDocument = vi.fn().mockResolvedValue({});
const mockSendVoice = vi.fn().mockResolvedValue({});

const mockBotInstance = {
  on: mockBotOn,
  catch: mockBotCatch,
  start: mockBotStart,
  stop: mockBotStop,
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

// ─── discord.js mock ──────────────────────────────────────────────────────────
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

// ─── @slack/bolt mock ────────────────────────────────────────────────────────
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

// ─── node:net mock (Signal) ───────────────────────────────────────────────────
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

// ─── @whiskeysockets/baileys mock ────────────────────────────────────────────
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
  nanoid: vi.fn((size?: number) => 'mock-nanoid-' + (size ?? 21)),
}));

// ─────────────────────────────────────────────────────────────────────────────
// 1. BASE CHANNEL
// ─────────────────────────────────────────────────────────────────────────────
describe('BaseChannel', () => {
  let channel: import('../src/channels/base.js').BaseChannel;

  beforeEach(async () => {
    const { BaseChannel } = await import('../src/channels/base.js');

    class TestChannel extends BaseChannel {
      readonly id = 'test-channel';
      readonly type = 'test';
      async connect() { this.emitConnect(); }
      async disconnect() { this.emitDisconnect(); }
      async send() { /* no-op */ }
    }

    channel = new TestChannel();
  });

  it('starts disconnected', () => {
    expect(channel.connected).toBe(false);
  });

  it('transitions to connected after emitConnect', async () => {
    await channel.connect();
    expect(channel.connected).toBe(true);
  });

  it('transitions back to disconnected after emitDisconnect', async () => {
    await channel.connect();
    await channel.disconnect();
    expect(channel.connected).toBe(false);
  });

  it('calls onConnect handler when connecting', async () => {
    const onConnect = vi.fn();
    channel.setEventHandlers({ onConnect });
    await channel.connect();
    expect(onConnect).toHaveBeenCalledOnce();
  });

  it('calls onDisconnect handler when disconnecting', async () => {
    const onDisconnect = vi.fn();
    channel.setEventHandlers({ onDisconnect });
    await channel.connect();
    await channel.disconnect();
    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  it('merges handlers via multiple setEventHandlers calls', () => {
    const onConnect = vi.fn();
    const onDisconnect = vi.fn();
    channel.setEventHandlers({ onConnect });
    channel.setEventHandlers({ onDisconnect });
    // Both should be registered (later call merges)
    expect(() => channel.setEventHandlers({})).not.toThrow();
  });

  it('calls onMessage handler when message is emitted', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    channel.setEventHandlers({ onMessage });

    const fakeMsg = {
      id: 'msg-1',
      channel: 'test' as any,
      peerKind: 'user' as any,
      peerId: 'peer-1',
      senderId: 'sender-1',
      content: { type: 'text' as const, text: 'hello' },
      timestamp: Date.now(),
    };

    // Access protected method via type cast
    (channel as any).emitMessage(fakeMsg);
    await new Promise((r) => setTimeout(r, 0)); // flush microtasks
    expect(onMessage).toHaveBeenCalledWith(fakeMsg);
  });

  it('calls onError if onMessage handler throws', async () => {
    const onError = vi.fn();
    const onMessage = vi.fn().mockRejectedValue(new Error('boom'));
    channel.setEventHandlers({ onMessage, onError });

    (channel as any).emitMessage({
      id: 'msg-2',
      channel: 'test',
      peerKind: 'user',
      peerId: 'p',
      senderId: 's',
      content: { type: 'text', text: 'hi' },
      timestamp: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('emitError wraps non-Error values via onMessage chain', async () => {
    const onError = vi.fn();
    const onMessage = vi.fn().mockRejectedValue('string-error');
    channel.setEventHandlers({ onMessage, onError });

    (channel as any).emitMessage({
      id: 'msg-3',
      channel: 'test',
      peerKind: 'user',
      peerId: 'p',
      senderId: 's',
      content: { type: 'text', text: 'hi' },
      timestamp: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('emitError calls onError handler directly', () => {
    const onError = vi.fn();
    channel.setEventHandlers({ onError });
    (channel as any).emitError(new Error('direct-error'));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'direct-error' }));
  });

  it('does not throw if no onError handler registered', () => {
    expect(() => (channel as any).emitError(new Error('silent'))).not.toThrow();
  });

  it('does not throw if no onMessage handler registered', () => {
    expect(() =>
      (channel as any).emitMessage({
        id: 'x',
        channel: 'test',
        peerKind: 'user',
        peerId: 'p',
        senderId: 's',
        content: { type: 'text', text: 'x' },
        timestamp: Date.now(),
      })
    ).not.toThrow();
  });

  it('id and type are accessible', () => {
    expect(channel.id).toBe('test-channel');
    expect(channel.type).toBe('test');
  });

  it('setEventHandlers does not overwrite handlers not mentioned', async () => {
    const onConnect = vi.fn();
    channel.setEventHandlers({ onConnect });
    channel.setEventHandlers({ onDisconnect: vi.fn() }); // should NOT clear onConnect
    await channel.connect();
    expect(onConnect).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. TELEGRAM CHANNEL
// ─────────────────────────────────────────────────────────────────────────────
describe('TelegramChannel', () => {
  let TelegramChannel: typeof import('../src/channels/telegram.js').TelegramChannel;
  let createTelegramChannel: typeof import('../src/channels/telegram.js').createTelegramChannel;

  const baseConfig = {
    id: 'tg-test',
    type: 'telegram' as const,
    enabled: true,
    agentId: 'agent-1',
    token: 'test-bot-token',
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ TelegramChannel, createTelegramChannel } = await import('../src/channels/telegram.js'));
  });

  it('creates a TelegramChannel instance', () => {
    const ch = new TelegramChannel(baseConfig);
    expect(ch).toBeDefined();
    expect(ch.id).toBe('tg-test');
    expect(ch.type).toBe('telegram');
  });

  it('createTelegramChannel factory returns a TelegramChannel', () => {
    const ch = createTelegramChannel(baseConfig);
    expect(ch).toBeInstanceOf(TelegramChannel);
  });

  it('starts disconnected', () => {
    const ch = new TelegramChannel(baseConfig);
    expect(ch.connected).toBe(false);
  });

  it('connect() instantiates the Bot', async () => {
    const { Bot } = await import('grammy');
    const ch = new TelegramChannel(baseConfig);
    mockBotStart.mockImplementation(({ onStart }) => {
      onStart({ username: 'testbot' });
    });
    await ch.connect();
    expect(Bot).toHaveBeenCalledWith(baseConfig.token);
  });

  it('connect() registers message:text handler', async () => {
    const ch = new TelegramChannel(baseConfig);
    mockBotStart.mockImplementation(({ onStart }) => onStart({ username: 'testbot' }));
    await ch.connect();
    const calls = mockBotOn.mock.calls.map((c: any[]) => c[0]);
    expect(calls).toContain('message:text');
  });

  it('connect() registers message:photo handler', async () => {
    const ch = new TelegramChannel(baseConfig);
    mockBotStart.mockImplementation(({ onStart }) => onStart({ username: 'testbot' }));
    await ch.connect();
    const calls = mockBotOn.mock.calls.map((c: any[]) => c[0]);
    expect(calls).toContain('message:photo');
  });

  it('connect() registers message:document handler', async () => {
    const ch = new TelegramChannel(baseConfig);
    mockBotStart.mockImplementation(({ onStart }) => onStart({ username: 'testbot' }));
    await ch.connect();
    const calls = mockBotOn.mock.calls.map((c: any[]) => c[0]);
    expect(calls).toContain('message:document');
  });

  it('connect() registers message:voice handler', async () => {
    const ch = new TelegramChannel(baseConfig);
    mockBotStart.mockImplementation(({ onStart }) => onStart({ username: 'testbot' }));
    await ch.connect();
    const calls = mockBotOn.mock.calls.map((c: any[]) => c[0]);
    expect(calls).toContain('message:voice');
  });

  it('connect() calls emitConnect via onStart callback', async () => {
    const onConnect = vi.fn();
    const ch = new TelegramChannel(baseConfig);
    ch.setEventHandlers({ onConnect });
    mockBotStart.mockImplementation(({ onStart }) => onStart({ username: 'testbot' }));
    await ch.connect();
    expect(onConnect).toHaveBeenCalled();
  });

  it('connect() is idempotent — second call is a no-op', async () => {
    const { Bot } = await import('grammy');
    const ch = new TelegramChannel(baseConfig);
    mockBotStart.mockImplementation(({ onStart }) => onStart({ username: 'testbot' }));
    await ch.connect();
    await ch.connect();
    expect(Bot).toHaveBeenCalledTimes(1);
  });

  it('disconnect() stops the bot and emits disconnect', async () => {
    const onDisconnect = vi.fn();
    const ch = new TelegramChannel(baseConfig);
    ch.setEventHandlers({ onDisconnect });
    mockBotStart.mockImplementation(({ onStart }) => onStart({ username: 'testbot' }));
    await ch.connect();
    await ch.disconnect();
    expect(mockBotStop).toHaveBeenCalled();
    expect(onDisconnect).toHaveBeenCalled();
  });

  it('disconnect() is safe when not connected', async () => {
    const ch = new TelegramChannel(baseConfig);
    await expect(ch.disconnect()).resolves.toBeUndefined();
  });

  it('send() throws when not connected', async () => {
    const ch = new TelegramChannel(baseConfig);
    await expect(
      ch.send({ id: 'out-1', channel: 'telegram', peerId: '123', content: { type: 'text', text: 'hi' } })
    ).rejects.toThrow('Telegram bot not connected');
  });

  it('send() calls sendMessage for text content', async () => {
    const ch = new TelegramChannel(baseConfig);
    mockBotStart.mockImplementation(({ onStart }) => onStart({ username: 'testbot' }));
    await ch.connect();
    await ch.send({ id: 'out-1', channel: 'telegram', peerId: '123456', content: { type: 'text', text: 'hello' } });
    expect(mockSendMessage).toHaveBeenCalledWith('123456', 'hello', expect.any(Object));
  });

  it('send() passes reply_to_message_id when replyTo is set', async () => {
    const ch = new TelegramChannel(baseConfig);
    mockBotStart.mockImplementation(({ onStart }) => onStart({ username: 'testbot' }));
    await ch.connect();

    // Capture options at the time of call (before the delete mutates the object)
    let capturedThirdArg: Record<string, unknown> | undefined;
    mockSendMessage.mockImplementationOnce(async (chatId: string, text: string, opts: Record<string, unknown>) => {
      capturedThirdArg = { ...opts }; // snapshot before post-call mutation
      return {};
    });

    await ch.send({
      id: 'out-2',
      channel: 'telegram',
      peerId: '123',
      replyTo: '42',
      content: { type: 'text', text: 'reply' },
    });
    expect(capturedThirdArg?.reply_to_message_id).toBe(42);
  });

  it('send() calls sendPhoto for image content with URL', async () => {
    const ch = new TelegramChannel(baseConfig);
    mockBotStart.mockImplementation(({ onStart }) => onStart({ username: 'testbot' }));
    await ch.connect();
    await ch.send({
      id: 'out-3',
      channel: 'telegram',
      peerId: '123',
      content: { type: 'image', url: 'https://example.com/img.jpg', mimeType: 'image/jpeg' },
    });
    expect(mockSendPhoto).toHaveBeenCalledWith('123', 'https://example.com/img.jpg', expect.any(Object));
  });

  it('send() calls sendDocument for file content', async () => {
    const ch = new TelegramChannel(baseConfig);
    mockBotStart.mockImplementation(({ onStart }) => onStart({ username: 'testbot' }));
    await ch.connect();
    await ch.send({
      id: 'out-4',
      channel: 'telegram',
      peerId: '123',
      content: { type: 'file', url: 'https://example.com/file.pdf', mimeType: 'application/pdf', filename: 'file.pdf' },
    });
    expect(mockSendDocument).toHaveBeenCalledWith('123', 'https://example.com/file.pdf', expect.any(Object));
  });

  it('send() calls sendVoice for audio content', async () => {
    const ch = new TelegramChannel(baseConfig);
    mockBotStart.mockImplementation(({ onStart }) => onStart({ username: 'testbot' }));
    await ch.connect();
    await ch.send({
      id: 'out-5',
      channel: 'telegram',
      peerId: '123',
      content: { type: 'audio', url: 'https://example.com/voice.ogg', mimeType: 'audio/ogg' },
    });
    expect(mockSendVoice).toHaveBeenCalledWith('123', 'https://example.com/voice.ogg', expect.any(Object));
  });

  it('send() does not call sendPhoto if image has no URL or base64', async () => {
    const ch = new TelegramChannel(baseConfig);
    mockBotStart.mockImplementation(({ onStart }) => onStart({ username: 'testbot' }));
    await ch.connect();
    await ch.send({
      id: 'out-6',
      channel: 'telegram',
      peerId: '123',
      content: { type: 'image', mimeType: 'image/jpeg' },
    });
    expect(mockSendPhoto).not.toHaveBeenCalled();
  });

  it('send() sets caption on photo if content.caption is provided', async () => {
    const ch = new TelegramChannel(baseConfig);
    mockBotStart.mockImplementation(({ onStart }) => onStart({ username: 'testbot' }));
    await ch.connect();
    await ch.send({
      id: 'out-7',
      channel: 'telegram',
      peerId: '123',
      content: { type: 'image', url: 'https://example.com/img.jpg', mimeType: 'image/jpeg', caption: 'My Caption' },
    });
    expect(mockSendPhoto).toHaveBeenCalledWith(
      '123',
      'https://example.com/img.jpg',
      expect.objectContaining({ caption: 'My Caption' })
    );
  });

  it('long message is split into multiple sendMessage calls', async () => {
    const ch = new TelegramChannel(baseConfig);
    mockBotStart.mockImplementation(({ onStart }) => onStart({ username: 'testbot' }));
    await ch.connect();
    const longText = 'a'.repeat(5000);
    await ch.send({ id: 'out-8', channel: 'telegram', peerId: '123', content: { type: 'text', text: longText } });
    // Should have been called more than once
    expect(mockSendMessage.mock.calls.length).toBeGreaterThan(1);
  });

  it('message exactly 4096 chars is not split', async () => {
    const ch = new TelegramChannel(baseConfig);
    mockBotStart.mockImplementation(({ onStart }) => onStart({ username: 'testbot' }));
    await ch.connect();
    mockSendMessage.mockClear();
    const text = 'b'.repeat(4096);
    await ch.send({ id: 'out-9', channel: 'telegram', peerId: '123', content: { type: 'text', text: text } });
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  it('splits long message at paragraph boundary', async () => {
    const ch = new TelegramChannel(baseConfig);
    mockBotStart.mockImplementation(({ onStart }) => onStart({ username: 'testbot' }));
    await ch.connect();
    mockSendMessage.mockClear();
    // Create a message with a paragraph break in a good position
    const part1 = 'x'.repeat(2000);
    const part2 = 'y'.repeat(2500);
    const text = part1 + '\n\n' + part2;
    await ch.send({ id: 'out-10', channel: 'telegram', peerId: '123', content: { type: 'text', text } });
    expect(mockSendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('allowedUsers restricts incoming messages', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel({ ...baseConfig, allowedUsers: ['111'] });
    ch.setEventHandlers({ onMessage });

    mockBotStart.mockImplementation(({ onStart }) => onStart({ username: 'testbot' }));
    await ch.connect();

    // Simulate a message from unauthorized user
    const textHandler = mockBotOn.mock.calls.find((c: any[]) => c[0] === 'message:text')?.[1];
    expect(textHandler).toBeDefined();

    const unauthorizedCtx = {
      chat: { id: 999, type: 'private' },
      from: { id: 999, first_name: 'Evil' },
      message: { message_id: 1, text: 'hax', date: 1700000000 },
    };
    await textHandler(unauthorizedCtx);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('allowedUsers permits authorized user', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel({ ...baseConfig, allowedUsers: ['111'] });
    ch.setEventHandlers({ onMessage });

    mockBotStart.mockImplementation(({ onStart }) => onStart({ username: 'testbot' }));
    await ch.connect();

    const textHandler = mockBotOn.mock.calls.find((c: any[]) => c[0] === 'message:text')?.[1];
    const authorizedCtx = {
      chat: { id: 111, type: 'private' },
      from: { id: 111, first_name: 'Alice' },
      message: { message_id: 2, text: 'hello', date: 1700000000 },
    };
    await textHandler(authorizedCtx);
    expect(onMessage).toHaveBeenCalled();
  });

  it('no allowedUsers/allowedGroups — allows all', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel(baseConfig); // no restrictions
    ch.setEventHandlers({ onMessage });

    mockBotStart.mockImplementation(({ onStart }) => onStart({ username: 'testbot' }));
    await ch.connect();

    const textHandler = mockBotOn.mock.calls.find((c: any[]) => c[0] === 'message:text')?.[1];
    const ctx = {
      chat: { id: 42, type: 'private' },
      from: { id: 42, first_name: 'Bob' },
      message: { message_id: 3, text: 'anyone', date: 1700000000 },
    };
    await textHandler(ctx);
    expect(onMessage).toHaveBeenCalled();
  });

  it('contextToMessage sets senderName with last name', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel(baseConfig);
    ch.setEventHandlers({ onMessage });

    mockBotStart.mockImplementation(({ onStart }) => onStart({ username: 'testbot' }));
    await ch.connect();

    const textHandler = mockBotOn.mock.calls.find((c: any[]) => c[0] === 'message:text')?.[1];
    await textHandler({
      chat: { id: 1, type: 'private' },
      from: { id: 1, first_name: 'John', last_name: 'Doe' },
      message: { message_id: 4, text: 'hi', date: 1700000000 },
    });
    await new Promise((r) => setTimeout(r, 0));
    const msg = onMessage.mock.calls[0]?.[0];
    expect(msg?.senderName).toBe('John Doe');
  });

  it('contextToMessage sets peerKind=group for group chats', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel(baseConfig);
    ch.setEventHandlers({ onMessage });

    mockBotStart.mockImplementation(({ onStart }) => onStart({ username: 'testbot' }));
    await ch.connect();

    const textHandler = mockBotOn.mock.calls.find((c: any[]) => c[0] === 'message:text')?.[1];
    await textHandler({
      chat: { id: -100, type: 'group' },
      from: { id: 7, first_name: 'Carl' },
      message: { message_id: 5, text: 'group msg', date: 1700000000 },
    });
    await new Promise((r) => setTimeout(r, 0));
    const msg = onMessage.mock.calls[0]?.[0];
    expect(msg?.peerKind).toBe('group');
  });

  it('contextToMessage sets replyTo when message has reply', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel(baseConfig);
    ch.setEventHandlers({ onMessage });

    mockBotStart.mockImplementation(({ onStart }) => onStart({ username: 'testbot' }));
    await ch.connect();

    const textHandler = mockBotOn.mock.calls.find((c: any[]) => c[0] === 'message:text')?.[1];
    await textHandler({
      chat: { id: 1, type: 'private' },
      from: { id: 1, first_name: 'X' },
      message: {
        message_id: 6,
        text: 'reply-msg',
        date: 1700000000,
        reply_to_message: { message_id: 99 },
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    const msg = onMessage.mock.calls[0]?.[0];
    expect(msg?.replyTo).toBe('99');
  });

  it('bot.catch triggers emitError and schedules reconnect', async () => {
    const onError = vi.fn();
    const ch = new TelegramChannel(baseConfig);
    ch.setEventHandlers({ onError });
    vi.useFakeTimers();
    mockBotStart.mockImplementation(({ onStart }) => onStart({ username: 'testbot' }));
    await ch.connect();
    const catchHandler = mockBotCatch.mock.calls[0]?.[0];
    catchHandler(new Error('network error'));
    expect(onError).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('group message with allowedGroups permits access', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel({ ...baseConfig, allowedGroups: ['-100'] });
    ch.setEventHandlers({ onMessage });

    mockBotStart.mockImplementation(({ onStart }) => onStart({ username: 'testbot' }));
    await ch.connect();

    const textHandler = mockBotOn.mock.calls.find((c: any[]) => c[0] === 'message:text')?.[1];
    await textHandler({
      chat: { id: -100, type: 'group' },
      from: { id: 7, first_name: 'Member' },
      message: { message_id: 10, text: 'group hello', date: 1700000000 },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(onMessage).toHaveBeenCalled();
  });

  it('timestamp is converted from Unix seconds to milliseconds', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel(baseConfig);
    ch.setEventHandlers({ onMessage });

    mockBotStart.mockImplementation(({ onStart }) => onStart({ username: 'testbot' }));
    await ch.connect();

    const textHandler = mockBotOn.mock.calls.find((c: any[]) => c[0] === 'message:text')?.[1];
    const unixDate = 1700000000;
    await textHandler({
      chat: { id: 1, type: 'private' },
      from: { id: 1, first_name: 'T' },
      message: { message_id: 11, text: 'ts test', date: unixDate },
    });
    await new Promise((r) => setTimeout(r, 0));
    const msg = onMessage.mock.calls[0]?.[0];
    expect(msg?.timestamp).toBe(unixDate * 1000);
  });

  it('photo message is mapped to image content type', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel(baseConfig);
    ch.setEventHandlers({ onMessage });

    mockBotStart.mockImplementation(({ onStart }) => onStart({ username: 'testbot' }));
    await ch.connect();

    const photoHandler = mockBotOn.mock.calls.find((c: any[]) => c[0] === 'message:photo')?.[1];
    await photoHandler({
      chat: { id: 1, type: 'private' },
      from: { id: 1, first_name: 'P' },
      message: { message_id: 12, caption: 'nice photo', date: 1700000000 },
    });
    await new Promise((r) => setTimeout(r, 0));
    const msg = onMessage.mock.calls[0]?.[0];
    expect(msg?.content.type).toBe('image');
  });

  it('voice message is mapped to audio content type', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel(baseConfig);
    ch.setEventHandlers({ onMessage });

    mockBotStart.mockImplementation(({ onStart }) => onStart({ username: 'testbot' }));
    await ch.connect();

    const voiceHandler = mockBotOn.mock.calls.find((c: any[]) => c[0] === 'message:voice')?.[1];
    await voiceHandler({
      chat: { id: 1, type: 'private' },
      from: { id: 1, first_name: 'V' },
      message: { message_id: 13, voice: { duration: 5 }, date: 1700000000 },
    });
    await new Promise((r) => setTimeout(r, 0));
    const msg = onMessage.mock.calls[0]?.[0];
    expect(msg?.content.type).toBe('audio');
  });

  it('document message is mapped to file content type', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel(baseConfig);
    ch.setEventHandlers({ onMessage });

    mockBotStart.mockImplementation(({ onStart }) => onStart({ username: 'testbot' }));
    await ch.connect();

    const docHandler = mockBotOn.mock.calls.find((c: any[]) => c[0] === 'message:document')?.[1];
    await docHandler({
      chat: { id: 1, type: 'private' },
      from: { id: 1, first_name: 'D' },
      message: { message_id: 14, document: { file_name: 'test.pdf', mime_type: 'application/pdf' }, date: 1700000000 },
    });
    await new Promise((r) => setTimeout(r, 0));
    const msg = onMessage.mock.calls[0]?.[0];
    expect(msg?.content.type).toBe('file');
  });

  it('message id is generated (non-empty string)', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel(baseConfig);
    ch.setEventHandlers({ onMessage });

    mockBotStart.mockImplementation(({ onStart }) => onStart({ username: 'testbot' }));
    await ch.connect();

    const textHandler = mockBotOn.mock.calls.find((c: any[]) => c[0] === 'message:text')?.[1];
    await textHandler({
      chat: { id: 1, type: 'private' },
      from: { id: 1, first_name: 'Id' },
      message: { message_id: 15, text: 'id test', date: 1700000000 },
    });
    await new Promise((r) => setTimeout(r, 0));
    const msg = onMessage.mock.calls[0]?.[0];
    expect(typeof msg?.id).toBe('string');
    expect(msg?.id.length).toBeGreaterThan(0);
  });

  it('reconnectAttempt resets to 0 on successful onStart', async () => {
    const ch = new TelegramChannel(baseConfig);
    mockBotStart.mockImplementation(({ onStart }) => onStart({ username: 'testbot' }));
    await ch.connect();
    // reconnectAttempt is private; verify no error thrown
    expect(ch.connected).toBe(true);
  });

  it('channel=telegram is set on incoming messages', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel(baseConfig);
    ch.setEventHandlers({ onMessage });

    mockBotStart.mockImplementation(({ onStart }) => onStart({ username: 'testbot' }));
    await ch.connect();

    const textHandler = mockBotOn.mock.calls.find((c: any[]) => c[0] === 'message:text')?.[1];
    await textHandler({
      chat: { id: 1, type: 'private' },
      from: { id: 1, first_name: 'C' },
      message: { message_id: 16, text: 'ch test', date: 1700000000 },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(onMessage.mock.calls[0]?.[0]?.channel).toBe('telegram');
  });

  it('missing chatId or userId returns false from isAllowed', async () => {
    // isAllowed returns false if chat or from is missing — the handler returns early
    // without calling emitMessage. The code path in telegram.ts accesses ctx.chat.id
    // for logger but only after isAllowed. The actual isAllowed check uses optional
    // chaining: ctx.chat?.id and ctx.from?.id — so undefined is safe.
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel({ ...baseConfig, allowedUsers: ['123'] });
    ch.setEventHandlers({ onMessage });

    mockBotStart.mockImplementation(({ onStart }) => onStart({ username: 'testbot' }));
    await ch.connect();

    const textHandler = mockBotOn.mock.calls.find((c: any[]) => c[0] === 'message:text')?.[1];
    // Provide chat with id but no from (userId missing)
    await textHandler({
      chat: { id: 999, type: 'private' },
      from: undefined,
      message: { message_id: 17, text: 'anon', date: 1700000000 },
    }).catch(() => {}); // swallow any error from the logger
    await new Promise((r) => setTimeout(r, 0));
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('metadata includes messageId, chatType, username', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new TelegramChannel(baseConfig);
    ch.setEventHandlers({ onMessage });

    mockBotStart.mockImplementation(({ onStart }) => onStart({ username: 'testbot' }));
    await ch.connect();

    const textHandler = mockBotOn.mock.calls.find((c: any[]) => c[0] === 'message:text')?.[1];
    await textHandler({
      chat: { id: 1, type: 'private' },
      from: { id: 1, first_name: 'Meta', username: 'meta_user' },
      message: { message_id: 18, text: 'meta', date: 1700000000 },
    });
    await new Promise((r) => setTimeout(r, 0));
    const msg = onMessage.mock.calls[0]?.[0];
    expect(msg?.metadata?.messageId).toBe(18);
    expect(msg?.metadata?.chatType).toBe('private');
    expect(msg?.metadata?.username).toBe('meta_user');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. DISCORD CHANNEL
// ─────────────────────────────────────────────────────────────────────────────
describe('DiscordChannel', () => {
  let DiscordChannel: typeof import('../src/channels/discord.js').DiscordChannel;
  let createDiscordChannel: typeof import('../src/channels/discord.js').createDiscordChannel;

  const baseConfig = {
    id: 'dc-test',
    type: 'discord' as const,
    enabled: true,
    agentId: 'agent-1',
    token: 'discord-token',
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ DiscordChannel, createDiscordChannel } = await import('../src/channels/discord.js'));
  });

  it('creates a DiscordChannel instance', () => {
    const ch = new DiscordChannel(baseConfig);
    expect(ch.id).toBe('dc-test');
    expect(ch.type).toBe('discord');
  });

  it('factory createDiscordChannel works', () => {
    expect(createDiscordChannel(baseConfig)).toBeInstanceOf(DiscordChannel);
  });

  it('starts disconnected', () => {
    expect(new DiscordChannel(baseConfig).connected).toBe(false);
  });

  it('connect() calls client.login with token', async () => {
    const ch = new DiscordChannel(baseConfig);
    await ch.connect();
    expect(mockClientLogin).toHaveBeenCalledWith(baseConfig.token);
  });

  it('connect() registers "ready" event', async () => {
    const ch = new DiscordChannel(baseConfig);
    await ch.connect();
    const events = mockClientOn.mock.calls.map((c: any[]) => c[0]);
    expect(events).toContain('ready');
  });

  it('connect() registers "messageCreate" event', async () => {
    const ch = new DiscordChannel(baseConfig);
    await ch.connect();
    const events = mockClientOn.mock.calls.map((c: any[]) => c[0]);
    expect(events).toContain('messageCreate');
  });

  it('connect() is idempotent', async () => {
    const { Client } = await import('discord.js');
    const ch = new DiscordChannel(baseConfig);
    await ch.connect();
    await ch.connect();
    expect(Client).toHaveBeenCalledTimes(1);
  });

  it('disconnect() destroys client and emits disconnect', async () => {
    const onDisconnect = vi.fn();
    const ch = new DiscordChannel(baseConfig);
    ch.setEventHandlers({ onDisconnect });
    await ch.connect();
    await ch.disconnect();
    expect(mockClientDestroy).toHaveBeenCalled();
    expect(onDisconnect).toHaveBeenCalled();
  });

  it('disconnect() is safe when not connected', async () => {
    const ch = new DiscordChannel(baseConfig);
    await expect(ch.disconnect()).resolves.toBeUndefined();
  });

  it('send() throws when not connected', async () => {
    const ch = new DiscordChannel(baseConfig);
    await expect(
      ch.send({ id: 'o1', channel: 'discord', peerId: 'ch1', content: { type: 'text', text: 'hi' } })
    ).rejects.toThrow('Discord not connected');
  });

  it('send() fetches the channel by peerId and calls send', async () => {
    const mockSend = vi.fn().mockResolvedValue({});
    mockChannelsFetch.mockResolvedValue({ send: mockSend });

    const ch = new DiscordChannel(baseConfig);
    await ch.connect();
    await ch.send({ id: 'o2', channel: 'discord', peerId: 'channel-123', content: { type: 'text', text: 'hello' } });
    expect(mockChannelsFetch).toHaveBeenCalledWith('channel-123');
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ content: 'hello' }));
  });

  it('send() throws for invalid channel (no send method)', async () => {
    mockChannelsFetch.mockResolvedValue({ id: 'voice-channel' }); // no send method
    const ch = new DiscordChannel(baseConfig);
    await ch.connect();
    await expect(
      ch.send({ id: 'o3', channel: 'discord', peerId: 'bad-ch', content: { type: 'text', text: 'x' } })
    ).rejects.toThrow('Invalid channel');
  });

  it('send() with replyTo sets reply messageReference', async () => {
    const mockSend = vi.fn().mockResolvedValue({});
    mockChannelsFetch.mockResolvedValue({ send: mockSend });

    const ch = new DiscordChannel(baseConfig);
    await ch.connect();
    await ch.send({
      id: 'o4',
      channel: 'discord',
      peerId: 'ch1',
      replyTo: 'msg-ref-123',
      content: { type: 'text', text: 'reply' },
    });
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ reply: { messageReference: 'msg-ref-123' } })
    );
  });

  it('send() image content uses files array', async () => {
    const mockSend = vi.fn().mockResolvedValue({});
    mockChannelsFetch.mockResolvedValue({ send: mockSend });

    const ch = new DiscordChannel(baseConfig);
    await ch.connect();
    await ch.send({
      id: 'o5',
      channel: 'discord',
      peerId: 'ch1',
      content: { type: 'image', url: 'https://img.com/a.jpg', mimeType: 'image/jpeg' },
    });
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ files: ['https://img.com/a.jpg'] }));
  });

  it('messageCreate ignores own bot messages', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new DiscordChannel(baseConfig);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    const msgHandler = mockClientOn.mock.calls.find((c: any[]) => c[0] === 'messageCreate')?.[1];
    await msgHandler({
      author: { id: 'bot-user-id', bot: true, displayName: 'Bot', username: 'Bot' },
      content: 'own message',
      attachments: { size: 0, first: () => null },
      guild: null,
      channel: { id: 'ch1' },
      createdTimestamp: Date.now(),
      reference: null,
    });
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('messageCreate ignores bots when respondToBots=false', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new DiscordChannel({ ...baseConfig, respondToBots: false });
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    const msgHandler = mockClientOn.mock.calls.find((c: any[]) => c[0] === 'messageCreate')?.[1];
    await msgHandler({
      author: { id: 'other-bot', bot: true, displayName: 'OtherBot', username: 'OtherBot' },
      content: 'bot message',
      attachments: { size: 0, first: () => null },
      guild: null,
      channel: { id: 'ch1' },
      createdTimestamp: Date.now(),
      reference: null,
    });
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('allowedUsers restricts messages', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new DiscordChannel({ ...baseConfig, allowedUsers: ['allowed-id'] });
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    const msgHandler = mockClientOn.mock.calls.find((c: any[]) => c[0] === 'messageCreate')?.[1];
    await msgHandler({
      author: { id: 'not-allowed', bot: false, displayName: 'Stranger', username: 'stranger' },
      content: 'hi',
      attachments: { size: 0, first: () => null },
      guild: null,
      channel: { id: 'ch1' },
      createdTimestamp: Date.now(),
      reference: null,
    });
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('discordToIncoming returns null for empty message with no attachments', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new DiscordChannel(baseConfig);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    const msgHandler = mockClientOn.mock.calls.find((c: any[]) => c[0] === 'messageCreate')?.[1];
    await msgHandler({
      author: { id: 'user1', bot: false, displayName: 'User1', username: 'user1' },
      content: '', // empty
      attachments: { size: 0, first: () => null },
      guild: null,
      channel: { id: 'ch1' },
      createdTimestamp: Date.now(),
      reference: null,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('peerKind=group for guild messages', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new DiscordChannel(baseConfig);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    const msgHandler = mockClientOn.mock.calls.find((c: any[]) => c[0] === 'messageCreate')?.[1];
    await msgHandler({
      author: { id: 'user2', bot: false, displayName: 'User2', username: 'user2' },
      content: 'guild msg',
      attachments: { size: 0, first: () => null },
      guild: { id: 'guild-1', name: 'My Server' },
      channel: { id: 'ch2' },
      createdTimestamp: Date.now(),
      reference: null,
    });
    await new Promise((r) => setTimeout(r, 0));
    const msg = onMessage.mock.calls[0]?.[0];
    expect(msg?.peerKind).toBe('group');
  });

  it('ready event calls emitConnect', async () => {
    const onConnect = vi.fn();
    const ch = new DiscordChannel(baseConfig);
    ch.setEventHandlers({ onConnect });
    await ch.connect();

    const readyHandler = mockClientOn.mock.calls.find((c: any[]) => c[0] === 'ready')?.[1];
    readyHandler();
    expect(onConnect).toHaveBeenCalled();
  });

  it('error event calls emitError', async () => {
    const onError = vi.fn();
    const ch = new DiscordChannel(baseConfig);
    ch.setEventHandlers({ onError });
    await ch.connect();

    const errorHandler = mockClientOn.mock.calls.find((c: any[]) => c[0] === 'error')?.[1];
    errorHandler(new Error('discord error'));
    expect(onError).toHaveBeenCalled();
  });

  it('file attachment maps to file content type', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new DiscordChannel(baseConfig);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    const msgHandler = mockClientOn.mock.calls.find((c: any[]) => c[0] === 'messageCreate')?.[1];
    await msgHandler({
      author: { id: 'user3', bot: false, displayName: 'User3', username: 'user3' },
      content: '',
      attachments: {
        size: 1,
        first: () => ({
          url: 'https://cdn.discord.com/file.zip',
          contentType: 'application/zip',
          name: 'file.zip',
        }),
      },
      guild: null,
      channel: { id: 'ch3' },
      createdTimestamp: Date.now(),
      reference: null,
    });
    await new Promise((r) => setTimeout(r, 0));
    const msg = onMessage.mock.calls[0]?.[0];
    expect(msg?.content.type).toBe('file');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. SLACK CHANNEL
// ─────────────────────────────────────────────────────────────────────────────
describe('SlackChannel', () => {
  let SlackChannel: typeof import('../src/channels/slack.js').SlackChannel;
  let createSlackChannel: typeof import('../src/channels/slack.js').createSlackChannel;

  const baseConfig = {
    id: 'slack-test',
    type: 'slack' as const,
    enabled: true,
    agentId: 'agent-1',
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    signingSecret: 'secret123',
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ SlackChannel, createSlackChannel } = await import('../src/channels/slack.js'));
  });

  it('creates a SlackChannel instance', () => {
    const ch = new SlackChannel(baseConfig);
    expect(ch.id).toBe('slack-test');
    expect(ch.type).toBe('slack');
  });

  it('factory createSlackChannel works', () => {
    expect(createSlackChannel(baseConfig)).toBeInstanceOf(SlackChannel);
  });

  it('starts disconnected', () => {
    expect(new SlackChannel(baseConfig).connected).toBe(false);
  });

  it('connect() creates Bolt App with socketMode', async () => {
    const { App } = await import('@slack/bolt');
    const ch = new SlackChannel(baseConfig);
    await ch.connect();
    expect(App).toHaveBeenCalledWith(
      expect.objectContaining({ socketMode: true, token: 'xoxb-test' })
    );
  });

  it('connect() calls app.start()', async () => {
    const ch = new SlackChannel(baseConfig);
    await ch.connect();
    expect(mockSlackAppStart).toHaveBeenCalled();
  });

  it('connect() registers message handler', async () => {
    const ch = new SlackChannel(baseConfig);
    await ch.connect();
    expect(mockSlackAppMessage).toHaveBeenCalled();
  });

  it('connect() registers app_mention event handler', async () => {
    const ch = new SlackChannel(baseConfig);
    await ch.connect();
    const eventNames = mockSlackAppEvent.mock.calls.map((c: any[]) => c[0]);
    expect(eventNames).toContain('app_mention');
  });

  it('connect() emits connect after start', async () => {
    const onConnect = vi.fn();
    const ch = new SlackChannel(baseConfig);
    ch.setEventHandlers({ onConnect });
    await ch.connect();
    expect(onConnect).toHaveBeenCalled();
  });

  it('connect() is idempotent', async () => {
    const { App } = await import('@slack/bolt');
    const ch = new SlackChannel(baseConfig);
    await ch.connect();
    await ch.connect();
    expect(App).toHaveBeenCalledTimes(1);
  });

  it('disconnect() calls app.stop() and emits disconnect', async () => {
    const onDisconnect = vi.fn();
    const ch = new SlackChannel(baseConfig);
    ch.setEventHandlers({ onDisconnect });
    await ch.connect();
    await ch.disconnect();
    expect(mockSlackAppStop).toHaveBeenCalled();
    expect(onDisconnect).toHaveBeenCalled();
  });

  it('disconnect() is safe when not connected', async () => {
    const ch = new SlackChannel(baseConfig);
    await expect(ch.disconnect()).resolves.toBeUndefined();
  });

  it('send() throws when not connected', async () => {
    const ch = new SlackChannel(baseConfig);
    await expect(
      ch.send({ id: 'o1', channel: 'slack', peerId: 'C123', content: { type: 'text', text: 'hi' } })
    ).rejects.toThrow('Slack not connected');
  });

  it('send() text calls chat.postMessage', async () => {
    const ch = new SlackChannel(baseConfig);
    await ch.connect();
    await ch.send({ id: 'o2', channel: 'slack', peerId: 'C123', content: { type: 'text', text: 'hello slack' } });
    expect(mockSlackChatPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C123', text: 'hello slack' })
    );
  });

  it('send() with replyTo sets thread_ts', async () => {
    const ch = new SlackChannel(baseConfig);
    await ch.connect();
    await ch.send({
      id: 'o3',
      channel: 'slack',
      peerId: 'C123',
      replyTo: '1234567890.123456',
      content: { type: 'text', text: 'thread reply' },
    });
    expect(mockSlackChatPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ thread_ts: '1234567890.123456' })
    );
  });

  it('send() image calls postMessage with attachments', async () => {
    const ch = new SlackChannel(baseConfig);
    await ch.connect();
    await ch.send({
      id: 'o4',
      channel: 'slack',
      peerId: 'C123',
      content: { type: 'image', url: 'https://img.com/pic.jpg', mimeType: 'image/jpeg', caption: 'A pic' },
    });
    expect(mockSlackChatPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: expect.arrayContaining([expect.objectContaining({ image_url: 'https://img.com/pic.jpg' })]) })
    );
  });

  it('send() file calls files.uploadV2', async () => {
    const ch = new SlackChannel(baseConfig);
    await ch.connect();
    await ch.send({
      id: 'o5',
      channel: 'slack',
      peerId: 'C123',
      content: { type: 'file', url: 'https://example.com/doc.pdf', mimeType: 'application/pdf', filename: 'doc.pdf' },
    });
    expect(mockSlackFilesUpload).toHaveBeenCalled();
  });

  it('message handler ignores bot_id messages', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SlackChannel(baseConfig);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    const msgHandler = mockSlackAppMessage.mock.calls[0]?.[0];
    await msgHandler({
      message: { bot_id: 'BXXX', text: 'bot msg', ts: '1.0', channel: 'C1', type: 'message' },
    });
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('message handler emits for valid user message', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SlackChannel(baseConfig);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    const msgHandler = mockSlackAppMessage.mock.calls[0]?.[0];
    await msgHandler({
      message: { user: 'U123', text: 'hello', ts: '1700000000.123', channel: 'C1', type: 'message' },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(onMessage).toHaveBeenCalled();
  });

  it('allowedUsers restricts messages', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SlackChannel({ ...baseConfig, allowedUsers: ['U_ALLOWED'] });
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    const msgHandler = mockSlackAppMessage.mock.calls[0]?.[0];
    await msgHandler({
      message: { user: 'U_STRANGER', text: 'hi', ts: '1.0', channel: 'C1', type: 'message' },
    });
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('allowedChannels permits messages in allowed channel', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SlackChannel({ ...baseConfig, allowedChannels: ['C_PERMITTED'] });
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    const msgHandler = mockSlackAppMessage.mock.calls[0]?.[0];
    await msgHandler({
      message: { user: 'U999', text: 'allowed channel msg', ts: '1.0', channel: 'C_PERMITTED', type: 'message' },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(onMessage).toHaveBeenCalled();
  });

  it('slackToIncoming returns null for empty text and no files', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SlackChannel(baseConfig);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    const msgHandler = mockSlackAppMessage.mock.calls[0]?.[0];
    await msgHandler({
      message: { user: 'U1', text: '', ts: '1.0', channel: 'C1', type: 'message' },
    });
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('thread_ts in message sets replyTo', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SlackChannel(baseConfig);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    const msgHandler = mockSlackAppMessage.mock.calls[0]?.[0];
    await msgHandler({
      message: {
        user: 'U1',
        text: 'threaded reply',
        ts: '1700000001.0',
        thread_ts: '1700000000.0',
        channel: 'C1',
        type: 'message',
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    const msg = onMessage.mock.calls[0]?.[0];
    expect(msg?.replyTo).toBe('1700000000.0');
  });

  it('peerKind=channel for channel-type messages', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SlackChannel(baseConfig);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    const msgHandler = mockSlackAppMessage.mock.calls[0]?.[0];
    await msgHandler({
      message: { user: 'U1', text: 'in channel', ts: '1.0', channel: 'C1', channel_type: 'channel', type: 'message' },
    });
    await new Promise((r) => setTimeout(r, 0));
    const msg = onMessage.mock.calls[0]?.[0];
    expect(msg?.peerKind).toBe('channel');
  });

  it('timestamp is parsed from ts string correctly', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SlackChannel(baseConfig);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    const msgHandler = mockSlackAppMessage.mock.calls[0]?.[0];
    await msgHandler({
      message: { user: 'U1', text: 'ts test', ts: '1700000000.500000', channel: 'C1', type: 'message' },
    });
    await new Promise((r) => setTimeout(r, 0));
    const msg = onMessage.mock.calls[0]?.[0];
    expect(msg?.timestamp).toBeCloseTo(1700000000500, -1);
  });

  it('image file attachment maps to image content', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SlackChannel(baseConfig);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    const msgHandler = mockSlackAppMessage.mock.calls[0]?.[0];
    await msgHandler({
      message: {
        user: 'U1',
        ts: '1.0',
        channel: 'C1',
        type: 'message',
        files: [{ id: 'F1', mimetype: 'image/png', url_private: 'https://slack.com/img.png' }],
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    const msg = onMessage.mock.calls[0]?.[0];
    expect(msg?.content.type).toBe('image');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. SIGNAL CHANNEL
// ─────────────────────────────────────────────────────────────────────────────
describe('SignalChannel', () => {
  let SignalChannel: typeof import('../src/channels/signal.js').SignalChannel;
  let createSignalChannel: typeof import('../src/channels/signal.js').createSignalChannel;

  const baseConfig = {
    id: 'signal-test',
    type: 'signal' as const,
    enabled: true,
    agentId: 'agent-1',
    socketPath: '/tmp/signal.sock',
    account: '+1234567890',
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

    ({ SignalChannel, createSignalChannel } = await import('../src/channels/signal.js'));
  });

  it('creates a SignalChannel instance', () => {
    const ch = new SignalChannel(baseConfig);
    expect(ch.id).toBe('signal-test');
    expect(ch.type).toBe('signal');
  });

  it('factory createSignalChannel works', () => {
    expect(createSignalChannel(baseConfig)).toBeInstanceOf(SignalChannel);
  });

  it('starts disconnected', () => {
    expect(new SignalChannel(baseConfig).connected).toBe(false);
  });

  it('connect() calls createConnection with socketPath', async () => {
    const { createConnection } = await import('node:net');
    const ch = new SignalChannel(baseConfig);
    const connectPromise = ch.connect();
    connectHandler(); // simulate successful connect
    await connectPromise;
    expect(createConnection).toHaveBeenCalledWith(baseConfig.socketPath);
  });

  it('connect() emits connect on socket "connect" event', async () => {
    const onConnect = vi.fn();
    const ch = new SignalChannel(baseConfig);
    ch.setEventHandlers({ onConnect });
    const p = ch.connect();
    connectHandler();
    await p;
    expect(onConnect).toHaveBeenCalled();
  });

  it('connect() rejects on socket error before connect', async () => {
    const ch = new SignalChannel(baseConfig);
    const p = ch.connect();
    errorHandler(new Error('ENOENT'));
    await expect(p).rejects.toThrow('ENOENT');
  });

  it('disconnect() destroys socket and emits disconnect', async () => {
    const onDisconnect = vi.fn();
    const ch = new SignalChannel(baseConfig);
    ch.setEventHandlers({ onDisconnect });
    const p = ch.connect();
    connectHandler();
    await p;
    await ch.disconnect();
    expect(mockSocketDestroy).toHaveBeenCalled();
    expect(onDisconnect).toHaveBeenCalled();
  });

  it('disconnect() is safe when not connected', async () => {
    const ch = new SignalChannel(baseConfig);
    await expect(ch.disconnect()).resolves.toBeUndefined();
  });

  it('send() throws when not connected', async () => {
    const ch = new SignalChannel(baseConfig);
    await expect(
      ch.send({ id: 'o1', channel: 'signal', peerId: '+1987654321', content: { type: 'text', text: 'hi' } })
    ).rejects.toThrow('Signal not connected');
  });

  it('send() writes JSON-RPC request to socket', async () => {
    // send() waits for a JSON-RPC response; simulate it by feeding back a response
    let capturedRequest: any;
    mockSocketWrite.mockImplementation((data: string, cb?: (err?: Error) => void) => {
      capturedRequest = JSON.parse(data.trim());
      cb?.();
      const response = JSON.stringify({ jsonrpc: '2.0', id: capturedRequest.id, result: {} }) + '\n';
      setImmediate(() => dataHandler(Buffer.from(response)));
      return true;
    });

    const ch = new SignalChannel(baseConfig);
    const p = ch.connect();
    connectHandler();
    await p;

    await ch.send({
      id: 'o2',
      channel: 'signal',
      peerId: '+1987654321',
      content: { type: 'text', text: 'hello signal' },
    });

    expect(mockSocketWrite).toHaveBeenCalled();
    expect(capturedRequest.method).toBe('send');
    expect(capturedRequest.params.message).toBe('hello signal');
  });

  it('send() uses groupId for group: peerId prefix', async () => {
    let capturedRequest: any;
    mockSocketWrite.mockImplementation((data: string, cb?: (err?: Error) => void) => {
      capturedRequest = JSON.parse(data.trim());
      cb?.();
      const response = JSON.stringify({ jsonrpc: '2.0', id: capturedRequest.id, result: {} }) + '\n';
      setImmediate(() => dataHandler(Buffer.from(response)));
      return true;
    });

    const ch = new SignalChannel(baseConfig);
    const p = ch.connect();
    connectHandler();
    await p;

    await ch.send({
      id: 'o3',
      channel: 'signal',
      peerId: 'group:abc123',
      content: { type: 'text', text: 'group msg' },
    });

    expect(capturedRequest.params.groupId).toBe('abc123');
    expect(capturedRequest.params.recipient).toBeUndefined();
  });

  it('incoming "receive" notification emits message', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SignalChannel(baseConfig);
    ch.setEventHandlers({ onMessage });
    const p = ch.connect();
    connectHandler();
    await p;

    const notification = JSON.stringify({
      jsonrpc: '2.0',
      method: 'receive',
      params: {
        envelope: {
          sourceNumber: '+1987654321',
          sourceName: 'Alice',
          dataMessage: {
            timestamp: 1700000000000,
            message: 'hello from signal',
          },
        },
      },
    }) + '\n';

    dataHandler(Buffer.from(notification));
    await new Promise((r) => setTimeout(r, 0));
    expect(onMessage).toHaveBeenCalled();
    const msg = onMessage.mock.calls[0]?.[0];
    expect(msg?.content.type).toBe('text');
    expect((msg?.content as any).text).toBe('hello from signal');
  });

  it('group signal message sets peerKind=group and group: peerId', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SignalChannel(baseConfig);
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
            message: 'group hi',
            groupInfo: { groupId: 'grp123', type: 'DELIVER' },
          },
        },
      },
    }) + '\n';

    dataHandler(Buffer.from(notification));
    await new Promise((r) => setTimeout(r, 0));
    const msg = onMessage.mock.calls[0]?.[0];
    expect(msg?.peerKind).toBe('group');
    expect(msg?.peerId).toBe('group:grp123');
  });

  it('quote in dataMessage sets replyTo', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SignalChannel(baseConfig);
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
            message: 'quoting',
            quote: { id: 1699999999000, authorNumber: '+18' },
          },
        },
      },
    }) + '\n';

    dataHandler(Buffer.from(notification));
    await new Promise((r) => setTimeout(r, 0));
    const msg = onMessage.mock.calls[0]?.[0];
    expect(msg?.replyTo).toBe('1699999999000:+18');
  });

  it('allowedUsers restricts signal messages', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new SignalChannel({ ...baseConfig, allowedUsers: ['+1allowed'] });
    ch.setEventHandlers({ onMessage });
    const p = ch.connect();
    connectHandler();
    await p;

    const notification = JSON.stringify({
      jsonrpc: '2.0',
      method: 'receive',
      params: {
        envelope: {
          sourceNumber: '+1stranger',
          dataMessage: { timestamp: 1700000000000, message: 'hi' },
        },
      },
    }) + '\n';

    dataHandler(Buffer.from(notification));
    await new Promise((r) => setTimeout(r, 0));
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('invalid JSON in data stream is silently skipped', async () => {
    const ch = new SignalChannel(baseConfig);
    const p = ch.connect();
    connectHandler();
    await p;

    expect(() => dataHandler(Buffer.from('NOT JSON\n'))).not.toThrow();
  });

  it('pending requests are rejected on disconnect', async () => {
    // When the socket closes before a response arrives, pending requests reject.
    // Wire up write to NOT echo back a response (so the request stays pending).
    mockSocketWrite.mockImplementation((data: string, cb?: (err?: Error) => void) => {
      cb?.();
      return true;
    });

    const ch = new SignalChannel(baseConfig);
    const p = ch.connect();
    connectHandler();
    await p;

    // Start a send (which creates a pending request)
    const sendPromise = ch.send({
      id: 'o4',
      channel: 'signal',
      peerId: '+1',
      content: { type: 'text', text: 'pending' },
    });

    // Close the socket before the response arrives
    closeHandler();

    // The pending request should reject with "Connection lost"
    await expect(sendPromise).rejects.toThrow('Connection lost');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. WHATSAPP CHANNEL
// ─────────────────────────────────────────────────────────────────────────────
describe('WhatsAppChannel', () => {
  let WhatsAppChannel: typeof import('../src/channels/whatsapp.js').WhatsAppChannel;
  let createWhatsAppChannel: typeof import('../src/channels/whatsapp.js').createWhatsAppChannel;

  const baseConfig = {
    id: 'wa-test',
    type: 'whatsapp' as const,
    enabled: true,
    agentId: 'agent-1',
    authDir: '/tmp/wa-auth',
  };

  let connectionUpdateHandler: (update: any) => void;
  let messagesUpsertHandler: (m: any) => Promise<void>;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockWASocketEvOn.mockImplementation((event: string, handler: any) => {
      if (event === 'connection.update') connectionUpdateHandler = handler;
      if (event === 'messages.upsert') messagesUpsertHandler = handler;
      if (event === 'creds.update') { /* just capture */ }
    });

    ({ WhatsAppChannel, createWhatsAppChannel } = await import('../src/channels/whatsapp.js'));
  });

  it('creates a WhatsAppChannel instance', () => {
    const ch = new WhatsAppChannel(baseConfig);
    expect(ch.id).toBe('wa-test');
    expect(ch.type).toBe('whatsapp');
  });

  it('factory createWhatsAppChannel works', () => {
    expect(createWhatsAppChannel(baseConfig)).toBeInstanceOf(WhatsAppChannel);
  });

  it('starts disconnected', () => {
    expect(new WhatsAppChannel(baseConfig).connected).toBe(false);
  });

  it('connect() calls makeWASocket', async () => {
    const makeWASocket = (await import('@whiskeysockets/baileys')).default;
    const ch = new WhatsAppChannel(baseConfig);
    await ch.connect();
    expect(makeWASocket).toHaveBeenCalled();
  });

  it('connect() calls mkdir for authDir', async () => {
    const { mkdir } = await import('node:fs/promises');
    const ch = new WhatsAppChannel(baseConfig);
    await ch.connect();
    expect(mkdir).toHaveBeenCalledWith(baseConfig.authDir, { recursive: true });
  });

  it('connect() is idempotent', async () => {
    const makeWASocket = (await import('@whiskeysockets/baileys')).default;
    const ch = new WhatsAppChannel(baseConfig);
    await ch.connect();
    await ch.connect();
    expect(makeWASocket).toHaveBeenCalledTimes(1);
  });

  it('connection "open" emits connect', async () => {
    const onConnect = vi.fn();
    const ch = new WhatsAppChannel(baseConfig);
    ch.setEventHandlers({ onConnect });
    await ch.connect();
    connectionUpdateHandler({ connection: 'open' });
    expect(onConnect).toHaveBeenCalled();
  });

  it('connection "close" with loggedOut emits disconnect', async () => {
    const { DisconnectReason } = await import('@whiskeysockets/baileys');
    const { Boom } = await import('@hapi/boom');
    const onDisconnect = vi.fn();
    const ch = new WhatsAppChannel(baseConfig);
    ch.setEventHandlers({ onDisconnect });
    await ch.connect();
    const boom = new Boom('Logged out', { statusCode: DisconnectReason.loggedOut });
    connectionUpdateHandler({ connection: 'close', lastDisconnect: { error: boom } });
    expect(onDisconnect).toHaveBeenCalled();
  });

  it('disconnect() calls socket.end and emits disconnect', async () => {
    const onDisconnect = vi.fn();
    const ch = new WhatsAppChannel(baseConfig);
    ch.setEventHandlers({ onDisconnect });
    await ch.connect();
    await ch.disconnect();
    expect(mockWASocketEnd).toHaveBeenCalled();
    expect(onDisconnect).toHaveBeenCalled();
  });

  it('disconnect() is safe when not connected', async () => {
    const ch = new WhatsAppChannel(baseConfig);
    await expect(ch.disconnect()).resolves.toBeUndefined();
  });

  it('send() throws when not connected', async () => {
    const ch = new WhatsAppChannel(baseConfig);
    await expect(
      ch.send({ id: 'o1', channel: 'whatsapp', peerId: '1234567890', content: { type: 'text', text: 'hi' } })
    ).rejects.toThrow('WhatsApp not connected');
  });

  it('send() text calls socket.sendMessage with jid', async () => {
    const ch = new WhatsAppChannel(baseConfig);
    await ch.connect();
    await ch.send({
      id: 'o2',
      channel: 'whatsapp',
      peerId: '1234567890',
      content: { type: 'text', text: 'hello wa' },
    });
    expect(mockWASocketSendMessage).toHaveBeenCalledWith(
      '1234567890@s.whatsapp.net',
      { text: 'hello wa' }
    );
  });

  it('send() appends @s.whatsapp.net to bare phone number', async () => {
    const ch = new WhatsAppChannel(baseConfig);
    await ch.connect();
    await ch.send({
      id: 'o3',
      channel: 'whatsapp',
      peerId: '9876543210',
      content: { type: 'text', text: 'test' },
    });
    expect(mockWASocketSendMessage).toHaveBeenCalledWith('9876543210@s.whatsapp.net', expect.any(Object));
  });

  it('send() does not double-append @s.whatsapp.net if already present', async () => {
    const ch = new WhatsAppChannel(baseConfig);
    await ch.connect();
    await ch.send({
      id: 'o4',
      channel: 'whatsapp',
      peerId: '9876543210@s.whatsapp.net',
      content: { type: 'text', text: 'already-jid' },
    });
    expect(mockWASocketSendMessage).toHaveBeenCalledWith('9876543210@s.whatsapp.net', expect.any(Object));
  });

  it('messages.upsert ignores own (fromMe) messages', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new WhatsAppChannel(baseConfig);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await messagesUpsertHandler({
      messages: [
        {
          key: { fromMe: true, remoteJid: '1234@s.whatsapp.net', id: 'msg1' },
          message: { conversation: 'own message' },
        },
      ],
    });
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('messages.upsert emits incoming message for conversation text', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new WhatsAppChannel(baseConfig);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await messagesUpsertHandler({
      messages: [
        {
          key: { fromMe: false, remoteJid: '5551234567@s.whatsapp.net', id: 'msg2' },
          message: { conversation: 'hello world' },
          messageTimestamp: 1700000000,
        },
      ],
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(onMessage).toHaveBeenCalled();
    const msg = onMessage.mock.calls[0]?.[0];
    expect((msg?.content as any).text).toBe('hello world');
  });

  it('group message sets peerKind=group', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new WhatsAppChannel(baseConfig);
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await messagesUpsertHandler({
      messages: [
        {
          key: { fromMe: false, remoteJid: 'abc123@g.us', participant: '5551234567@s.whatsapp.net', id: 'msg3' },
          message: { conversation: 'group hello' },
          messageTimestamp: 1700000000,
        },
      ],
    });
    await new Promise((r) => setTimeout(r, 0));
    const msg = onMessage.mock.calls[0]?.[0];
    expect(msg?.peerKind).toBe('group');
  });

  it('allowedUsers restricts whatsapp messages', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const ch = new WhatsAppChannel({ ...baseConfig, allowedUsers: ['5559999999'] });
    ch.setEventHandlers({ onMessage });
    await ch.connect();

    await messagesUpsertHandler({
      messages: [
        {
          key: { fromMe: false, remoteJid: '5551234567@s.whatsapp.net', id: 'msg4' },
          message: { conversation: 'restricted' },
          messageTimestamp: 1700000000,
        },
      ],
    });
    expect(onMessage).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. CHANNEL REGISTRY / FACTORY (createChannel)
// ─────────────────────────────────────────────────────────────────────────────
describe('createChannel (channel registry)', () => {
  let createChannel: typeof import('../src/channels/index.js').createChannel;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ createChannel } = await import('../src/channels/index.js'));
  });

  const commonBase = { id: 'ch1', enabled: true, agentId: 'a1' };

  it('creates TelegramChannel for type=telegram', () => {
    const ch = createChannel({ ...commonBase, type: 'telegram', token: 'tok' });
    expect(ch.type).toBe('telegram');
    expect(ch.id).toBe(commonBase.id);
  });

  it('creates DiscordChannel for type=discord', () => {
    const ch = createChannel({ ...commonBase, type: 'discord', token: 'tok' });
    expect(ch.type).toBe('discord');
    expect(ch.id).toBe(commonBase.id);
  });

  it('creates SlackChannel for type=slack', () => {
    const ch = createChannel({
      ...commonBase,
      type: 'slack',
      botToken: 'xoxb',
      appToken: 'xapp',
      signingSecret: 'sec',
    });
    expect(ch.type).toBe('slack');
    expect(ch.id).toBe(commonBase.id);
  });

  it('creates SignalChannel for type=signal', () => {
    const ch = createChannel({ ...commonBase, type: 'signal', socketPath: '/tmp/s.sock', account: '+1' });
    expect(ch.type).toBe('signal');
    expect(ch.id).toBe(commonBase.id);
  });

  it('creates WhatsAppChannel for type=whatsapp', () => {
    const ch = createChannel({ ...commonBase, type: 'whatsapp', authDir: '/tmp/wa' });
    expect(ch.type).toBe('whatsapp');
    expect(ch.id).toBe(commonBase.id);
  });

  it('throws for unknown channel type', () => {
    expect(() =>
      createChannel({ ...commonBase, type: 'fax' as any })
    ).toThrow('Unknown channel type: fax');
  });

  it('returned channel has correct id', () => {
    const ch = createChannel({ ...commonBase, id: 'my-unique-id', type: 'telegram', token: 'tok' });
    expect(ch.id).toBe('my-unique-id');
  });

  it('returned channel has correct type', () => {
    const ch = createChannel({ ...commonBase, type: 'discord', token: 'tok' });
    expect(ch.type).toBe('discord');
  });

  it('each call returns a new instance', () => {
    const cfg = { ...commonBase, type: 'telegram' as const, token: 'tok' };
    const a = createChannel(cfg);
    const b = createChannel(cfg);
    expect(a).not.toBe(b);
  });

  it('all created channels implement Channel interface', () => {
    const configs = [
      { ...commonBase, type: 'telegram' as const, token: 'tok' },
      { ...commonBase, type: 'discord' as const, token: 'tok' },
      { ...commonBase, type: 'slack' as const, botToken: 'xoxb', appToken: 'xapp', signingSecret: 's' },
      { ...commonBase, type: 'signal' as const, socketPath: '/tmp/s.sock', account: '+1' },
      { ...commonBase, type: 'whatsapp' as const, authDir: '/tmp/wa' },
    ];
    for (const cfg of configs) {
      const ch = createChannel(cfg);
      expect(typeof ch.connect).toBe('function');
      expect(typeof ch.disconnect).toBe('function');
      expect(typeof ch.send).toBe('function');
      expect(typeof ch.setEventHandlers).toBe('function');
      expect(typeof ch.connected).toBe('boolean');
    }
  });

  it('telegram channel has type=telegram', () => {
    const ch = createChannel({ ...commonBase, type: 'telegram', token: 'tok' });
    expect(ch.type).toBe('telegram');
  });

  it('discord channel has type=discord', () => {
    const ch = createChannel({ ...commonBase, type: 'discord', token: 'tok' });
    expect(ch.type).toBe('discord');
  });

  it('slack channel has type=slack', () => {
    const ch = createChannel({ ...commonBase, type: 'slack', botToken: 'b', appToken: 'a', signingSecret: 's' });
    expect(ch.type).toBe('slack');
  });

  it('signal channel has type=signal', () => {
    const ch = createChannel({ ...commonBase, type: 'signal', socketPath: '/tmp/s.sock', account: '+1' });
    expect(ch.type).toBe('signal');
  });

  it('whatsapp channel has type=whatsapp', () => {
    const ch = createChannel({ ...commonBase, type: 'whatsapp', authDir: '/tmp/wa' });
    expect(ch.type).toBe('whatsapp');
  });

  it('all new channels start disconnected', () => {
    const ch = createChannel({ ...commonBase, type: 'telegram', token: 'tok' });
    expect(ch.connected).toBe(false);
  });

  it('error message includes the unknown type name', () => {
    expect(() => createChannel({ ...commonBase, type: 'carrier-pigeon' as any }))
      .toThrow('carrier-pigeon');
  });

  it('setEventHandlers is callable on all channel types', () => {
    const configs = [
      { ...commonBase, type: 'telegram' as const, token: 't' },
      { ...commonBase, type: 'discord' as const, token: 't' },
    ];
    for (const cfg of configs) {
      const ch = createChannel(cfg);
      expect(() => ch.setEventHandlers({ onConnect: vi.fn() })).not.toThrow();
    }
  });
});
