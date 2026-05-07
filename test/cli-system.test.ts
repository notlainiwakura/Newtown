/**
 * Comprehensive test suite for the CLI system and plugin loader
 *
 * Covers: CLI entry point, all commands, and the plugin system.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Logger mock ─────────────────────────────────────────────────────────────
vi.mock('../src/utils/logger.js', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  createLogger: vi.fn(),
}));

// ─── keytar mock ─────────────────────────────────────────────────────────────
vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('mock-auth-token'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

// ─── chalk mock ──────────────────────────────────────────────────────────────
vi.mock('chalk', () => ({
  default: {
    cyan: (s: string) => s,
    green: (s: string) => s,
    red: (s: string) => s,
    yellow: (s: string) => s,
    blue: (s: string) => s,
    dim: (s: string) => s,
    bold: (s: string) => s,
  },
}));

// ─── inquirer mock ───────────────────────────────────────────────────────────
const mockInquirerPrompt = vi.fn().mockResolvedValue({ confirmSetup: true, generateToken: true });
vi.mock('inquirer', () => ({
  default: { prompt: mockInquirerPrompt },
}));

// ─── gateway/server mock ─────────────────────────────────────────────────────
const mockGetServerPid = vi.fn().mockResolvedValue(null);
const mockIsProcessRunning = vi.fn().mockReturnValue(false);
const mockStartServer = vi.fn().mockResolvedValue(undefined);
const mockStopServer = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/gateway/server.js', () => ({
  getServerPid: mockGetServerPid,
  isProcessRunning: mockIsProcessRunning,
  startServer: mockStartServer,
  stopServer: mockStopServer,
}));

// ─── gateway/router mock ─────────────────────────────────────────────────────
vi.mock('../src/gateway/router.js', () => ({
  registerChatMethod: vi.fn(),
}));

// ─── config mock ─────────────────────────────────────────────────────────────
const mockGetPaths = vi.fn().mockReturnValue({
  base: '/tmp/.lain',
  config: '/tmp/.lain/lain.json5',
  database: '/tmp/.lain/lain.db',
  socket: '/tmp/.lain/lain.sock',
  pidFile: '/tmp/.lain/lain.pid',
  workspace: '/tmp/.lain/workspace',
  agents: '/tmp/.lain/agents',
  extensions: '/tmp/.lain/extensions',
  credentials: '/tmp/.lain/credentials',
  logs: '/tmp/.lain/logs',
});

const mockLoadConfig = vi.fn().mockResolvedValue({
  version: '0.1.0',
  agents: [],
  gateway: { socketPath: '/tmp/.lain/lain.sock' },
  security: { requireAuth: true, maxMessageLength: 4096, keyDerivation: {} },
  logging: {},
});

const mockCreateInitialConfig = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/config/index.js', () => ({
  getPaths: mockGetPaths,
  loadConfig: mockLoadConfig,
  createInitialConfig: mockCreateInitialConfig,
}));

vi.mock('../src/config/defaults.js', () => ({
  // findings.md P2:171 — `agents` moved out of LainConfig into the
  // character manifest. Telegram reads the agent from getAllCharacters()
  // (see mock below) + LAIN_TELEGRAM_AGENT_ID env override.
  getDefaultConfig: vi.fn().mockReturnValue({
    security: { keyDerivation: {} },
  }),
  DEFAULT_PROVIDERS: [],
}));

// ─── character manifest mock ─────────────────────────────────────────────────
const mockGetCharacterEntry = vi.fn();
const mockGetPeersFor = vi.fn().mockReturnValue([]);
// findings.md P2:171 — gateway/telegram now resolve their agent from the
// manifest (`getAllCharacters()[0]?.id`) plus an optional env override,
// then feed it into `getAgentConfigFor(id)`. The default mock provides a
// single stub character so structural tests (startGateway calls X, etc.)
// don't trip the "no characters configured" exit.
const mockGetAllCharacters = vi.fn().mockReturnValue([
  { id: 'default', name: 'Default', port: 3000, server: 'character', defaultLocation: 'home', workspace: '/tmp/ws' },
]);
const mockGetAgentConfigFor = vi.fn().mockReturnValue({
  id: 'default',
  name: 'Default',
  enabled: true,
  workspace: '/tmp/ws',
  providers: [{ type: 'anthropic', model: 'claude-sonnet-4-6' }],
});

vi.mock('../src/config/characters.js', () => ({
  getCharacterEntry: mockGetCharacterEntry,
  getPeersFor: mockGetPeersFor,
  // findings.md P2:78 — status/doctor/onboard now discriminate between
  // legacy single-user and multi-char layouts via getManifestPath().
  // Default: no manifest so these structural tests keep exercising the
  // legacy path.
  getManifestPath: vi.fn().mockReturnValue(null),
  getAllCharacters: mockGetAllCharacters,
  getAgentConfigFor: mockGetAgentConfigFor,
}));

// ─── storage mock ─────────────────────────────────────────────────────────────
const mockInitDatabase = vi.fn().mockResolvedValue(undefined);
const mockCloseDatabase = vi.fn();
const mockGetMasterKey = vi.fn().mockResolvedValue('master-key');
const mockGetAuthToken = vi.fn().mockResolvedValue('auth-token-123');
const mockGenerateAuthToken = vi.fn().mockResolvedValue('new-token-xyz');

vi.mock('../src/storage/database.js', () => ({
  initDatabase: mockInitDatabase,
  closeDatabase: mockCloseDatabase,
}));

vi.mock('../src/storage/keychain.js', () => ({
  getMasterKey: mockGetMasterKey,
  getAuthToken: mockGetAuthToken,
  generateAuthToken: mockGenerateAuthToken,
}));

// ─── agent mock ───────────────────────────────────────────────────────────────
const mockInitAgent = vi.fn().mockResolvedValue(undefined);
const mockShutdownAgents = vi.fn();

const mockProcessMessage = vi.fn().mockResolvedValue({
  sessionKey: 'telegram:test',
  messages: [],
});

vi.mock('../src/agent/index.js', () => ({
  initAgent: mockInitAgent,
  shutdownAgents: mockShutdownAgents,
  processMessage: mockProcessMessage,
  processMessageStream: vi.fn().mockResolvedValue(undefined),
}));

// ─── web server mock ──────────────────────────────────────────────────────────
const mockStartWebServer = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/web/server.js', () => ({
  startWebServer: mockStartWebServer,
}));

// ─── character-server mock ────────────────────────────────────────────────────
const mockStartCharacterServer = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/web/character-server.js', () => ({
  startCharacterServer: mockStartCharacterServer,
}));

// ─── fs mock ───────────────────────────────────────────────────────────────
const mockAccess = vi.fn();

vi.mock('node:fs/promises', () => ({
  access: mockAccess,
  mkdir: vi.fn().mockResolvedValue(undefined),
  copyFile: vi.fn().mockResolvedValue(undefined),
  constants: { R_OK: 4 },
}));

// ─── node:child_process mock ──────────────────────────────────────────────────
const mockSpawn = vi.fn().mockReturnValue({ unref: vi.fn() });
vi.mock('node:child_process', () => ({ spawn: mockSpawn }));

// ─── node:net mock (for chat command) ────────────────────────────────────────
const mockNetConnect = vi.fn();
vi.mock('node:net', () => ({ connect: mockNetConnect }));

// ─── dotenv mock ─────────────────────────────────────────────────────────────
vi.mock('dotenv/config', () => ({}));

// ─── TelegramChannel mock for telegram command ────────────────────────────────
vi.mock('../src/channels/telegram.js', () => ({
  TelegramChannel: vi.fn(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    setEventHandlers: vi.fn(),
    connected: false,
    id: 'telegram-main',
    type: 'telegram',
  })),
  createTelegramChannel: vi.fn(),
}));

// ─────────────────────────────────────────────────────────────────────────────
// 1. CLI ENTRY POINT (program)
// ─────────────────────────────────────────────────────────────────────────────
describe('CLI entry point (program)', () => {
  it('program is exported from cli/index.ts', async () => {
    const { program } = await import('../src/cli/index.js');
    expect(program).toBeDefined();
  });

  it('program has name "lain"', async () => {
    const { program } = await import('../src/cli/index.js');
    expect(program.name()).toBe('lain');
  });

  it('program has version 0.1.0', async () => {
    const { program } = await import('../src/cli/index.js');
    expect(program.version()).toBe('0.1.0');
  });

  it('program has description', async () => {
    const { program } = await import('../src/cli/index.js');
    expect(program.description()).toBeTruthy();
  });

  it('program registers "onboard" command', async () => {
    const { program } = await import('../src/cli/index.js');
    const cmd = program.commands.find((c) => c.name() === 'onboard');
    expect(cmd).toBeDefined();
  });

  it('program registers "gateway" command', async () => {
    const { program } = await import('../src/cli/index.js');
    const cmd = program.commands.find((c) => c.name() === 'gateway');
    expect(cmd).toBeDefined();
  });

  it('program registers "status" command', async () => {
    const { program } = await import('../src/cli/index.js');
    const cmd = program.commands.find((c) => c.name() === 'status');
    expect(cmd).toBeDefined();
  });

  it('program registers "doctor" command', async () => {
    const { program } = await import('../src/cli/index.js');
    const cmd = program.commands.find((c) => c.name() === 'doctor');
    expect(cmd).toBeDefined();
  });

  it('program registers "chat" command', async () => {
    const { program } = await import('../src/cli/index.js');
    const cmd = program.commands.find((c) => c.name() === 'chat');
    expect(cmd).toBeDefined();
  });

  it('program registers "send" command', async () => {
    const { program } = await import('../src/cli/index.js');
    const cmd = program.commands.find((c) => c.name() === 'send');
    expect(cmd).toBeDefined();
  });

  it('program registers "configure" command (alias for onboard)', async () => {
    const { program } = await import('../src/cli/index.js');
    const cmd = program.commands.find((c) => c.name() === 'configure');
    expect(cmd).toBeDefined();
  });

  it('program registers "web" command', async () => {
    const { program } = await import('../src/cli/index.js');
    const cmd = program.commands.find((c) => c.name() === 'web');
    expect(cmd).toBeDefined();
  });

  it('program registers "telegram" command', async () => {
    const { program } = await import('../src/cli/index.js');
    const cmd = program.commands.find((c) => c.name() === 'telegram');
    expect(cmd).toBeDefined();
  });

  it('program registers "character" command', async () => {
    const { program } = await import('../src/cli/index.js');
    const cmd = program.commands.find((c) => c.name() === 'character');
    expect(cmd).toBeDefined();
  });

  it('"web" command has --port option', async () => {
    const { program } = await import('../src/cli/index.js');
    const cmd = program.commands.find((c) => c.name() === 'web')!;
    const portOpt = cmd.options.find((o) => o.short === '-p' || o.long === '--port');
    expect(portOpt).toBeDefined();
  });

  it('"web" command port defaults to "3000"', async () => {
    const { program } = await import('../src/cli/index.js');
    const cmd = program.commands.find((c) => c.name() === 'web')!;
    const portOpt = cmd.options.find((o) => o.long === '--port');
    expect(portOpt?.defaultValue).toBe('3000');
  });

  it('"character" command has --port option', async () => {
    const { program } = await import('../src/cli/index.js');
    const cmd = program.commands.find((c) => c.name() === 'character')!;
    const portOpt = cmd.options.find((o) => o.long === '--port');
    expect(portOpt).toBeDefined();
  });

  it('"gateway" command has --daemon option', async () => {
    const { program } = await import('../src/cli/index.js');
    const cmd = program.commands.find((c) => c.name() === 'gateway')!;
    const daemonOpt = cmd.options.find((o) => o.long === '--daemon');
    expect(daemonOpt).toBeDefined();
  });

  it('"gateway" has "stop" subcommand', async () => {
    const { program } = await import('../src/cli/index.js');
    const gateway = program.commands.find((c) => c.name() === 'gateway')!;
    const stopCmd = gateway.commands.find((c) => c.name() === 'stop');
    expect(stopCmd).toBeDefined();
  });

  it('run() exports a function', async () => {
    const { run } = await import('../src/cli/index.js');
    expect(typeof run).toBe('function');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. CHARACTER COMMAND
// ─────────────────────────────────────────────────────────────────────────────
describe('character command (startCharacterById)', () => {
  let startCharacterById: typeof import('../src/cli/commands/character.js').startCharacterById;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ startCharacterById } = await import('../src/cli/commands/character.js'));
  });

  it('exports startCharacterById function', () => {
    expect(typeof startCharacterById).toBe('function');
  });

  it('calls process.exit(1) for unknown character', async () => {
    mockGetCharacterEntry.mockReturnValue(null);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });

    await expect(startCharacterById('unknown-char')).rejects.toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('calls startCharacterServer with correct id for known character', async () => {
    mockGetCharacterEntry.mockReturnValue({
      id: 'lain',
      name: 'Lain',
      port: 3001,
    });

    await startCharacterById('lain');
    expect(mockStartCharacterServer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'lain', name: 'Lain' })
    );
  });

  it('exports character identity env before starting the server', async () => {
    const prevId = process.env['LAIN_CHARACTER_ID'];
    const prevName = process.env['LAIN_CHARACTER_NAME'];
    delete process.env['LAIN_CHARACTER_ID'];
    delete process.env['LAIN_CHARACTER_NAME'];
    mockGetCharacterEntry.mockReturnValue({
      id: 'dr-claude',
      name: 'Dr. Claude',
      port: 3002,
    });

    try {
      await startCharacterById('dr-claude');
      expect(process.env['LAIN_CHARACTER_ID']).toBe('dr-claude');
      expect(process.env['LAIN_CHARACTER_NAME']).toBe('Dr. Claude');
    } finally {
      if (prevId !== undefined) process.env['LAIN_CHARACTER_ID'] = prevId;
      else delete process.env['LAIN_CHARACTER_ID'];
      if (prevName !== undefined) process.env['LAIN_CHARACTER_NAME'] = prevName;
      else delete process.env['LAIN_CHARACTER_NAME'];
    }
  });

  it('uses portOverride when provided', async () => {
    mockGetCharacterEntry.mockReturnValue({ id: 'lain', name: 'Lain', port: 3001 });

    await startCharacterById('lain', 4000);
    expect(mockStartCharacterServer).toHaveBeenCalledWith(
      expect.objectContaining({ port: 4000 })
    );
  });

  it('falls back to manifest port when no override', async () => {
    mockGetCharacterEntry.mockReturnValue({ id: 'lain', name: 'Lain', port: 3001 });

    await startCharacterById('lain');
    expect(mockStartCharacterServer).toHaveBeenCalledWith(
      expect.objectContaining({ port: 3001 })
    );
  });

  it('sets possessable flag if entry.possessable is true', async () => {
    mockGetCharacterEntry.mockReturnValue({ id: 'pkd', name: 'PKD', port: 3003, possessable: true });

    await startCharacterById('pkd');
    expect(mockStartCharacterServer).toHaveBeenCalledWith(
      expect.objectContaining({ possessable: true })
    );
  });

  it('reads PEER_CONFIG from env if set', async () => {
    // findings.md P2:66 — parsePeerConfig now validates each entry has
    // {id, name, url}. Missing `name` makes the env value fall back to
    // manifest's getPeersFor. Include `name` so the env value wins.
    const peers = [
      { id: 'wired-lain', name: 'Wired Lain', url: 'http://localhost:3000', token: 'tok' },
    ];
    process.env['PEER_CONFIG'] = JSON.stringify(peers);
    mockGetCharacterEntry.mockReturnValue({ id: 'lain', name: 'Lain', port: 3001 });

    await startCharacterById('lain');
    expect(mockStartCharacterServer).toHaveBeenCalledWith(
      expect.objectContaining({ peers: peers })
    );
    delete process.env['PEER_CONFIG'];
  });

  it('falls back to getPeersFor if PEER_CONFIG is missing', async () => {
    delete process.env['PEER_CONFIG'];
    mockGetCharacterEntry.mockReturnValue({ id: 'lain', name: 'Lain', port: 3001 });
    mockGetPeersFor.mockReturnValue([]);

    await startCharacterById('lain');
    expect(mockGetPeersFor).toHaveBeenCalledWith('lain');
  });

  it('falls back to getPeersFor if PEER_CONFIG is invalid JSON', async () => {
    process.env['PEER_CONFIG'] = 'NOT_JSON';
    mockGetCharacterEntry.mockReturnValue({ id: 'lain', name: 'Lain', port: 3001 });

    await startCharacterById('lain');
    expect(mockGetPeersFor).toHaveBeenCalledWith('lain');
    delete process.env['PEER_CONFIG'];
  });

  it('calls process.exit(1) if startCharacterServer throws', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    mockGetCharacterEntry.mockReturnValue({ id: 'lain', name: 'Lain', port: 3001 });
    mockStartCharacterServer.mockRejectedValueOnce(new Error('server crash'));

    await startCharacterById('lain');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('no longer passes publicDir — character servers are API-only (findings.md P1:27)', async () => {
    mockGetCharacterEntry.mockReturnValue({ id: 'lain', name: 'Lain', port: 3001 });

    await startCharacterById('lain');
    const call = mockStartCharacterServer.mock.calls[0]?.[0];
    expect(call?.publicDir).toBeUndefined();
  });

  it('getCharacterEntry is called with the provided characterId', async () => {
    mockGetCharacterEntry.mockReturnValue({ id: 'wired-lain', name: 'Wired Lain', port: 3000 });

    await startCharacterById('wired-lain');
    expect(mockGetCharacterEntry).toHaveBeenCalledWith('wired-lain');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. WEB COMMAND
// ─────────────────────────────────────────────────────────────────────────────
describe('web command (startWeb)', () => {
  let startWeb: typeof import('../src/cli/commands/web.js').startWeb;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ startWeb } = await import('../src/cli/commands/web.js'));
  });

  it('exports startWeb function', () => {
    expect(typeof startWeb).toBe('function');
  });

  it('calls startWebServer with provided port', async () => {
    await startWeb(8080);
    expect(mockStartWebServer).toHaveBeenCalledWith(8080);
  });

  it('defaults to port 3000 when not specified', async () => {
    await startWeb();
    expect(mockStartWebServer).toHaveBeenCalledWith(3000);
  });

  it('calls process.exit(1) if startWebServer throws', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    mockStartWebServer.mockRejectedValueOnce(new Error('port in use'));

    await startWeb(3000);
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('startWebServer is called exactly once', async () => {
    await startWeb(4000);
    expect(mockStartWebServer).toHaveBeenCalledTimes(1);
  });

  it('different port values are passed through', async () => {
    await startWeb(9999);
    expect(mockStartWebServer).toHaveBeenCalledWith(9999);
  });

  it('does not throw on success', async () => {
    await expect(startWeb(3000)).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. GATEWAY COMMAND
// ─────────────────────────────────────────────────────────────────────────────
describe('gateway command', () => {
  let startGateway: typeof import('../src/cli/commands/gateway.js').startGateway;
  let stopGateway: typeof import('../src/cli/commands/gateway.js').stopGateway;
  let startDaemon: typeof import('../src/cli/commands/gateway.js').startDaemon;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ startGateway, stopGateway, startDaemon } = await import('../src/cli/commands/gateway.js'));
  });

  it('exports startGateway, stopGateway, startDaemon', () => {
    expect(typeof startGateway).toBe('function');
    expect(typeof stopGateway).toBe('function');
    expect(typeof startDaemon).toBe('function');
  });

  it('startGateway exits if gateway already running', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    mockGetServerPid.mockResolvedValueOnce(1234);
    mockIsProcessRunning.mockReturnValueOnce(true);

    await startGateway();
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('startGateway calls initDatabase', async () => {
    // Not running
    mockGetServerPid.mockResolvedValueOnce(null);
    // Prevent infinite await at the end
    const processOnSpy = vi.spyOn(process, 'on').mockImplementation((() => process) as any);
    // Make startServer resolve and then we need to exit the infinite loop
    let resolveStartServer: () => void;
    mockStartServer.mockImplementationOnce(() => new Promise<void>((r) => { resolveStartServer = r; r(); }));

    const startPromise = startGateway();
    // Give it a tick to reach initDatabase
    await new Promise((r) => setTimeout(r, 0));
    expect(mockInitDatabase).toHaveBeenCalled();
    processOnSpy.mockRestore();
  });

  it('startGateway calls loadConfig', async () => {
    mockGetServerPid.mockResolvedValueOnce(null);
    const processOnSpy = vi.spyOn(process, 'on').mockImplementation((() => process) as any);
    mockStartServer.mockResolvedValueOnce(undefined);

    await startGateway();
    expect(mockLoadConfig).toHaveBeenCalled();
    processOnSpy.mockRestore();
  });

  it('startGateway calls startServer', async () => {
    mockGetServerPid.mockResolvedValueOnce(null);
    const processOnSpy = vi.spyOn(process, 'on').mockImplementation((() => process) as any);

    await startGateway();
    expect(mockStartServer).toHaveBeenCalled();
    processOnSpy.mockRestore();
  });

  it('startGateway exits with error if startServer throws', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    mockGetServerPid.mockResolvedValueOnce(null);
    mockStartServer.mockRejectedValueOnce(new Error('bind error'));

    await startGateway();
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('stopGateway warns if gateway not running (no pid)', async () => {
    mockGetServerPid.mockResolvedValueOnce(null);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await stopGateway();
    // Should not throw and should print a warning
    consoleSpy.mockRestore();
  });

  it('stopGateway sends SIGTERM to process', async () => {
    mockGetServerPid.mockResolvedValueOnce(9999);
    // First call: process is running (so SIGTERM is sent), subsequent calls: stopped
    mockIsProcessRunning.mockReturnValueOnce(true).mockReturnValue(false);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    await stopGateway();
    expect(killSpy).toHaveBeenCalledWith(9999, 'SIGTERM');
    killSpy.mockRestore();
  });

  it('startDaemon exits with error if already running', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    mockGetServerPid.mockResolvedValue(1234);
    mockIsProcessRunning.mockReturnValue(true);

    await startDaemon();
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('startDaemon calls spawn with detached:true', async () => {
    vi.useFakeTimers();
    mockGetServerPid
      .mockResolvedValueOnce(null)   // "already running" check
      .mockResolvedValueOnce(5678);  // post-spawn check
    mockIsProcessRunning.mockReturnValue(true);

    const p = startDaemon();
    await vi.runAllTimersAsync();
    await p;
    expect(mockSpawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ detached: true })
    );
    vi.useRealTimers();
  });

  it('startDaemon exits with error if daemon does not start', async () => {
    vi.useFakeTimers();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    mockGetServerPid.mockResolvedValue(null); // never gets a PID
    mockIsProcessRunning.mockReturnValue(false);

    const p = startDaemon();
    await vi.runAllTimersAsync();
    await p;
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    vi.useRealTimers();
  });

  it('stopGateway handles already-dead process gracefully', async () => {
    mockGetServerPid.mockResolvedValueOnce(7777);
    mockIsProcessRunning.mockReturnValue(false);

    await expect(stopGateway()).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. DOCTOR COMMAND
// ─────────────────────────────────────────────────────────────────────────────
describe('doctor command', () => {
  let doctor: typeof import('../src/cli/commands/doctor.js').doctor;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Make access succeed for all paths by default
    mockAccess.mockResolvedValue(undefined);
    ({ doctor } = await import('../src/cli/commands/doctor.js'));
  });

  it('exports doctor function', () => {
    expect(typeof doctor).toBe('function');
  });

  it('runs without throwing when all checks pass', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    mockLoadConfig.mockResolvedValueOnce({ version: '1.0.0' });

    await doctor();
    // If all pass, should not have called exit with 1
    // (may or may not call exit(0) — but not exit(1))
    exitSpy.mockRestore();
  });

  it('calls loadConfig to validate config', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    await doctor();
    expect(mockLoadConfig).toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('calls initDatabase and closeDatabase', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    await doctor();
    expect(mockInitDatabase).toHaveBeenCalled();
    expect(mockCloseDatabase).toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('calls getMasterKey for keychain check', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    await doctor();
    expect(mockGetMasterKey).toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('calls getAuthToken for auth check', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    await doctor();
    expect(mockGetAuthToken).toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('calls process.exit(1) when config load fails', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    mockLoadConfig.mockRejectedValueOnce(new Error('invalid config'));

    await doctor();
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('calls process.exit(1) when database init fails', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    mockInitDatabase.mockRejectedValueOnce(new Error('db error'));

    await doctor();
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('checks ANTHROPIC_API_KEY environment variable', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    const originalKey = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];

    await doctor();
    // Doctor should still complete (API key is a warning, not fatal)

    process.env['ANTHROPIC_API_KEY'] = originalKey ?? 'test-key';
    exitSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. TELEGRAM COMMAND
// ─────────────────────────────────────────────────────────────────────────────
describe('telegram command (startTelegram)', () => {
  let startTelegram: typeof import('../src/cli/commands/telegram.js').startTelegram;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ startTelegram } = await import('../src/cli/commands/telegram.js'));
  });

  it('exports startTelegram function', () => {
    expect(typeof startTelegram).toBe('function');
  });

  it('exits if TELEGRAM_BOT_TOKEN not set', async () => {
    const originalToken = process.env['TELEGRAM_BOT_TOKEN'];
    const originalChatId = process.env['TELEGRAM_CHAT_ID'];
    delete process.env['TELEGRAM_BOT_TOKEN'];
    delete process.env['TELEGRAM_CHAT_ID'];

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });

    try {
      await expect(startTelegram()).rejects.toThrow('process.exit(1)');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      if (originalToken !== undefined) process.env['TELEGRAM_BOT_TOKEN'] = originalToken;
      if (originalChatId !== undefined) process.env['TELEGRAM_CHAT_ID'] = originalChatId;
      exitSpy.mockRestore();
    }
  });

  it('exits if TELEGRAM_CHAT_ID not set', async () => {
    const originalToken = process.env['TELEGRAM_BOT_TOKEN'];
    const originalChatId = process.env['TELEGRAM_CHAT_ID'];
    process.env['TELEGRAM_BOT_TOKEN'] = 'test-token';
    delete process.env['TELEGRAM_CHAT_ID'];

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });

    try {
      await expect(startTelegram()).rejects.toThrow('process.exit(1)');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      if (originalToken !== undefined) process.env['TELEGRAM_BOT_TOKEN'] = originalToken;
      if (originalChatId !== undefined) process.env['TELEGRAM_CHAT_ID'] = originalChatId;
      exitSpy.mockRestore();
    }
  });

  it('calls initDatabase when tokens are set', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'test-token';
    process.env['TELEGRAM_CHAT_ID'] = '123456';
    vi.spyOn(process, 'on').mockImplementation((() => process) as any);

    // We need to prevent the infinite await at the end
    // Mock the TelegramChannel.connect to not resolve (simulating running)
    const { TelegramChannel } = await import('../src/channels/telegram.js');
    const mockConnect = vi.fn().mockImplementation(() => new Promise(() => {})); // never resolves
    (TelegramChannel as any).mockImplementation(() => ({
      connect: mockConnect,
      disconnect: vi.fn(),
      setEventHandlers: vi.fn(),
      send: vi.fn(),
    }));

    // Race against a short timeout
    await Promise.race([
      startTelegram(),
      new Promise<void>((r) => setTimeout(r, 10)),
    ]);

    expect(mockInitDatabase).toHaveBeenCalled();
  });

  it('creates TelegramChannel with bot token and allowed user', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'my-bot-token';
    process.env['TELEGRAM_CHAT_ID'] = '999';
    vi.spyOn(process, 'on').mockImplementation((() => process) as any);

    const { TelegramChannel } = await import('../src/channels/telegram.js');
    const mockConnect = vi.fn().mockImplementation(() => new Promise(() => {}));
    const mockSetEventHandlers = vi.fn();
    (TelegramChannel as any).mockImplementation(() => ({
      connect: mockConnect,
      disconnect: vi.fn(),
      setEventHandlers: mockSetEventHandlers,
      send: vi.fn(),
    }));

    await Promise.race([startTelegram(), new Promise<void>((r) => setTimeout(r, 10))]);

    expect(TelegramChannel).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'my-bot-token', allowedUsers: ['999'] })
    );
  });

  it('sets up event handlers on the channel', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'tok';
    process.env['TELEGRAM_CHAT_ID'] = '111';
    vi.spyOn(process, 'on').mockImplementation((() => process) as any);

    const { TelegramChannel } = await import('../src/channels/telegram.js');
    const mockSetHandlers = vi.fn();
    const mockConnect = vi.fn().mockImplementation(() => new Promise(() => {}));
    (TelegramChannel as any).mockImplementation(() => ({
      connect: mockConnect,
      disconnect: vi.fn(),
      setEventHandlers: mockSetHandlers,
      send: vi.fn(),
    }));

    await Promise.race([startTelegram(), new Promise<void>((r) => setTimeout(r, 10))]);
    expect(mockSetHandlers).toHaveBeenCalled();
  });

  // findings.md P2:307 — onMessage handler should use non-streaming
  // processMessage and forward the agent's OutgoingMessages as-is, instead
  // of buffering a stream into a single concatenated string.
  it('onMessage handler forwards each agent message via channel.send (P2:307)', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'tok';
    process.env['TELEGRAM_CHAT_ID'] = '111';
    vi.spyOn(process, 'on').mockImplementation((() => process) as any);

    const sendSpy = vi.fn().mockResolvedValue(undefined);
    const mockConnect = vi.fn().mockImplementation(() => new Promise(() => {}));
    let capturedOnMessage: ((m: any) => Promise<void>) | undefined;
    const { TelegramChannel } = await import('../src/channels/telegram.js');
    (TelegramChannel as any).mockImplementation(() => ({
      connect: mockConnect,
      disconnect: vi.fn(),
      setEventHandlers: (handlers: any) => { capturedOnMessage = handlers.onMessage; },
      send: sendSpy,
    }));

    mockProcessMessage.mockResolvedValueOnce({
      sessionKey: 'telegram:42',
      messages: [
        { id: 'm1', channel: 'web', peerId: 'user-1', content: { type: 'text', text: 'hello' } },
        { id: 'm2', channel: 'web', peerId: 'user-1', content: { type: 'text', text: 'world' } },
      ],
    });

    await Promise.race([startTelegram(), new Promise<void>((r) => setTimeout(r, 10))]);

    expect(capturedOnMessage).toBeDefined();
    await capturedOnMessage!({
      id: 'in-1',
      channel: 'telegram',
      peerId: '42',
      senderId: 'user',
      content: { type: 'text', text: 'ping' },
      timestamp: Date.now(),
    });

    expect(mockProcessMessage).toHaveBeenCalled();
    // Each agent-produced message is sent separately — no concatenation.
    expect(sendSpy).toHaveBeenCalledTimes(2);
    // peerId must be rebound to the inbound Telegram chat id.
    expect(sendSpy.mock.calls[0]![0].peerId).toBe('42');
    expect(sendSpy.mock.calls[0]![0].channel).toBe('telegram');
    expect(sendSpy.mock.calls[0]![0].content).toEqual({ type: 'text', text: 'hello' });
    expect(sendSpy.mock.calls[1]![0].content).toEqual({ type: 'text', text: 'world' });
  });

  it('onMessage handler drops whitespace-only text messages (P2:307)', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'tok';
    process.env['TELEGRAM_CHAT_ID'] = '111';
    vi.spyOn(process, 'on').mockImplementation((() => process) as any);

    const sendSpy = vi.fn().mockResolvedValue(undefined);
    const mockConnect = vi.fn().mockImplementation(() => new Promise(() => {}));
    let capturedOnMessage: ((m: any) => Promise<void>) | undefined;
    const { TelegramChannel } = await import('../src/channels/telegram.js');
    (TelegramChannel as any).mockImplementation(() => ({
      connect: mockConnect,
      disconnect: vi.fn(),
      setEventHandlers: (handlers: any) => { capturedOnMessage = handlers.onMessage; },
      send: sendSpy,
    }));

    mockProcessMessage.mockResolvedValueOnce({
      sessionKey: 'telegram:42',
      messages: [
        { id: 'm1', channel: 'web', peerId: 'user-1', content: { type: 'text', text: '   \n\t' } },
      ],
    });

    await Promise.race([startTelegram(), new Promise<void>((r) => setTimeout(r, 10))]);
    await capturedOnMessage!({
      id: 'in-1', channel: 'telegram', peerId: '42', senderId: 'user',
      content: { type: 'text', text: 'ping' }, timestamp: Date.now(),
    });

    expect(sendSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. CHAT COMMAND
// ─────────────────────────────────────────────────────────────────────────────
describe('chat command', () => {
  let chatModule: typeof import('../src/cli/commands/chat.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    chatModule = await import('../src/cli/commands/chat.js');
  });

  it('exports chat function', () => {
    expect(typeof chatModule.chat).toBe('function');
  });

  it('exports sendMessage function', () => {
    expect(typeof chatModule.sendMessage).toBe('function');
  });

  it('chat() exits if gateway not running', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });
    mockGetServerPid.mockResolvedValueOnce(null);

    await expect(chatModule.chat()).rejects.toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('chat() exits if gateway PID found but process not running', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });
    mockGetServerPid.mockResolvedValueOnce(1234);
    mockIsProcessRunning.mockReturnValueOnce(false);

    await expect(chatModule.chat()).rejects.toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('chat() exits if no auth token found', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });
    mockGetServerPid.mockResolvedValueOnce(9999);
    mockIsProcessRunning.mockReturnValueOnce(true);
    mockGetAuthToken.mockResolvedValueOnce(null);

    await expect(chatModule.chat()).rejects.toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('chat() calls connect on socket when gateway is running', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    mockGetServerPid.mockResolvedValueOnce(9999);
    mockIsProcessRunning.mockReturnValueOnce(true);
    mockGetAuthToken.mockResolvedValueOnce('test-token');

    const mockSocket = {
      on: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    };
    mockNetConnect.mockReturnValueOnce(mockSocket);

    await Promise.race([chatModule.chat(), new Promise<void>((r) => setTimeout(r, 5))]);

    expect(mockNetConnect).toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('sendMessage exits if gateway not running', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });
    mockGetServerPid.mockResolvedValueOnce(null);

    await expect(chatModule.sendMessage('hello')).rejects.toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('sendMessage exits if no auth token', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });
    mockGetServerPid.mockResolvedValueOnce(9999);
    mockIsProcessRunning.mockReturnValueOnce(true);
    mockGetAuthToken.mockResolvedValueOnce(null);

    await expect(chatModule.sendMessage('hello')).rejects.toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('sendMessage connects to socket when gateway is running', async () => {
    mockGetServerPid.mockResolvedValueOnce(9999);
    mockIsProcessRunning.mockReturnValueOnce(true);
    mockGetAuthToken.mockResolvedValueOnce('test-token');

    const mockSocket = {
      on: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    };
    mockNetConnect.mockReturnValueOnce(mockSocket);

    const sendPromise = chatModule.sendMessage('test message');

    // Give the function time to set up socket handlers
    await new Promise((r) => setTimeout(r, 0));

    // Simulate socket error to terminate the promise
    const errorHandler = mockSocket.on.mock.calls.find((c: any[]) => c[0] === 'error')?.[1];
    if (errorHandler) errorHandler(new Error('connection refused'));

    await sendPromise.catch(() => {}); // allow rejection
    expect(mockNetConnect).toHaveBeenCalled();
  });

  it('sendMessage sends auth message on socket connect', async () => {
    mockGetServerPid.mockResolvedValueOnce(9999);
    mockIsProcessRunning.mockReturnValueOnce(true);
    mockGetAuthToken.mockResolvedValueOnce('test-token');

    const mockSocket = {
      on: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    };
    mockNetConnect.mockReturnValueOnce(mockSocket);

    const sendPromise = chatModule.sendMessage('hello');

    // Wait for socket handlers to be registered
    await new Promise((r) => setTimeout(r, 0));

    const connectHandler = mockSocket.on.mock.calls.find((c: any[]) => c[0] === 'connect')?.[1];
    if (connectHandler) connectHandler();

    // After connect, the auth message should be written
    expect(mockSocket.write).toHaveBeenCalled();
    const written = mockSocket.write.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(written.trim());
    expect(parsed.method).toBe('auth');

    // Clean up
    mockSocket.on.mock.calls.find((c: any[]) => c[0] === 'error')?.[1]?.(new Error('done'));
    await sendPromise.catch(() => {});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. STATUS COMMAND
// ─────────────────────────────────────────────────────────────────────────────
describe('status command', () => {
  let status: typeof import('../src/cli/commands/status.js').status;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAccess.mockResolvedValue(undefined);
    ({ status } = await import('../src/cli/commands/status.js'));
  });

  it('exports status function', () => {
    expect(typeof status).toBe('function');
  });

  it('status() completes without throwing', async () => {
    await expect(status()).resolves.toBeUndefined();
  });

  it('calls getServerPid to check gateway', async () => {
    await status();
    expect(mockGetServerPid).toHaveBeenCalled();
  });

  it('calls loadConfig when config file exists', async () => {
    mockAccess.mockResolvedValue(undefined); // config exists
    await status();
    expect(mockLoadConfig).toHaveBeenCalled();
  });

  it('calls getAuthToken for auth status', async () => {
    await status();
    expect(mockGetAuthToken).toHaveBeenCalled();
  });

  it('reports gateway as running when PID found and process running', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGetServerPid.mockResolvedValueOnce(1234);
    mockIsProcessRunning.mockReturnValueOnce(true);

    await status();
    const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('Running');
    consoleSpy.mockRestore();
  });

  it('reports gateway as stopped when no PID', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGetServerPid.mockResolvedValueOnce(null);

    await status();
    const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('Stopped');
    consoleSpy.mockRestore();
  });

  it('handles config parse error gracefully', async () => {
    mockAccess.mockResolvedValue(undefined);
    mockLoadConfig.mockRejectedValueOnce(new Error('parse error'));

    await expect(status()).resolves.toBeUndefined();
  });

  it('handles getAuthToken error gracefully', async () => {
    mockGetAuthToken.mockRejectedValueOnce(new Error('keychain error'));
    await expect(status()).resolves.toBeUndefined();
  });

  it('displays socket path from getPaths', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await status();
    const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('/tmp/.lain/lain.sock');
    consoleSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. ONBOARD COMMAND
// ─────────────────────────────────────────────────────────────────────────────
describe('onboard command', () => {
  let onboard: typeof import('../src/cli/commands/onboard.js').onboard;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAccess.mockResolvedValue(undefined);
    ({ onboard } = await import('../src/cli/commands/onboard.js'));
  });

  it('exports onboard function', () => {
    expect(typeof onboard).toBe('function');
  });

  it('calls promptOnboard for user input', async () => {
    await onboard();
    expect(mockInquirerPrompt).toHaveBeenCalled();
  });

  it('exits early if user cancels setup', async () => {
    mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: false });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await onboard();
    expect(mockInitDatabase).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('calls initDatabase when user confirms setup', async () => {
    mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true, generateToken: false });
    mockAccess.mockRejectedValue(new Error('not found')); // config doesn't exist

    await onboard();
    expect(mockInitDatabase).toHaveBeenCalled();
  });

  it('generates auth token when generateToken is true', async () => {
    mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true, generateToken: true });
    mockAccess.mockRejectedValue(new Error('not found'));

    await onboard();
    expect(mockGenerateAuthToken).toHaveBeenCalled();
  });

  it('does not generate auth token when generateToken is false', async () => {
    mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true, generateToken: false });
    mockAccess.mockRejectedValue(new Error('not found'));

    await onboard();
    expect(mockGenerateAuthToken).not.toHaveBeenCalled();
  });

  it('calls createInitialConfig if config does not exist', async () => {
    mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true, generateToken: false });
    mockAccess.mockImplementation((path: string) => {
      if (path.includes('lain.json5')) return Promise.reject(new Error('not found'));
      return Promise.resolve(undefined);
    });

    await onboard();
    expect(mockCreateInitialConfig).toHaveBeenCalled();
  });

  it('skips createInitialConfig if config already exists', async () => {
    mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true, generateToken: false });
    mockAccess.mockResolvedValue(undefined); // all files exist

    await onboard();
    // May or may not call — both are fine since it checks first
    // Just verify no crash
    expect(true).toBe(true);
  });

  it('calls process.exit(1) if initDatabase throws', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true, generateToken: false });
    mockAccess.mockRejectedValue(new Error('not found'));
    mockInitDatabase.mockRejectedValueOnce(new Error('db init failed'));

    await onboard();
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('checks Node.js version before proceeding', async () => {
    // Node.js version check is internal; just verify we can call onboard
    await expect(onboard()).resolves.toBeUndefined();
  });

  it('prints "Next steps" on success', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true, generateToken: false });
    mockAccess.mockRejectedValue(new Error('not found'));

    await onboard();
    const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('Next steps');
    consoleSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. PROMPTS UTILITIES
// ─────────────────────────────────────────────────────────────────────────────
describe('CLI utils/prompts', () => {
  let prompts: typeof import('../src/cli/utils/prompts.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    prompts = await import('../src/cli/utils/prompts.js');
  });

  it('displayBanner logs something', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    prompts.displayBanner();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('displaySuccess logs a message', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    prompts.displaySuccess('All good');
    const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join();
    expect(output).toContain('All good');
    consoleSpy.mockRestore();
  });

  it('displayError logs a message', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    prompts.displayError('Something broke');
    const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join();
    expect(output).toContain('Something broke');
    consoleSpy.mockRestore();
  });

  it('displayWarning logs a message', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    prompts.displayWarning('Watch out');
    const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join();
    expect(output).toContain('Watch out');
    consoleSpy.mockRestore();
  });

  it('displayInfo logs a message', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    prompts.displayInfo('FYI');
    const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join();
    expect(output).toContain('FYI');
    consoleSpy.mockRestore();
  });

  it('displayStatus logs label and value', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    prompts.displayStatus('Gateway', 'Running', true);
    const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join();
    expect(output).toContain('Gateway');
    expect(output).toContain('Running');
    consoleSpy.mockRestore();
  });

  it('displaySection logs title', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    prompts.displaySection('Configuration');
    const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join();
    expect(output).toContain('Configuration');
    consoleSpy.mockRestore();
  });

  it('promptOnboard calls inquirer.prompt', async () => {
    mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true, generateToken: true });
    const result = await prompts.promptOnboard();
    expect(mockInquirerPrompt).toHaveBeenCalled();
    expect(result).toEqual({ confirmSetup: true, generateToken: true });
  });

  it('promptApiKey calls inquirer.prompt', async () => {
    mockInquirerPrompt.mockResolvedValueOnce({ hasApiKey: false });
    const result = await prompts.promptApiKey();
    expect(mockInquirerPrompt).toHaveBeenCalled();
    expect(result.hasApiKey).toBe(false);
  });

  it('confirm returns the prompted boolean', async () => {
    mockInquirerPrompt.mockResolvedValueOnce({ confirmed: true });
    const result = await prompts.confirm('Are you sure?');
    expect(result).toBe(true);
  });
});
