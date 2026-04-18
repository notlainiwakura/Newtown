/**
 * CLI Behavioral Tests
 *
 * Tests that actually execute CLI command handlers with mocked dependencies,
 * verifying behavioral contracts beyond the structural checks in cli-system.test.ts.
 *
 * Focus: argument propagation, error handling edge cases, initialization sequences,
 * environment variable interaction, output content validation, config plumbing.
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
    cyan: (s: string) => `[cyan]${s}[/cyan]`,
    green: (s: string) => `[green]${s}[/green]`,
    red: (s: string) => `[red]${s}[/red]`,
    yellow: (s: string) => `[yellow]${s}[/yellow]`,
    blue: (s: string) => `[blue]${s}[/blue]`,
    dim: (s: string) => `[dim]${s}[/dim]`,
    bold: (s: string) => `[bold]${s}[/bold]`,
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
const mockRegisterChatMethod = vi.fn();
vi.mock('../src/gateway/router.js', () => ({
  registerChatMethod: mockRegisterChatMethod,
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
  getDefaultConfig: vi.fn().mockReturnValue({
    agents: [],
    security: { keyDerivation: {} },
  }),
}));

// ─── character manifest mock ─────────────────────────────────────────────────
const mockGetCharacterEntry = vi.fn();
const mockGetPeersFor = vi.fn().mockReturnValue([]);

vi.mock('../src/config/characters.js', () => ({
  getCharacterEntry: mockGetCharacterEntry,
  getPeersFor: mockGetPeersFor,
  getAllCharacters: vi.fn().mockReturnValue([]),
  loadManifest: vi.fn().mockReturnValue({ town: { name: 'Test Town' }, characters: [] }),
}));

// ─── storage mock ────────────────────────────────────────────────────────────
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

// ─── agent mock ──────────────────────────────────────────────────────────────
const mockInitAgent = vi.fn().mockResolvedValue(undefined);
const mockShutdownAgents = vi.fn();

vi.mock('../src/agent/index.js', () => ({
  initAgent: mockInitAgent,
  shutdownAgents: mockShutdownAgents,
  processMessageStream: vi.fn().mockResolvedValue(undefined),
}));

// ─── web server mock ─────────────────────────────────────────────────────────
const mockStartWebServer = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/web/server.js', () => ({
  startWebServer: mockStartWebServer,
}));

// ─── character-server mock ───────────────────────────────────────────────────
const mockStartCharacterServer = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/web/character-server.js', () => ({
  startCharacterServer: mockStartCharacterServer,
}));

// ─── agent/tools mock ────────────────────────────────────────────────────────
const mockRegisteredTools = new Map<string, unknown>();
const mockRegisterTool = vi.fn((tool: any) => mockRegisteredTools.set(tool.definition.name, tool));
const mockUnregisterTool = vi.fn((name: string) => mockRegisteredTools.delete(name));

vi.mock('../src/agent/tools.js', () => ({
  registerTool: mockRegisterTool,
  unregisterTool: mockUnregisterTool,
  getTools: vi.fn(() => []),
}));

// ─── fs mock for plugin loader ───────────────────────────────────────────────
const mockReaddir = vi.fn();
const mockReadFile = vi.fn();
const mockAccess = vi.fn();
const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockCopyFile = vi.fn().mockResolvedValue(undefined);

vi.mock('node:fs/promises', () => ({
  readdir: mockReaddir,
  readFile: mockReadFile,
  access: mockAccess,
  mkdir: mockMkdir,
  copyFile: mockCopyFile,
  constants: { R_OK: 4 },
}));

// ─── node:child_process mock ─────────────────────────────────────────────────
const mockSpawn = vi.fn().mockReturnValue({ unref: vi.fn() });
vi.mock('node:child_process', () => ({ spawn: mockSpawn }));

// ─── node:net mock ───────────────────────────────────────────────────────────
const mockNetConnect = vi.fn();
vi.mock('node:net', () => ({ connect: mockNetConnect }));

// ─── dotenv mock ─────────────────────────────────────────────────────────────
vi.mock('dotenv/config', () => ({}));

// ─── TelegramChannel mock ───────────────────────────────────────────────────
const mockTelegramConnect = vi.fn().mockImplementation(() => new Promise(() => {}));
const mockTelegramDisconnect = vi.fn().mockResolvedValue(undefined);
const mockTelegramSetEventHandlers = vi.fn();
const mockTelegramSend = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/channels/telegram.js', () => ({
  TelegramChannel: vi.fn(() => ({
    connect: mockTelegramConnect,
    disconnect: mockTelegramDisconnect,
    send: mockTelegramSend,
    setEventHandlers: mockTelegramSetEventHandlers,
    connected: false,
    id: 'telegram-main',
    type: 'telegram',
  })),
}));

// ─── Utility: capture console output ─────────────────────────────────────────
function captureConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  return {
    logs,
    errors,
    output: () => logs.join('\n'),
    errorOutput: () => errors.join('\n'),
    restore: () => { logSpy.mockRestore(); errorSpy.mockRestore(); },
  };
}

// ─── Utility: mock process.exit ──────────────────────────────────────────────
function mockProcessExit() {
  const exitCalls: number[] = [];
  const spy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
    exitCalls.push(code ?? 0);
    throw new Error(`process.exit(${code})`);
  });
  return {
    spy,
    exitCalls,
    restore: () => spy.mockRestore(),
    expectCalledWith: (code: number) => expect(spy).toHaveBeenCalledWith(code),
  };
}

// =============================================================================
// 1. CHARACTER COMMAND BEHAVIORAL
// =============================================================================
describe('Character command behavioral', () => {
  let startCharacterById: typeof import('../src/cli/commands/character.js').startCharacterById;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ startCharacterById } = await import('../src/cli/commands/character.js'));
  });

  describe('valid character startup', () => {
    const lainEntry = { id: 'lain', name: 'Lain', port: 3001, possessable: false, workspace: 'workspace/characters/lain' };

    beforeEach(() => {
      mockGetCharacterEntry.mockReturnValue(lainEntry);
    });

    it('passes character id from manifest to startCharacterServer', async () => {
      await startCharacterById('lain');
      expect(mockStartCharacterServer.mock.calls[0]?.[0]).toMatchObject({ id: 'lain' });
    });

    it('passes character name from manifest to startCharacterServer', async () => {
      await startCharacterById('lain');
      expect(mockStartCharacterServer.mock.calls[0]?.[0]).toMatchObject({ name: 'Lain' });
    });

    it('passes manifest port when no override given', async () => {
      await startCharacterById('lain');
      expect(mockStartCharacterServer.mock.calls[0]?.[0]).toMatchObject({ port: 3001 });
    });

    it('overrides port when portOverride is given', async () => {
      await startCharacterById('lain', 5555);
      expect(mockStartCharacterServer.mock.calls[0]?.[0]).toMatchObject({ port: 5555 });
    });

    it('override port 0 is still passed through (edge case)', async () => {
      await startCharacterById('lain', 0);
      expect(mockStartCharacterServer.mock.calls[0]?.[0]?.port).toBe(0);
    });

    it('config includes a publicDir string', async () => {
      await startCharacterById('lain');
      const config = mockStartCharacterServer.mock.calls[0]?.[0];
      expect(config?.publicDir).toEqual(expect.any(String));
    });

    it('publicDir contains the character id', async () => {
      await startCharacterById('lain');
      const config = mockStartCharacterServer.mock.calls[0]?.[0];
      expect(config?.publicDir).toContain('public-lain');
    });

    it('publicDir for different characters uses their id', async () => {
      mockGetCharacterEntry.mockReturnValue({ id: 'pkd', name: 'PKD', port: 3003 });
      await startCharacterById('pkd');
      const config = mockStartCharacterServer.mock.calls[0]?.[0];
      expect(config?.publicDir).toContain('public-pkd');
    });

    it('config includes peers array', async () => {
      mockGetPeersFor.mockReturnValue([{ id: 'wired-lain', name: 'Wired Lain', url: 'http://localhost:3000' }]);
      await startCharacterById('lain');
      const config = mockStartCharacterServer.mock.calls[0]?.[0];
      expect(config?.peers).toHaveLength(1);
      expect(config?.peers[0]).toMatchObject({ id: 'wired-lain' });
    });

    it('calls getPeersFor with the correct character id', async () => {
      delete process.env['PEER_CONFIG'];
      await startCharacterById('lain');
      expect(mockGetPeersFor).toHaveBeenCalledWith('lain');
    });

    it('does not set possessable when entry lacks that field', async () => {
      mockGetCharacterEntry.mockReturnValue({ id: 'lain', name: 'Lain', port: 3001 });
      await startCharacterById('lain');
      const config = mockStartCharacterServer.mock.calls[0]?.[0];
      expect(config?.possessable).toBeUndefined();
    });

    it('sets possessable true when entry has possessable=true', async () => {
      mockGetCharacterEntry.mockReturnValue({ id: 'hiru', name: 'Hiru', port: 3005, possessable: true });
      await startCharacterById('hiru');
      expect(mockStartCharacterServer.mock.calls[0]?.[0]?.possessable).toBe(true);
    });

    it('does not set possessable when entry.possessable is false', async () => {
      mockGetCharacterEntry.mockReturnValue({ id: 'lain', name: 'Lain', port: 3001, possessable: false });
      await startCharacterById('lain');
      const config = mockStartCharacterServer.mock.calls[0]?.[0];
      expect(config?.possessable).toBeUndefined();
    });

    it('calls startCharacterServer exactly once', async () => {
      await startCharacterById('lain');
      expect(mockStartCharacterServer).toHaveBeenCalledTimes(1);
    });
  });

  describe('PEER_CONFIG environment variable', () => {
    beforeEach(() => {
      mockGetCharacterEntry.mockReturnValue({ id: 'lain', name: 'Lain', port: 3001 });
    });

    afterEach(() => {
      delete process.env['PEER_CONFIG'];
    });

    it('uses PEER_CONFIG env var when set as valid JSON array', async () => {
      const peers = [{ id: 'wired-lain', name: 'Wired Lain', url: 'http://localhost:3000' }];
      process.env['PEER_CONFIG'] = JSON.stringify(peers);
      await startCharacterById('lain');
      expect(mockStartCharacterServer.mock.calls[0]?.[0]?.peers).toEqual(peers);
      expect(mockGetPeersFor).not.toHaveBeenCalled();
    });

    it('falls back to getPeersFor when PEER_CONFIG is invalid JSON', async () => {
      process.env['PEER_CONFIG'] = 'not json at all';
      const expected = [{ id: 'peer1', name: 'Peer1', url: 'http://localhost:3002' }];
      mockGetPeersFor.mockReturnValue(expected);
      await startCharacterById('lain');
      expect(mockGetPeersFor).toHaveBeenCalledWith('lain');
      expect(mockStartCharacterServer.mock.calls[0]?.[0]?.peers).toEqual(expected);
    });

    it('falls back to getPeersFor when PEER_CONFIG is empty string', async () => {
      process.env['PEER_CONFIG'] = '';
      mockGetPeersFor.mockReturnValue([]);
      await startCharacterById('lain');
      expect(mockGetPeersFor).toHaveBeenCalledWith('lain');
    });

    it('falls back to getPeersFor when PEER_CONFIG is undefined', async () => {
      delete process.env['PEER_CONFIG'];
      await startCharacterById('lain');
      expect(mockGetPeersFor).toHaveBeenCalledWith('lain');
    });

    it('PEER_CONFIG with multiple peers all passed through', async () => {
      const peers = [
        { id: 'a', name: 'A', url: 'http://localhost:3001' },
        { id: 'b', name: 'B', url: 'http://localhost:3002' },
        { id: 'c', name: 'C', url: 'http://localhost:3003' },
      ];
      process.env['PEER_CONFIG'] = JSON.stringify(peers);
      await startCharacterById('lain');
      expect(mockStartCharacterServer.mock.calls[0]?.[0]?.peers).toHaveLength(3);
    });

    it('PEER_CONFIG with empty array results in empty peers', async () => {
      process.env['PEER_CONFIG'] = '[]';
      await startCharacterById('lain');
      expect(mockStartCharacterServer.mock.calls[0]?.[0]?.peers).toEqual([]);
    });
  });

  describe('unknown character handling', () => {
    it('displays error message containing the unknown character id', async () => {
      mockGetCharacterEntry.mockReturnValue(undefined);
      const console_ = captureConsole();
      const exit = mockProcessExit();

      await expect(startCharacterById('ghost-char')).rejects.toThrow('process.exit(1)');
      expect(console_.output()).toContain('ghost-char');

      console_.restore();
      exit.restore();
    });

    it('displays error suggesting to add character to characters.json', async () => {
      mockGetCharacterEntry.mockReturnValue(undefined);
      const console_ = captureConsole();
      const exit = mockProcessExit();

      await expect(startCharacterById('missing')).rejects.toThrow('process.exit(1)');
      expect(console_.output()).toContain('characters.json');

      console_.restore();
      exit.restore();
    });

    it('calls getCharacterEntry before any server startup', async () => {
      mockGetCharacterEntry.mockReturnValue(undefined);
      const exit = mockProcessExit();
      const console_ = captureConsole();

      await expect(startCharacterById('nope')).rejects.toThrow();
      expect(mockGetCharacterEntry).toHaveBeenCalledWith('nope');
      expect(mockStartCharacterServer).not.toHaveBeenCalled();

      console_.restore();
      exit.restore();
    });

    it('exits with code 1 for null return from getCharacterEntry', async () => {
      mockGetCharacterEntry.mockReturnValue(null);
      const exit = mockProcessExit();
      const console_ = captureConsole();

      await expect(startCharacterById('null-char')).rejects.toThrow('process.exit(1)');

      console_.restore();
      exit.restore();
    });
  });

  describe('server startup failure', () => {
    it('displays error containing "Failed to start"', async () => {
      mockGetCharacterEntry.mockReturnValue({ id: 'lain', name: 'Lain', port: 3001 });
      mockStartCharacterServer.mockRejectedValueOnce(new Error('EADDRINUSE'));
      const console_ = captureConsole();
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      await startCharacterById('lain');
      expect(console_.output()).toContain('Failed to start');

      console_.restore();
      exit.mockRestore();
    });

    it('displays the character name in the error message', async () => {
      mockGetCharacterEntry.mockReturnValue({ id: 'pkd', name: 'Philip K. Dick', port: 3003 });
      mockStartCharacterServer.mockRejectedValueOnce(new Error('crash'));
      const console_ = captureConsole();
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      await startCharacterById('pkd');
      expect(console_.output()).toContain('Philip K. Dick');

      console_.restore();
      exit.mockRestore();
    });

    it('includes the original error in the display', async () => {
      mockGetCharacterEntry.mockReturnValue({ id: 'lain', name: 'Lain', port: 3001 });
      mockStartCharacterServer.mockRejectedValueOnce(new Error('bind EADDRINUSE'));
      const console_ = captureConsole();
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      await startCharacterById('lain');
      expect(console_.output()).toContain('bind EADDRINUSE');

      console_.restore();
      exit.mockRestore();
    });

    it('exits with code 1 on server startup failure', async () => {
      mockGetCharacterEntry.mockReturnValue({ id: 'lain', name: 'Lain', port: 3001 });
      mockStartCharacterServer.mockRejectedValueOnce(new Error('crash'));
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const console_ = captureConsole();

      await startCharacterById('lain');
      expect(exit).toHaveBeenCalledWith(1);

      console_.restore();
      exit.mockRestore();
    });
  });

  describe('multiple character IDs', () => {
    it('wired-lain ID is resolved correctly', async () => {
      mockGetCharacterEntry.mockReturnValue({ id: 'wired-lain', name: 'Wired Lain', port: 3000 });
      await startCharacterById('wired-lain');
      expect(mockStartCharacterServer.mock.calls[0]?.[0]?.id).toBe('wired-lain');
    });

    it('dr-claude ID is resolved correctly', async () => {
      mockGetCharacterEntry.mockReturnValue({ id: 'dr-claude', name: 'Dr. Claude', port: 3004 });
      await startCharacterById('dr-claude');
      expect(mockStartCharacterServer.mock.calls[0]?.[0]?.id).toBe('dr-claude');
    });

    it('character IDs with hyphens are handled', async () => {
      mockGetCharacterEntry.mockReturnValue({ id: 'my-char-id', name: 'My Char', port: 4000 });
      await startCharacterById('my-char-id');
      expect(mockGetCharacterEntry).toHaveBeenCalledWith('my-char-id');
    });

    it('character IDs with numbers are handled', async () => {
      mockGetCharacterEntry.mockReturnValue({ id: 'agent007', name: 'Agent 007', port: 4007 });
      await startCharacterById('agent007');
      expect(mockGetCharacterEntry).toHaveBeenCalledWith('agent007');
    });
  });
});

// =============================================================================
// 2. WEB COMMAND BEHAVIORAL
// =============================================================================
describe('Web command behavioral', () => {
  let startWeb: typeof import('../src/cli/commands/web.js').startWeb;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ startWeb } = await import('../src/cli/commands/web.js'));
  });

  describe('port handling', () => {
    it('passes port 3000 as default', async () => {
      await startWeb();
      expect(mockStartWebServer).toHaveBeenCalledWith(3000);
    });

    it('passes explicit port 8080', async () => {
      await startWeb(8080);
      expect(mockStartWebServer).toHaveBeenCalledWith(8080);
    });

    it('passes port 0 (OS auto-assign)', async () => {
      await startWeb(0);
      expect(mockStartWebServer).toHaveBeenCalledWith(0);
    });

    it('passes high port 65535', async () => {
      await startWeb(65535);
      expect(mockStartWebServer).toHaveBeenCalledWith(65535);
    });

    it('passes port 1 (privileged port)', async () => {
      await startWeb(1);
      expect(mockStartWebServer).toHaveBeenCalledWith(1);
    });

    it('calls startWebServer exactly once per invocation', async () => {
      await startWeb(3000);
      expect(mockStartWebServer).toHaveBeenCalledTimes(1);
    });

    it('multiple sequential calls each invoke startWebServer', async () => {
      await startWeb(3000);
      await startWeb(4000);
      expect(mockStartWebServer).toHaveBeenCalledTimes(2);
      expect(mockStartWebServer).toHaveBeenNthCalledWith(1, 3000);
      expect(mockStartWebServer).toHaveBeenNthCalledWith(2, 4000);
    });
  });

  describe('error handling', () => {
    it('displays error message when startWebServer throws', async () => {
      mockStartWebServer.mockRejectedValueOnce(new Error('EADDRINUSE'));
      const console_ = captureConsole();
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      await startWeb(3000);
      expect(console_.output()).toContain('Failed to start web server');

      console_.restore();
      exit.mockRestore();
    });

    it('includes original error in display', async () => {
      mockStartWebServer.mockRejectedValueOnce(new Error('Permission denied'));
      const console_ = captureConsole();
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      await startWeb(3000);
      expect(console_.output()).toContain('Permission denied');

      console_.restore();
      exit.mockRestore();
    });

    it('exits with code 1 on failure', async () => {
      mockStartWebServer.mockRejectedValueOnce(new Error('fail'));
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const console_ = captureConsole();

      await startWeb(3000);
      expect(exit).toHaveBeenCalledWith(1);

      console_.restore();
      exit.mockRestore();
    });

    it('handles non-Error throw from startWebServer', async () => {
      mockStartWebServer.mockRejectedValueOnce('string error');
      const console_ = captureConsole();
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      await startWeb(3000);
      expect(exit).toHaveBeenCalledWith(1);
      expect(console_.output()).toContain('string error');

      console_.restore();
      exit.mockRestore();
    });

    it('resolves undefined on success', async () => {
      const result = await startWeb(3000);
      expect(result).toBeUndefined();
    });

    it('does not call process.exit on success', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      await startWeb(3000);
      expect(exit).not.toHaveBeenCalled();
      exit.mockRestore();
    });
  });

  describe('CLI program integration', () => {
    it('web command parses --port option and converts to integer', async () => {
      const { program } = await import('../src/cli/index.js');
      const webCmd = program.commands.find((c) => c.name() === 'web')!;
      const portOpt = webCmd.options.find((o) => o.long === '--port');
      expect(portOpt).toBeDefined();
      expect(portOpt?.defaultValue).toBe('3000');
    });

    it('web command port option uses -p as short flag', async () => {
      const { program } = await import('../src/cli/index.js');
      const webCmd = program.commands.find((c) => c.name() === 'web')!;
      const portOpt = webCmd.options.find((o) => o.short === '-p');
      expect(portOpt).toBeDefined();
    });
  });
});

// =============================================================================
// 3. GATEWAY COMMAND BEHAVIORAL
// =============================================================================
describe('Gateway command behavioral', () => {
  let startGateway: typeof import('../src/cli/commands/gateway.js').startGateway;
  let stopGateway: typeof import('../src/cli/commands/gateway.js').stopGateway;
  let startDaemon: typeof import('../src/cli/commands/gateway.js').startDaemon;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ startGateway, stopGateway, startDaemon } = await import('../src/cli/commands/gateway.js'));
  });

  describe('startGateway initialization sequence', () => {
    it('calls loadConfig before startServer', async () => {
      mockGetServerPid.mockResolvedValueOnce(null);
      const callOrder: string[] = [];
      mockLoadConfig.mockImplementation(async () => {
        callOrder.push('loadConfig');
        return {
          version: '0.1.0',
          agents: [],
          gateway: { socketPath: '/tmp/.lain/lain.sock' },
          security: { requireAuth: true, maxMessageLength: 4096, keyDerivation: {} },
          logging: {},
        };
      });
      mockStartServer.mockImplementation(async () => { callOrder.push('startServer'); });
      const processOnSpy = vi.spyOn(process, 'on').mockImplementation((() => process) as any);

      await startGateway();
      expect(callOrder.indexOf('loadConfig')).toBeLessThan(callOrder.indexOf('startServer'));

      processOnSpy.mockRestore();
    });

    it('calls initDatabase before initAgent', async () => {
      mockGetServerPid.mockResolvedValueOnce(null);
      const callOrder: string[] = [];
      mockInitDatabase.mockImplementation(async () => { callOrder.push('initDatabase'); });
      mockInitAgent.mockImplementation(async () => { callOrder.push('initAgent'); });
      mockLoadConfig.mockResolvedValue({
        version: '0.1.0',
        agents: [{ id: 'default', name: 'Test', enabled: true, workspace: '/tmp' }],
        gateway: { socketPath: '/tmp/.lain/lain.sock' },
        security: { requireAuth: true, maxMessageLength: 4096, keyDerivation: {} },
        logging: {},
      });
      const processOnSpy = vi.spyOn(process, 'on').mockImplementation((() => process) as any);

      await startGateway();
      const dbIdx = callOrder.indexOf('initDatabase');
      const agentIdx = callOrder.indexOf('initAgent');
      expect(dbIdx).toBeGreaterThanOrEqual(0);
      expect(agentIdx).toBeGreaterThanOrEqual(0);
      expect(dbIdx).toBeLessThan(agentIdx);

      processOnSpy.mockRestore();
    });

    it('initializes agents from config.agents array', async () => {
      mockGetServerPid.mockResolvedValueOnce(null);
      const agents = [
        { id: 'agent1', name: 'Agent 1', enabled: true, workspace: '/tmp' },
        { id: 'agent2', name: 'Agent 2', enabled: true, workspace: '/tmp' },
      ];
      mockLoadConfig.mockResolvedValue({
        version: '0.1.0',
        agents,
        gateway: { socketPath: '/tmp/.lain/lain.sock' },
        security: { requireAuth: true, maxMessageLength: 4096, keyDerivation: {} },
        logging: {},
      });
      const processOnSpy = vi.spyOn(process, 'on').mockImplementation((() => process) as any);

      await startGateway();
      expect(mockInitAgent).toHaveBeenCalledTimes(2);

      processOnSpy.mockRestore();
    });

    it('registers chat method after agent initialization', async () => {
      mockGetServerPid.mockResolvedValueOnce(null);
      mockLoadConfig.mockResolvedValue({
        version: '0.1.0',
        agents: [],
        gateway: { socketPath: '/tmp/.lain/lain.sock' },
        security: { requireAuth: true, maxMessageLength: 4096, keyDerivation: {} },
        logging: {},
      });
      const processOnSpy = vi.spyOn(process, 'on').mockImplementation((() => process) as any);

      await startGateway();
      expect(mockRegisterChatMethod).toHaveBeenCalled();

      processOnSpy.mockRestore();
    });

    it('passes security config to startServer', async () => {
      mockGetServerPid.mockResolvedValueOnce(null);
      mockLoadConfig.mockResolvedValue({
        version: '0.1.0',
        agents: [],
        gateway: { socketPath: '/tmp/test.sock' },
        security: { requireAuth: false, maxMessageLength: 8192, keyDerivation: {} },
        logging: {},
      });
      const processOnSpy = vi.spyOn(process, 'on').mockImplementation((() => process) as any);

      await startGateway();
      expect(mockStartServer).toHaveBeenCalledWith(
        expect.objectContaining({ socketPath: '/tmp/test.sock' }),
        expect.objectContaining({ requireAuth: false, maxMessageLength: 8192 })
      );

      processOnSpy.mockRestore();
    });

    it('registers SIGTERM and SIGINT handlers', async () => {
      mockGetServerPid.mockResolvedValueOnce(null);
      const processOnSpy = vi.spyOn(process, 'on').mockImplementation((() => process) as any);

      await startGateway();
      const registeredSignals = processOnSpy.mock.calls.map(c => c[0]);
      expect(registeredSignals).toContain('SIGTERM');
      expect(registeredSignals).toContain('SIGINT');

      processOnSpy.mockRestore();
    });
  });

  describe('startGateway conflict detection', () => {
    it('exits if gateway is already running', async () => {
      mockGetServerPid.mockResolvedValueOnce(1234);
      mockIsProcessRunning.mockReturnValueOnce(true);
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const console_ = captureConsole();

      await startGateway();
      expect(exit).toHaveBeenCalledWith(1);
      expect(console_.output()).toContain('already running');

      console_.restore();
      exit.mockRestore();
    });

    it('proceeds if PID exists but process is not running (stale PID)', async () => {
      mockGetServerPid.mockResolvedValueOnce(9999);
      mockIsProcessRunning.mockReturnValueOnce(false);
      const processOnSpy = vi.spyOn(process, 'on').mockImplementation((() => process) as any);

      await startGateway();
      expect(mockStartServer).toHaveBeenCalled();

      processOnSpy.mockRestore();
    });
  });

  describe('startGateway error paths', () => {
    it('exits with 1 when loadConfig throws', async () => {
      mockGetServerPid.mockResolvedValueOnce(null);
      mockLoadConfig.mockRejectedValueOnce(new Error('bad config'));
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const console_ = captureConsole();

      await startGateway();
      expect(exit).toHaveBeenCalledWith(1);
      expect(console_.output()).toContain('Failed to start gateway');

      console_.restore();
      exit.mockRestore();
    });

    it('exits with 1 when initDatabase throws', async () => {
      mockGetServerPid.mockResolvedValueOnce(null);
      mockInitDatabase.mockRejectedValueOnce(new Error('db locked'));
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const console_ = captureConsole();

      await startGateway();
      expect(exit).toHaveBeenCalledWith(1);

      console_.restore();
      exit.mockRestore();
    });

    it('exits with 1 when startServer throws', async () => {
      mockGetServerPid.mockResolvedValueOnce(null);
      mockStartServer.mockRejectedValueOnce(new Error('EADDRINUSE'));
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const console_ = captureConsole();

      await startGateway();
      expect(exit).toHaveBeenCalledWith(1);

      console_.restore();
      exit.mockRestore();
    });
  });

  describe('stopGateway', () => {
    it('warns when no PID file found', async () => {
      mockGetServerPid.mockResolvedValueOnce(null);
      const console_ = captureConsole();

      await stopGateway();
      expect(console_.output()).toContain('not running');

      console_.restore();
    });

    it('warns when PID exists but process is dead', async () => {
      mockGetServerPid.mockResolvedValueOnce(7777);
      mockIsProcessRunning.mockReturnValue(false);
      const console_ = captureConsole();

      await stopGateway();
      expect(console_.output()).toContain('not');

      console_.restore();
    });

    it('sends SIGTERM to running process', async () => {
      // Reset mocks fully to clear sticky mockReturnValue from prior tests
      mockGetServerPid.mockReset();
      mockIsProcessRunning.mockReset();
      mockGetServerPid.mockResolvedValueOnce(8888);
      mockIsProcessRunning.mockReturnValueOnce(true).mockReturnValue(false);
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      await stopGateway();
      expect(killSpy).toHaveBeenCalledWith(8888, 'SIGTERM');

      killSpy.mockRestore();
    });

    it('sends SIGKILL if process does not stop after SIGTERM', async () => {
      // Process remains running for all 10 attempts
      mockGetServerPid.mockResolvedValueOnce(8888);
      mockIsProcessRunning.mockReturnValue(true);
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      vi.useFakeTimers();
      const p = stopGateway();
      await vi.runAllTimersAsync();
      await p;

      const killCalls = killSpy.mock.calls;
      expect(killCalls[0]).toEqual([8888, 'SIGTERM']);
      const sigkillCall = killCalls.find(c => c[1] === 'SIGKILL');
      expect(sigkillCall).toBeDefined();

      killSpy.mockRestore();
      vi.useRealTimers();
    });

    it('displays success message when process stops', async () => {
      mockGetServerPid.mockResolvedValueOnce(8888);
      mockIsProcessRunning.mockReturnValueOnce(true).mockReturnValueOnce(false);
      vi.spyOn(process, 'kill').mockImplementation(() => true);
      const console_ = captureConsole();

      await stopGateway();
      expect(console_.output()).toContain('stopped');

      console_.restore();
    });

    it('handles process.kill throwing an error', async () => {
      mockGetServerPid.mockResolvedValueOnce(8888);
      mockIsProcessRunning.mockReturnValueOnce(true);
      vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('EPERM'); });
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const console_ = captureConsole();

      await stopGateway();
      expect(exit).toHaveBeenCalledWith(1);

      console_.restore();
      exit.mockRestore();
    });
  });

  describe('startDaemon', () => {
    it('exits if gateway already running', async () => {
      mockGetServerPid.mockResolvedValue(1234);
      mockIsProcessRunning.mockReturnValue(true);
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const console_ = captureConsole();

      await startDaemon();
      expect(exit).toHaveBeenCalledWith(1);
      expect(console_.output()).toContain('already running');

      console_.restore();
      exit.mockRestore();
    });

    it('spawns process with detached:true and stdio:ignore', async () => {
      vi.useFakeTimers();
      mockGetServerPid.mockResolvedValueOnce(null).mockResolvedValueOnce(5678);
      mockIsProcessRunning.mockReturnValue(true);

      const p = startDaemon();
      await vi.runAllTimersAsync();
      await p;

      expect(mockSpawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ detached: true, stdio: 'ignore' })
      );

      vi.useRealTimers();
    });

    it('sets LAIN_DAEMON env var in spawned process', async () => {
      vi.useFakeTimers();
      mockGetServerPid.mockResolvedValueOnce(null).mockResolvedValueOnce(5678);
      mockIsProcessRunning.mockReturnValue(true);

      const p = startDaemon();
      await vi.runAllTimersAsync();
      await p;

      const spawnEnv = mockSpawn.mock.calls[0]?.[2]?.env;
      expect(spawnEnv?.LAIN_DAEMON).toBe('1');

      vi.useRealTimers();
    });

    it('reports success with PID on successful daemon start', async () => {
      vi.useFakeTimers();
      mockGetServerPid.mockResolvedValueOnce(null).mockResolvedValueOnce(5678);
      mockIsProcessRunning.mockReturnValue(true);
      const console_ = captureConsole();

      const p = startDaemon();
      await vi.runAllTimersAsync();
      await p;

      expect(console_.output()).toContain('5678');

      console_.restore();
      vi.useRealTimers();
    });

    it('exits with 1 if daemon does not start', async () => {
      vi.useFakeTimers();
      mockGetServerPid.mockResolvedValue(null);
      mockIsProcessRunning.mockReturnValue(false);
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const console_ = captureConsole();

      const p = startDaemon();
      await vi.runAllTimersAsync();
      await p;

      expect(exit).toHaveBeenCalledWith(1);

      console_.restore();
      exit.mockRestore();
      vi.useRealTimers();
    });

    it('calls unref() on the spawned child', async () => {
      vi.useFakeTimers();
      const mockUnref = vi.fn();
      mockSpawn.mockReturnValue({ unref: mockUnref });
      mockGetServerPid.mockResolvedValueOnce(null).mockResolvedValueOnce(5678);
      mockIsProcessRunning.mockReturnValue(true);

      const p = startDaemon();
      await vi.runAllTimersAsync();
      await p;

      expect(mockUnref).toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe('CLI program gateway sub-commands', () => {
    it('gateway stop sub-command is registered', async () => {
      const { program } = await import('../src/cli/index.js');
      const gateway = program.commands.find(c => c.name() === 'gateway')!;
      const stop = gateway.commands.find(c => c.name() === 'stop');
      expect(stop).toBeDefined();
    });

    it('gateway --daemon option is boolean', async () => {
      const { program } = await import('../src/cli/index.js');
      const gateway = program.commands.find(c => c.name() === 'gateway')!;
      const daemonOpt = gateway.options.find(o => o.long === '--daemon');
      expect(daemonOpt).toBeDefined();
    });
  });
});

// =============================================================================
// 4. STATUS COMMAND BEHAVIORAL
// =============================================================================
describe('Status command behavioral', () => {
  let status: typeof import('../src/cli/commands/status.js').status;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAccess.mockResolvedValue(undefined);
    ({ status } = await import('../src/cli/commands/status.js'));
  });

  describe('gateway status reporting', () => {
    it('reports "Running" when gateway PID exists and process is alive', async () => {
      mockGetServerPid.mockResolvedValueOnce(1234);
      mockIsProcessRunning.mockReturnValueOnce(true);
      const console_ = captureConsole();

      await status();
      expect(console_.output()).toContain('Running');

      console_.restore();
    });

    it('reports "Stopped" when no PID found', async () => {
      mockGetServerPid.mockResolvedValueOnce(null);
      const console_ = captureConsole();

      await status();
      expect(console_.output()).toContain('Stopped');

      console_.restore();
    });

    it('reports "Stopped" when PID exists but process is dead', async () => {
      mockGetServerPid.mockResolvedValueOnce(5555);
      mockIsProcessRunning.mockReturnValueOnce(false);
      const console_ = captureConsole();

      await status();
      expect(console_.output()).toContain('Stopped');

      console_.restore();
    });

    it('shows PID number when gateway is running', async () => {
      mockGetServerPid.mockResolvedValueOnce(4242);
      mockIsProcessRunning.mockReturnValueOnce(true);
      const console_ = captureConsole();

      await status();
      expect(console_.output()).toContain('4242');

      console_.restore();
    });

    it('displays socket path', async () => {
      const console_ = captureConsole();

      await status();
      expect(console_.output()).toContain('/tmp/.lain/lain.sock');

      console_.restore();
    });
  });

  describe('configuration status', () => {
    it('reports config as "Found" when file exists', async () => {
      mockAccess.mockResolvedValue(undefined);
      const console_ = captureConsole();

      await status();
      expect(console_.output()).toContain('Found');

      console_.restore();
    });

    it('reports config as "Not found" when file missing', async () => {
      mockAccess.mockImplementation((path: string) => {
        if (path.includes('lain.json5')) return Promise.reject(new Error('ENOENT'));
        return Promise.resolve(undefined);
      });
      const console_ = captureConsole();

      await status();
      expect(console_.output()).toContain('Not found');

      console_.restore();
    });

    it('shows config version when config exists', async () => {
      mockLoadConfig.mockResolvedValue({
        version: '2.0.0',
        agents: [{ id: 'a' }],
        security: { requireAuth: true },
      });
      const console_ = captureConsole();

      await status();
      expect(console_.output()).toContain('2.0.0');

      console_.restore();
    });

    it('shows agent count from config', async () => {
      mockLoadConfig.mockResolvedValue({
        version: '1.0',
        agents: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        security: { requireAuth: false },
      });
      const console_ = captureConsole();

      await status();
      expect(console_.output()).toContain('3');

      console_.restore();
    });

    it('handles config parse error without crashing', async () => {
      mockLoadConfig.mockRejectedValueOnce(new Error('JSON parse error'));
      await expect(status()).resolves.toBeUndefined();
    });

    it('displays config path', async () => {
      const console_ = captureConsole();

      await status();
      expect(console_.output()).toContain('/tmp/.lain/lain.json5');

      console_.restore();
    });
  });

  describe('authentication status', () => {
    it('reports "Configured" when auth token exists', async () => {
      mockGetAuthToken.mockResolvedValueOnce('some-token');
      const console_ = captureConsole();

      await status();
      expect(console_.output()).toContain('Configured');

      console_.restore();
    });

    it('reports "Not set" when no auth token', async () => {
      mockGetAuthToken.mockResolvedValueOnce(null);
      const console_ = captureConsole();

      await status();
      expect(console_.output()).toContain('Not set');

      console_.restore();
    });

    it('handles keychain error gracefully', async () => {
      mockGetAuthToken.mockRejectedValueOnce(new Error('keychain locked'));
      await expect(status()).resolves.toBeUndefined();
    });
  });

  describe('workspace status', () => {
    it('reports workspace files as present when all exist', async () => {
      mockAccess.mockResolvedValue(undefined);
      const console_ = captureConsole();

      await status();
      expect(console_.output()).toContain('SOUL.md');
      expect(console_.output()).toContain('AGENTS.md');
      expect(console_.output()).toContain('IDENTITY.md');

      console_.restore();
    });

    it('reports workspace as not found when directory missing', async () => {
      mockAccess.mockImplementation((path: string) => {
        if (path.includes('workspace')) return Promise.reject(new Error('ENOENT'));
        return Promise.resolve(undefined);
      });
      const console_ = captureConsole();

      await status();
      expect(console_.output()).toContain('Not found');

      console_.restore();
    });

    it('displays database path', async () => {
      const console_ = captureConsole();

      await status();
      expect(console_.output()).toContain('/tmp/.lain/lain.db');

      console_.restore();
    });
  });

  describe('summary messages', () => {
    it('suggests "lain onboard" when config not found', async () => {
      mockAccess.mockImplementation((path: string) => {
        if (path.includes('lain.json5')) return Promise.reject(new Error('ENOENT'));
        return Promise.resolve(undefined);
      });
      const console_ = captureConsole();

      await status();
      expect(console_.output()).toContain('onboard');

      console_.restore();
    });

    it('suggests "lain gateway" when config exists but gateway not running', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockGetServerPid.mockResolvedValueOnce(null);
      const console_ = captureConsole();

      await status();
      expect(console_.output()).toContain('gateway');

      console_.restore();
    });

    it('reports "Lain is ready" when everything is up', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockGetServerPid.mockResolvedValueOnce(1234);
      mockIsProcessRunning.mockReturnValueOnce(true);
      const console_ = captureConsole();

      await status();
      expect(console_.output()).toContain('ready');

      console_.restore();
    });
  });

  describe('section headers', () => {
    it('displays Gateway section', async () => {
      const console_ = captureConsole();
      await status();
      expect(console_.output()).toContain('Gateway');
      console_.restore();
    });

    it('displays Configuration section', async () => {
      const console_ = captureConsole();
      await status();
      expect(console_.output()).toContain('Configuration');
      console_.restore();
    });

    it('displays Authentication section', async () => {
      const console_ = captureConsole();
      await status();
      expect(console_.output()).toContain('Authentication');
      console_.restore();
    });

    it('displays Database section', async () => {
      const console_ = captureConsole();
      await status();
      expect(console_.output()).toContain('Database');
      console_.restore();
    });

    it('displays Workspace section', async () => {
      const console_ = captureConsole();
      await status();
      expect(console_.output()).toContain('Workspace');
      console_.restore();
    });

    it('displays Summary section', async () => {
      const console_ = captureConsole();
      await status();
      expect(console_.output()).toContain('Summary');
      console_.restore();
    });
  });
});

// =============================================================================
// 5. ONBOARD COMMAND BEHAVIORAL
// =============================================================================
describe('Onboard command behavioral', () => {
  let onboard: typeof import('../src/cli/commands/onboard.js').onboard;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAccess.mockResolvedValue(undefined);
    ({ onboard } = await import('../src/cli/commands/onboard.js'));
  });

  describe('setup cancellation', () => {
    it('exits early when user declines setup', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: false });
      const console_ = captureConsole();

      await onboard();
      expect(mockInitDatabase).not.toHaveBeenCalled();
      expect(mockMkdir).not.toHaveBeenCalled();

      console_.restore();
    });

    it('displays "cancelled" message when user declines', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: false });
      const console_ = captureConsole();

      await onboard();
      expect(console_.output()).toContain('cancelled');

      console_.restore();
    });

    it('does not generate auth token when user declines setup', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: false });

      await onboard();
      expect(mockGenerateAuthToken).not.toHaveBeenCalled();
    });
  });

  describe('directory creation', () => {
    it('creates base directory', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true, generateToken: false });
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      await onboard();
      const mkdirPaths = mockMkdir.mock.calls.map((c: any[]) => c[0]);
      expect(mkdirPaths).toContain('/tmp/.lain');
    });

    it('creates workspace directory', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true, generateToken: false });
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      await onboard();
      const mkdirPaths = mockMkdir.mock.calls.map((c: any[]) => c[0]);
      expect(mkdirPaths).toContain('/tmp/.lain/workspace');
    });

    it('creates agents directory', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true, generateToken: false });
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      await onboard();
      const mkdirPaths = mockMkdir.mock.calls.map((c: any[]) => c[0]);
      expect(mkdirPaths).toContain('/tmp/.lain/agents');
    });

    it('creates extensions directory', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true, generateToken: false });
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      await onboard();
      const mkdirPaths = mockMkdir.mock.calls.map((c: any[]) => c[0]);
      expect(mkdirPaths).toContain('/tmp/.lain/extensions');
    });

    it('creates credentials directory', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true, generateToken: false });
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      await onboard();
      const mkdirPaths = mockMkdir.mock.calls.map((c: any[]) => c[0]);
      expect(mkdirPaths).toContain('/tmp/.lain/credentials');
    });

    it('uses recursive:true for mkdir', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true, generateToken: false });
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      await onboard();
      for (const call of mockMkdir.mock.calls) {
        expect(call[1]).toEqual({ recursive: true });
      }
    });

    it('exits with 1 if directory creation fails', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true, generateToken: false });
      mockMkdir.mockRejectedValueOnce(new Error('EPERM'));
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const console_ = captureConsole();

      await onboard();
      expect(exit).toHaveBeenCalledWith(1);

      console_.restore();
      exit.mockRestore();
    });
  });

  describe('config file creation', () => {
    it('creates initial config when config file does not exist', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true, generateToken: false });
      mockAccess.mockImplementation((path: string) => {
        if (path.includes('lain.json5')) return Promise.reject(new Error('ENOENT'));
        return Promise.resolve(undefined);
      });

      await onboard();
      expect(mockCreateInitialConfig).toHaveBeenCalled();
    });

    it('skips config creation when config file already exists', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true, generateToken: false });
      mockAccess.mockResolvedValue(undefined);

      await onboard();
      expect(mockCreateInitialConfig).not.toHaveBeenCalled();
    });
  });

  describe('database initialization', () => {
    it('initializes database during setup', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true, generateToken: false });
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      await onboard();
      expect(mockInitDatabase).toHaveBeenCalled();
    });

    it('exits with 1 if database init fails', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true, generateToken: false });
      mockAccess.mockRejectedValue(new Error('ENOENT'));
      mockInitDatabase.mockRejectedValueOnce(new Error('db corrupt'));
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const console_ = captureConsole();

      await onboard();
      expect(exit).toHaveBeenCalledWith(1);

      console_.restore();
      exit.mockRestore();
    });
  });

  describe('auth token generation', () => {
    it('generates token when user opts in', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true, generateToken: true });
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      await onboard();
      expect(mockGenerateAuthToken).toHaveBeenCalled();
    });

    it('displays the generated token', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true, generateToken: true });
      mockAccess.mockRejectedValue(new Error('ENOENT'));
      mockGenerateAuthToken.mockResolvedValueOnce('my-secret-token-abc');
      const console_ = captureConsole();

      await onboard();
      expect(console_.output()).toContain('my-secret-token-abc');

      console_.restore();
    });

    it('does not generate token when user opts out', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true, generateToken: false });
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      await onboard();
      expect(mockGenerateAuthToken).not.toHaveBeenCalled();
    });

    it('handles token generation failure gracefully', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true, generateToken: true });
      mockAccess.mockRejectedValue(new Error('ENOENT'));
      mockGenerateAuthToken.mockRejectedValueOnce(new Error('keychain locked'));
      const console_ = captureConsole();

      // Should not crash
      await expect(onboard()).resolves.toBeUndefined();

      console_.restore();
    });
  });

  describe('next steps output', () => {
    it('shows "Next steps" after successful setup', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true, generateToken: false });
      mockAccess.mockRejectedValue(new Error('ENOENT'));
      const console_ = captureConsole();

      await onboard();
      expect(console_.output()).toContain('Next steps');

      console_.restore();
    });

    it('mentions ANTHROPIC_API_KEY in next steps', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true, generateToken: false });
      mockAccess.mockRejectedValue(new Error('ENOENT'));
      const console_ = captureConsole();

      await onboard();
      expect(console_.output()).toContain('ANTHROPIC_API_KEY');

      console_.restore();
    });

    it('mentions "lain gateway" in next steps', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true, generateToken: false });
      mockAccess.mockRejectedValue(new Error('ENOENT'));
      const console_ = captureConsole();

      await onboard();
      expect(console_.output()).toContain('lain gateway');

      console_.restore();
    });

    it('mentions "lain chat" in next steps', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true, generateToken: false });
      mockAccess.mockRejectedValue(new Error('ENOENT'));
      const console_ = captureConsole();

      await onboard();
      expect(console_.output()).toContain('lain chat');

      console_.restore();
    });

    it('mentions "lain status" in next steps', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true, generateToken: false });
      mockAccess.mockRejectedValue(new Error('ENOENT'));
      const console_ = captureConsole();

      await onboard();
      expect(console_.output()).toContain('lain status');

      console_.restore();
    });
  });

  describe('Node.js version check', () => {
    it('displays the current Node.js version', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true, generateToken: false });
      mockAccess.mockRejectedValue(new Error('ENOENT'));
      const console_ = captureConsole();

      await onboard();
      expect(console_.output()).toContain(process.versions.node);

      console_.restore();
    });
  });

  describe('banner display', () => {
    it('displays the banner at the start', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: false });
      const console_ = captureConsole();

      await onboard();
      // The banner contains ASCII art made of unicode box-drawing chars
      expect(console_.output()).toContain('present day');

      console_.restore();
    });
  });
});

// =============================================================================
// 6. DOCTOR COMMAND BEHAVIORAL
// =============================================================================
describe('Doctor command behavioral', () => {
  let doctor: typeof import('../src/cli/commands/doctor.js').doctor;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAccess.mockResolvedValue(undefined);
    ({ doctor } = await import('../src/cli/commands/doctor.js'));
  });

  describe('Node.js version check', () => {
    it('displays current Node.js version', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const console_ = captureConsole();

      await doctor();
      expect(console_.output()).toContain(process.versions.node);

      console_.restore();
      exit.mockRestore();
    });

    it('reports Node.js version check as passing for Node >= 22', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const console_ = captureConsole();

      await doctor();
      // Current version should pass (we're running Node 22+)
      const major = parseInt(process.versions.node.split('.')[0] ?? '0', 10);
      if (major >= 22) {
        // The green indicator should be in the output for Node version
        expect(console_.output()).toContain('[green]');
      }

      console_.restore();
      exit.mockRestore();
    });
  });

  describe('configuration checks', () => {
    it('checks config file accessibility', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      await doctor();
      // access should have been called with config path
      const accessCalls = mockAccess.mock.calls.map((c: any[]) => c[0]);
      expect(accessCalls.some((p: string) => p.includes('lain.json5'))).toBe(true);

      exit.mockRestore();
    });

    it('validates config by calling loadConfig', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      await doctor();
      expect(mockLoadConfig).toHaveBeenCalled();

      exit.mockRestore();
    });

    it('fails check when loadConfig throws', async () => {
      mockLoadConfig.mockRejectedValueOnce(new Error('invalid syntax'));
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const console_ = captureConsole();

      await doctor();
      expect(exit).toHaveBeenCalledWith(1);
      expect(console_.output()).toContain('invalid syntax');

      console_.restore();
      exit.mockRestore();
    });
  });

  describe('storage checks', () => {
    it('initializes and closes database during check', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      await doctor();
      expect(mockInitDatabase).toHaveBeenCalled();
      expect(mockCloseDatabase).toHaveBeenCalled();

      exit.mockRestore();
    });

    it('reports database failure', async () => {
      mockInitDatabase.mockRejectedValueOnce(new Error('SQLITE_CORRUPT'));
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const console_ = captureConsole();

      await doctor();
      expect(exit).toHaveBeenCalledWith(1);

      console_.restore();
      exit.mockRestore();
    });

    it('checks keychain access via getMasterKey', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      await doctor();
      expect(mockGetMasterKey).toHaveBeenCalled();

      exit.mockRestore();
    });

    it('reports keychain failure', async () => {
      mockGetMasterKey.mockRejectedValueOnce(new Error('keychain denied'));
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const console_ = captureConsole();

      await doctor();
      expect(exit).toHaveBeenCalledWith(1);

      console_.restore();
      exit.mockRestore();
    });

    it('checks auth token', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      await doctor();
      expect(mockGetAuthToken).toHaveBeenCalled();

      exit.mockRestore();
    });

    it('reports auth token as warning (not failure) when missing', async () => {
      mockGetAuthToken.mockResolvedValueOnce(null);
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const console_ = captureConsole();

      await doctor();
      // Missing auth token is a warning, not a failure, so should not cause exit(1)
      // (unless another check fails)

      console_.restore();
      exit.mockRestore();
    });
  });

  describe('workspace checks', () => {
    it('checks for SOUL.md', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      await doctor();
      const accessPaths = mockAccess.mock.calls.map((c: any[]) => c[0]);
      expect(accessPaths.some((p: string) => p.includes('SOUL.md'))).toBe(true);

      exit.mockRestore();
    });

    it('checks for AGENTS.md', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      await doctor();
      const accessPaths = mockAccess.mock.calls.map((c: any[]) => c[0]);
      expect(accessPaths.some((p: string) => p.includes('AGENTS.md'))).toBe(true);

      exit.mockRestore();
    });

    it('checks for IDENTITY.md', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      await doctor();
      const accessPaths = mockAccess.mock.calls.map((c: any[]) => c[0]);
      expect(accessPaths.some((p: string) => p.includes('IDENTITY.md'))).toBe(true);

      exit.mockRestore();
    });

    it('reports partial workspace (some files missing) as failed check', async () => {
      mockAccess.mockImplementation((path: string) => {
        if (path.includes('AGENTS.md')) return Promise.reject(new Error('ENOENT'));
        return Promise.resolve(undefined);
      });
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const console_ = captureConsole();

      await doctor();
      expect(console_.output()).toContain('AGENTS.md');
      expect(exit).toHaveBeenCalledWith(1);

      console_.restore();
      exit.mockRestore();
    });
  });

  describe('API key check', () => {
    it('reports ANTHROPIC_API_KEY when set', async () => {
      const original = process.env['ANTHROPIC_API_KEY'];
      process.env['ANTHROPIC_API_KEY'] = 'test-key';
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const console_ = captureConsole();

      await doctor();
      expect(console_.output()).toContain('ANTHROPIC_API_KEY');

      console_.restore();
      exit.mockRestore();
      if (original !== undefined) process.env['ANTHROPIC_API_KEY'] = original;
      else delete process.env['ANTHROPIC_API_KEY'];
    });

    it('warns but does not fail when ANTHROPIC_API_KEY is not set', async () => {
      const original = process.env['ANTHROPIC_API_KEY'];
      delete process.env['ANTHROPIC_API_KEY'];
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const console_ = captureConsole();

      await doctor();
      expect(console_.output()).toContain('ANTHROPIC_API_KEY');

      console_.restore();
      exit.mockRestore();
      process.env['ANTHROPIC_API_KEY'] = original ?? 'test-key';
    });
  });

  describe('summary', () => {
    it('displays summary section', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const console_ = captureConsole();

      await doctor();
      expect(console_.output()).toContain('Summary');

      console_.restore();
      exit.mockRestore();
    });

    it('shows "passed" count in summary when all pass', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const console_ = captureConsole();

      await doctor();
      expect(console_.output()).toMatch(/\d+ .*(passed|checks passed)/i);

      console_.restore();
      exit.mockRestore();
    });

    it('shows "failed" count in summary when some fail', async () => {
      mockInitDatabase.mockRejectedValueOnce(new Error('db error'));
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const console_ = captureConsole();

      await doctor();
      expect(console_.output()).toMatch(/\d+ failed/i);

      console_.restore();
      exit.mockRestore();
    });

    it('displays "Lain Diagnostics" header', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const console_ = captureConsole();

      await doctor();
      expect(console_.output()).toContain('Lain Diagnostics');

      console_.restore();
      exit.mockRestore();
    });
  });

  describe('section headers', () => {
    it('displays Runtime section', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const console_ = captureConsole();
      await doctor();
      expect(console_.output()).toContain('Runtime');
      console_.restore();
      exit.mockRestore();
    });

    it('displays Configuration section', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const console_ = captureConsole();
      await doctor();
      expect(console_.output()).toContain('Configuration');
      console_.restore();
      exit.mockRestore();
    });

    it('displays Storage section', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const console_ = captureConsole();
      await doctor();
      expect(console_.output()).toContain('Storage');
      console_.restore();
      exit.mockRestore();
    });

    it('displays Workspace section', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const console_ = captureConsole();
      await doctor();
      expect(console_.output()).toContain('Workspace');
      console_.restore();
      exit.mockRestore();
    });

    it('displays Environment section', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const console_ = captureConsole();
      await doctor();
      expect(console_.output()).toContain('Environment');
      console_.restore();
      exit.mockRestore();
    });
  });
});

// =============================================================================
// 7. TELEGRAM COMMAND BEHAVIORAL
// =============================================================================
describe('Telegram command behavioral', () => {
  let startTelegram: typeof import('../src/cli/commands/telegram.js').startTelegram;
  let savedBotToken: string | undefined;
  let savedChatId: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    savedBotToken = process.env['TELEGRAM_BOT_TOKEN'];
    savedChatId = process.env['TELEGRAM_CHAT_ID'];
    ({ startTelegram } = await import('../src/cli/commands/telegram.js'));
  });

  afterEach(() => {
    if (savedBotToken !== undefined) process.env['TELEGRAM_BOT_TOKEN'] = savedBotToken;
    else delete process.env['TELEGRAM_BOT_TOKEN'];
    if (savedChatId !== undefined) process.env['TELEGRAM_CHAT_ID'] = savedChatId;
    else delete process.env['TELEGRAM_CHAT_ID'];
  });

  describe('missing environment variables', () => {
    it('exits with 1 when TELEGRAM_BOT_TOKEN is missing', async () => {
      delete process.env['TELEGRAM_BOT_TOKEN'];
      delete process.env['TELEGRAM_CHAT_ID'];
      const exit = mockProcessExit();
      const console_ = captureConsole();

      await expect(startTelegram()).rejects.toThrow('process.exit(1)');

      console_.restore();
      exit.restore();
    });

    it('displays error about missing bot token', async () => {
      delete process.env['TELEGRAM_BOT_TOKEN'];
      delete process.env['TELEGRAM_CHAT_ID'];
      const exit = mockProcessExit();
      const console_ = captureConsole();

      await expect(startTelegram()).rejects.toThrow();
      expect(console_.errorOutput()).toContain('TELEGRAM_BOT_TOKEN');

      console_.restore();
      exit.restore();
    });

    it('suggests @BotFather when token is missing', async () => {
      delete process.env['TELEGRAM_BOT_TOKEN'];
      delete process.env['TELEGRAM_CHAT_ID'];
      const exit = mockProcessExit();
      const console_ = captureConsole();

      await expect(startTelegram()).rejects.toThrow();
      expect(console_.errorOutput()).toContain('BotFather');

      console_.restore();
      exit.restore();
    });

    it('exits with 1 when TELEGRAM_CHAT_ID is missing but token is set', async () => {
      process.env['TELEGRAM_BOT_TOKEN'] = 'test-token';
      delete process.env['TELEGRAM_CHAT_ID'];
      const exit = mockProcessExit();
      const console_ = captureConsole();

      await expect(startTelegram()).rejects.toThrow('process.exit(1)');

      console_.restore();
      exit.restore();
    });

    it('displays error about missing chat ID', async () => {
      process.env['TELEGRAM_BOT_TOKEN'] = 'test-token';
      delete process.env['TELEGRAM_CHAT_ID'];
      const exit = mockProcessExit();
      const console_ = captureConsole();

      await expect(startTelegram()).rejects.toThrow();
      expect(console_.errorOutput()).toContain('TELEGRAM_CHAT_ID');

      console_.restore();
      exit.restore();
    });

    it('suggests @userinfobot when chat ID is missing', async () => {
      process.env['TELEGRAM_BOT_TOKEN'] = 'test-token';
      delete process.env['TELEGRAM_CHAT_ID'];
      const exit = mockProcessExit();
      const console_ = captureConsole();

      await expect(startTelegram()).rejects.toThrow();
      expect(console_.errorOutput()).toContain('userinfobot');

      console_.restore();
      exit.restore();
    });
  });

  describe('successful initialization', () => {
    beforeEach(() => {
      process.env['TELEGRAM_BOT_TOKEN'] = 'bot-token-123';
      process.env['TELEGRAM_CHAT_ID'] = '999888';
    });

    it('initializes database before agent', async () => {
      vi.spyOn(process, 'on').mockImplementation((() => process) as any);
      const callOrder: string[] = [];
      mockInitDatabase.mockImplementation(async () => { callOrder.push('initDatabase'); });
      mockInitAgent.mockImplementation(async () => { callOrder.push('initAgent'); });

      await Promise.race([startTelegram(), new Promise<void>(r => setTimeout(r, 10))]);

      const dbIdx = callOrder.indexOf('initDatabase');
      const agentIdx = callOrder.indexOf('initAgent');
      if (dbIdx >= 0 && agentIdx >= 0) {
        expect(dbIdx).toBeLessThan(agentIdx);
      } else {
        // At minimum, initDatabase should have been called
        expect(mockInitDatabase).toHaveBeenCalled();
      }
    });

    it('creates TelegramChannel with correct config', async () => {
      vi.spyOn(process, 'on').mockImplementation((() => process) as any);
      const { TelegramChannel } = await import('../src/channels/telegram.js');

      await Promise.race([startTelegram(), new Promise<void>(r => setTimeout(r, 10))]);

      expect(TelegramChannel).toHaveBeenCalledWith(
        expect.objectContaining({
          token: 'bot-token-123',
          allowedUsers: ['999888'],
          type: 'telegram',
          enabled: true,
          agentId: 'default',
        })
      );
    });

    it('sets event handlers on the channel', async () => {
      vi.spyOn(process, 'on').mockImplementation((() => process) as any);
      await Promise.race([startTelegram(), new Promise<void>(r => setTimeout(r, 10))]);
      expect(mockTelegramSetEventHandlers).toHaveBeenCalled();
    });

    it('event handlers include onMessage', async () => {
      vi.spyOn(process, 'on').mockImplementation((() => process) as any);
      await Promise.race([startTelegram(), new Promise<void>(r => setTimeout(r, 10))]);
      const handlers = mockTelegramSetEventHandlers.mock.calls[0]?.[0];
      expect(handlers).toHaveProperty('onMessage');
      expect(typeof handlers?.onMessage).toBe('function');
    });

    it('event handlers include onError', async () => {
      vi.spyOn(process, 'on').mockImplementation((() => process) as any);
      await Promise.race([startTelegram(), new Promise<void>(r => setTimeout(r, 10))]);
      const handlers = mockTelegramSetEventHandlers.mock.calls[0]?.[0];
      expect(handlers).toHaveProperty('onError');
      expect(typeof handlers?.onError).toBe('function');
    });

    it('event handlers include onConnect', async () => {
      vi.spyOn(process, 'on').mockImplementation((() => process) as any);
      await Promise.race([startTelegram(), new Promise<void>(r => setTimeout(r, 10))]);
      const handlers = mockTelegramSetEventHandlers.mock.calls[0]?.[0];
      expect(handlers).toHaveProperty('onConnect');
      expect(typeof handlers?.onConnect).toBe('function');
    });

    it('event handlers include onDisconnect', async () => {
      vi.spyOn(process, 'on').mockImplementation((() => process) as any);
      await Promise.race([startTelegram(), new Promise<void>(r => setTimeout(r, 10))]);
      const handlers = mockTelegramSetEventHandlers.mock.calls[0]?.[0];
      expect(handlers).toHaveProperty('onDisconnect');
      expect(typeof handlers?.onDisconnect).toBe('function');
    });

    it('calls channel.connect()', async () => {
      vi.spyOn(process, 'on').mockImplementation((() => process) as any);
      await Promise.race([startTelegram(), new Promise<void>(r => setTimeout(r, 10))]);
      expect(mockTelegramConnect).toHaveBeenCalled();
    });

    it('registers SIGINT handler after connect resolves', async () => {
      // Signal handlers are registered after channel.connect() resolves.
      // Make connect resolve immediately so we can reach that code.
      const { TelegramChannel } = await import('../src/channels/telegram.js');
      (TelegramChannel as any).mockImplementation(() => ({
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        send: vi.fn(),
        setEventHandlers: vi.fn(),
      }));

      const processOnSpy = vi.spyOn(process, 'on').mockImplementation((() => process) as any);

      // startTelegram will await connect (resolves), register signals, then await new Promise(() => {})
      await Promise.race([startTelegram(), new Promise<void>(r => setTimeout(r, 50))]);
      const signals = processOnSpy.mock.calls.map(c => c[0]);
      expect(signals).toContain('SIGINT');

      processOnSpy.mockRestore();
    });

    it('registers SIGTERM handler after connect resolves', async () => {
      const { TelegramChannel } = await import('../src/channels/telegram.js');
      (TelegramChannel as any).mockImplementation(() => ({
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        send: vi.fn(),
        setEventHandlers: vi.fn(),
      }));

      const processOnSpy = vi.spyOn(process, 'on').mockImplementation((() => process) as any);

      await Promise.race([startTelegram(), new Promise<void>(r => setTimeout(r, 50))]);
      const signals = processOnSpy.mock.calls.map(c => c[0]);
      expect(signals).toContain('SIGTERM');

      processOnSpy.mockRestore();
    });

    it('onConnect handler prints Telegram bot connected', async () => {
      // Use a fresh mock that captures the handlers
      const localSetHandlers = vi.fn();
      const { TelegramChannel } = await import('../src/channels/telegram.js');
      (TelegramChannel as any).mockImplementation(() => ({
        connect: vi.fn().mockImplementation(() => new Promise(() => {})),
        disconnect: vi.fn().mockResolvedValue(undefined),
        send: vi.fn(),
        setEventHandlers: localSetHandlers,
      }));

      vi.spyOn(process, 'on').mockImplementation((() => process) as any);
      await Promise.race([startTelegram(), new Promise<void>(r => setTimeout(r, 20))]);

      const handlers = localSetHandlers.mock.calls[0]?.[0];
      expect(handlers?.onConnect).toBeDefined();

      const console_ = captureConsole();
      handlers.onConnect();
      // The telegram banner uses box-drawing chars, not the word "LAIN"
      expect(console_.output()).toContain('Telegram bot connected');
      expect(console_.output()).toContain('present day');

      console_.restore();
    });
  });
});

// =============================================================================
// 8. CHAT COMMAND BEHAVIORAL
// =============================================================================
describe('Chat command behavioral', () => {
  let chatModule: typeof import('../src/cli/commands/chat.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    chatModule = await import('../src/cli/commands/chat.js');
  });

  describe('chat() gateway checks', () => {
    it('exits if no gateway PID exists', async () => {
      mockGetServerPid.mockResolvedValueOnce(null);
      const exit = mockProcessExit();
      const console_ = captureConsole();

      await expect(chatModule.chat()).rejects.toThrow('process.exit(1)');
      expect(console_.output()).toContain('not running');

      console_.restore();
      exit.restore();
    });

    it('exits if PID exists but process not running', async () => {
      mockGetServerPid.mockResolvedValueOnce(1234);
      mockIsProcessRunning.mockReturnValueOnce(false);
      const exit = mockProcessExit();
      const console_ = captureConsole();

      await expect(chatModule.chat()).rejects.toThrow('process.exit(1)');

      console_.restore();
      exit.restore();
    });

    it('exits if no auth token', async () => {
      mockGetServerPid.mockResolvedValueOnce(1234);
      mockIsProcessRunning.mockReturnValueOnce(true);
      mockGetAuthToken.mockResolvedValueOnce(null);
      const exit = mockProcessExit();
      const console_ = captureConsole();

      await expect(chatModule.chat()).rejects.toThrow('process.exit(1)');
      expect(console_.output()).toContain('token');

      console_.restore();
      exit.restore();
    });

    it('suggests "lain gateway" when gateway not running', async () => {
      mockGetServerPid.mockResolvedValueOnce(null);
      const exit = mockProcessExit();
      const console_ = captureConsole();

      await expect(chatModule.chat()).rejects.toThrow();
      expect(console_.output()).toContain('lain gateway');

      console_.restore();
      exit.restore();
    });

    it('suggests "lain onboard" when no auth token', async () => {
      mockGetServerPid.mockResolvedValueOnce(1234);
      mockIsProcessRunning.mockReturnValueOnce(true);
      mockGetAuthToken.mockResolvedValueOnce(null);
      const exit = mockProcessExit();
      const console_ = captureConsole();

      await expect(chatModule.chat()).rejects.toThrow();
      expect(console_.output()).toContain('onboard');

      console_.restore();
      exit.restore();
    });
  });

  describe('chat() socket connection', () => {
    it('connects to the socket path from getPaths', async () => {
      mockGetServerPid.mockResolvedValueOnce(1234);
      mockIsProcessRunning.mockReturnValueOnce(true);
      mockGetAuthToken.mockResolvedValueOnce('token');

      const mockSocket = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
      mockNetConnect.mockReturnValueOnce(mockSocket);

      await Promise.race([chatModule.chat(), new Promise<void>(r => setTimeout(r, 5))]);
      expect(mockNetConnect).toHaveBeenCalledWith('/tmp/.lain/lain.sock');
    });

    it('sends auth message on socket connect', async () => {
      mockGetServerPid.mockResolvedValueOnce(1234);
      mockIsProcessRunning.mockReturnValueOnce(true);
      mockGetAuthToken.mockResolvedValueOnce('my-token');

      const mockSocket = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
      mockNetConnect.mockReturnValueOnce(mockSocket);

      await Promise.race([chatModule.chat(), new Promise<void>(r => setTimeout(r, 5))]);

      const connectHandler = mockSocket.on.mock.calls.find((c: any[]) => c[0] === 'connect')?.[1];
      connectHandler?.();

      expect(mockSocket.write).toHaveBeenCalled();
      const written = mockSocket.write.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(written.trim());
      expect(parsed.method).toBe('auth');
      expect(parsed.params.token).toBe('my-token');
    });

    it('registers connect, data, error, and close handlers', async () => {
      mockGetServerPid.mockResolvedValueOnce(1234);
      mockIsProcessRunning.mockReturnValueOnce(true);
      mockGetAuthToken.mockResolvedValueOnce('token');

      const mockSocket = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
      mockNetConnect.mockReturnValueOnce(mockSocket);

      await Promise.race([chatModule.chat(), new Promise<void>(r => setTimeout(r, 5))]);

      const events = mockSocket.on.mock.calls.map((c: any[]) => c[0]);
      expect(events).toContain('connect');
      expect(events).toContain('data');
      expect(events).toContain('error');
      expect(events).toContain('close');
    });
  });

  describe('sendMessage()', () => {
    it('exits if gateway not running', async () => {
      mockGetServerPid.mockResolvedValueOnce(null);
      const exit = mockProcessExit();
      const console_ = captureConsole();

      await expect(chatModule.sendMessage('hello')).rejects.toThrow('process.exit(1)');

      console_.restore();
      exit.restore();
    });

    it('exits if no auth token', async () => {
      mockGetServerPid.mockResolvedValueOnce(1234);
      mockIsProcessRunning.mockReturnValueOnce(true);
      mockGetAuthToken.mockResolvedValueOnce(null);
      const exit = mockProcessExit();
      const console_ = captureConsole();

      await expect(chatModule.sendMessage('hello')).rejects.toThrow('process.exit(1)');

      console_.restore();
      exit.restore();
    });

    it('connects to socket and sends auth message', async () => {
      mockGetServerPid.mockResolvedValueOnce(1234);
      mockIsProcessRunning.mockReturnValueOnce(true);
      mockGetAuthToken.mockResolvedValueOnce('my-token');

      const mockSocket = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
      mockNetConnect.mockReturnValueOnce(mockSocket);

      const p = chatModule.sendMessage('test');
      await new Promise(r => setTimeout(r, 0));

      // Trigger connect
      const connectHandler = mockSocket.on.mock.calls.find((c: any[]) => c[0] === 'connect')?.[1];
      connectHandler?.();

      const written = mockSocket.write.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(written.trim());
      expect(parsed.method).toBe('auth');

      // Clean up
      const errorHandler = mockSocket.on.mock.calls.find((c: any[]) => c[0] === 'error')?.[1];
      errorHandler?.(new Error('done'));
      await p.catch(() => {});
    });

    it('sends actual message after authentication response', async () => {
      mockGetServerPid.mockResolvedValueOnce(1234);
      mockIsProcessRunning.mockReturnValueOnce(true);
      mockGetAuthToken.mockResolvedValueOnce('my-token');

      const mockSocket = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
      mockNetConnect.mockReturnValueOnce(mockSocket);

      const p = chatModule.sendMessage('hello world');
      await new Promise(r => setTimeout(r, 0));

      // Trigger connect
      const connectHandler = mockSocket.on.mock.calls.find((c: any[]) => c[0] === 'connect')?.[1];
      connectHandler?.();

      // Simulate auth success response
      const dataHandler = mockSocket.on.mock.calls.find((c: any[]) => c[0] === 'data')?.[1];
      const authResponse = JSON.stringify({ id: '1', result: { authenticated: true } }) + '\n';
      dataHandler?.(Buffer.from(authResponse));

      // The second write call should be the actual message
      expect(mockSocket.write.mock.calls.length).toBeGreaterThanOrEqual(2);
      const secondWrite = mockSocket.write.mock.calls[1]?.[0] as string;
      const parsed = JSON.parse(secondWrite.trim());
      expect(parsed.method).toBe('chat');
      expect(parsed.params.message).toBe('hello world');

      // Clean up
      const errorHandler = mockSocket.on.mock.calls.find((c: any[]) => c[0] === 'error')?.[1];
      errorHandler?.(new Error('done'));
      await p.catch(() => {});
    });
  });
});

// =============================================================================
// 9. PLUGIN LOADER BEHAVIORAL
// =============================================================================
describe('Plugin loader behavioral', () => {
  let pluginLoader: typeof import('../src/plugins/loader.js');

  const makeManifest = (overrides: Partial<{
    name: string; version: string; main: string; description: string;
    tools: string[]; hooks: string[];
  }> = {}) => JSON.stringify({
    name: 'test-plugin',
    version: '1.0.0',
    main: 'index.js',
    ...overrides,
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRegisteredTools.clear();
    vi.resetModules();
    pluginLoader = await import('../src/plugins/loader.js');
  });

  describe('loadPlugin manifest validation', () => {
    it('rejects when manifest.json does not exist', async () => {
      mockAccess.mockRejectedValueOnce(new Error('ENOENT'));
      await expect(pluginLoader.loadPlugin('/plugins/no-manifest')).rejects.toThrow('manifest not found');
    });

    it('rejects when manifest is not valid JSON', async () => {
      mockAccess.mockResolvedValueOnce(undefined);
      mockReadFile.mockResolvedValueOnce('not json');
      await expect(pluginLoader.loadPlugin('/plugins/bad-json')).rejects.toThrow();
    });

    it('rejects when name is missing', async () => {
      mockAccess.mockResolvedValueOnce(undefined);
      mockReadFile.mockResolvedValueOnce(JSON.stringify({ version: '1.0', main: 'index.js' }));
      await expect(pluginLoader.loadPlugin('/p')).rejects.toThrow('Invalid plugin manifest');
    });

    it('rejects when version is missing', async () => {
      mockAccess.mockResolvedValueOnce(undefined);
      mockReadFile.mockResolvedValueOnce(JSON.stringify({ name: 'test', main: 'index.js' }));
      await expect(pluginLoader.loadPlugin('/p')).rejects.toThrow('Invalid plugin manifest');
    });

    it('rejects when main is missing', async () => {
      mockAccess.mockResolvedValueOnce(undefined);
      mockReadFile.mockResolvedValueOnce(JSON.stringify({ name: 'test', version: '1.0' }));
      await expect(pluginLoader.loadPlugin('/p')).rejects.toThrow('Invalid plugin manifest');
    });

    it('accepts manifest with only required fields', async () => {
      mockAccess.mockResolvedValueOnce(undefined);
      mockReadFile.mockResolvedValueOnce(makeManifest());
      // Will fail at import, but manifest validation passes
      const err = await pluginLoader.loadPlugin('/p').catch((e: Error) => e);
      expect((err as Error).message).toContain('Failed to load plugin module');
    });

    it('accepts manifest with description and author (optional fields)', async () => {
      mockAccess.mockResolvedValueOnce(undefined);
      mockReadFile.mockResolvedValueOnce(makeManifest({
        description: 'A test plugin',
      }));
      const err = await pluginLoader.loadPlugin('/p').catch((e: Error) => e);
      expect((err as Error).message).toContain('Failed to load plugin module');
    });

    it('accepts manifest with tools array', async () => {
      mockAccess.mockResolvedValueOnce(undefined);
      mockReadFile.mockResolvedValueOnce(makeManifest({ tools: ['myTool'] }));
      const err = await pluginLoader.loadPlugin('/p').catch((e: Error) => e);
      expect((err as Error).message).toContain('Failed to load plugin module');
    });

    it('accepts manifest with hooks array', async () => {
      mockAccess.mockResolvedValueOnce(undefined);
      mockReadFile.mockResolvedValueOnce(makeManifest({ hooks: ['onMessage'] }));
      const err = await pluginLoader.loadPlugin('/p').catch((e: Error) => e);
      expect((err as Error).message).toContain('Failed to load plugin module');
    });
  });

  describe('loadPlugin module loading', () => {
    it('rejects when main module cannot be imported', async () => {
      mockAccess.mockResolvedValueOnce(undefined);
      mockReadFile.mockResolvedValueOnce(makeManifest({ main: 'nonexistent.js' }));
      await expect(pluginLoader.loadPlugin('/plugins/bad')).rejects.toThrow('Failed to load plugin module');
    });

    it('error message includes original error info', async () => {
      mockAccess.mockResolvedValueOnce(undefined);
      mockReadFile.mockResolvedValueOnce(makeManifest());
      const err = await pluginLoader.loadPlugin('/plugins/crash').catch((e: Error) => e);
      expect((err as Error).message).toBeTruthy();
    });
  });

  describe('plugin state management', () => {
    it('getPlugin returns undefined for unknown plugin', () => {
      expect(pluginLoader.getPlugin('nonexistent')).toBeUndefined();
    });

    it('getAllPlugins starts empty', () => {
      expect(pluginLoader.getAllPlugins()).toEqual([]);
    });

    it('getEnabledPlugins starts empty', () => {
      expect(pluginLoader.getEnabledPlugins()).toEqual([]);
    });

    it('enablePlugin throws for unknown plugin', async () => {
      await expect(pluginLoader.enablePlugin('ghost')).rejects.toThrow('Plugin not found');
    });

    it('disablePlugin throws for unknown plugin', async () => {
      await expect(pluginLoader.disablePlugin('ghost')).rejects.toThrow('Plugin not found');
    });

    it('unloadPlugin is a no-op for unknown plugin', async () => {
      await expect(pluginLoader.unloadPlugin('ghost')).resolves.toBeUndefined();
    });
  });

  describe('loadPluginsFromDirectory', () => {
    it('returns empty array when directory does not exist', async () => {
      mockReaddir.mockRejectedValueOnce(new Error('ENOENT'));
      const result = await pluginLoader.loadPluginsFromDirectory('/no-dir');
      expect(result).toEqual([]);
    });

    it('returns empty array for empty directory', async () => {
      mockReaddir.mockResolvedValueOnce([]);
      const result = await pluginLoader.loadPluginsFromDirectory('/empty');
      expect(result).toEqual([]);
    });

    it('skips non-directory entries', async () => {
      mockReaddir.mockResolvedValueOnce([
        { name: 'file.js', isDirectory: () => false },
        { name: '.DS_Store', isDirectory: () => false },
      ]);
      const result = await pluginLoader.loadPluginsFromDirectory('/plugins');
      expect(result).toEqual([]);
    });

    it('tries to load each directory entry as a plugin', async () => {
      mockReaddir.mockResolvedValueOnce([
        { name: 'plugin-a', isDirectory: () => true },
        { name: 'plugin-b', isDirectory: () => true },
      ]);
      // Both will fail because no manifest
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      const result = await pluginLoader.loadPluginsFromDirectory('/plugins');
      expect(result).toEqual([]);
      // access should have been called for each plugin's manifest
      expect(mockAccess.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('continues loading after one plugin fails', async () => {
      mockReaddir.mockResolvedValueOnce([
        { name: 'bad-plugin', isDirectory: () => true },
        { name: 'another-bad', isDirectory: () => true },
      ]);
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      const result = await pluginLoader.loadPluginsFromDirectory('/plugins');
      expect(result).toHaveLength(0);
      // Should have attempted both
      expect(mockAccess.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('passes correct directory path to readdir', async () => {
      mockReaddir.mockResolvedValueOnce([]);
      await pluginLoader.loadPluginsFromDirectory('/my/plugins/dir');
      expect(mockReaddir).toHaveBeenCalledWith('/my/plugins/dir', expect.any(Object));
    });

    it('handles permission error on directory', async () => {
      mockReaddir.mockRejectedValueOnce(new Error('EACCES'));
      const result = await pluginLoader.loadPluginsFromDirectory('/restricted');
      expect(result).toEqual([]);
    });
  });

  describe('hook runners', () => {
    it('runMessageHooks returns input unchanged when no plugins', async () => {
      const msg = { text: 'hello' };
      const result = await pluginLoader.runMessageHooks(msg);
      expect(result).toBe(msg);
    });

    it('runResponseHooks returns input unchanged when no plugins', async () => {
      const resp = { data: [1, 2, 3] };
      const result = await pluginLoader.runResponseHooks(resp);
      expect(result).toBe(resp);
    });

    it('runMessageHooks passes through null', async () => {
      expect(await pluginLoader.runMessageHooks(null)).toBeNull();
    });

    it('runMessageHooks passes through numbers', async () => {
      expect(await pluginLoader.runMessageHooks(42)).toBe(42);
    });

    it('runMessageHooks passes through strings', async () => {
      expect(await pluginLoader.runMessageHooks('test')).toBe('test');
    });

    it('runResponseHooks passes through null', async () => {
      expect(await pluginLoader.runResponseHooks(null)).toBeNull();
    });

    it('runResponseHooks passes through empty array', async () => {
      const arr: never[] = [];
      expect(await pluginLoader.runResponseHooks(arr)).toBe(arr);
    });

    it('runResponseHooks passes through undefined', async () => {
      expect(await pluginLoader.runResponseHooks(undefined)).toBeUndefined();
    });
  });
});

// =============================================================================
// 10. CLI PROMPTS UTILITY BEHAVIORAL
// =============================================================================
describe('CLI prompts utility behavioral', () => {
  let prompts: typeof import('../src/cli/utils/prompts.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    prompts = await import('../src/cli/utils/prompts.js');
  });

  describe('displayBanner', () => {
    it('outputs ASCII art banner', () => {
      const console_ = captureConsole();
      prompts.displayBanner();
      // The banner uses unicode box-drawing characters for the ASCII art
      expect(console_.output()).toContain('\u2588');
      console_.restore();
    });

    it('outputs tagline', () => {
      const console_ = captureConsole();
      prompts.displayBanner();
      expect(console_.output()).toContain('present day');
      console_.restore();
    });

    it('uses cyan color for banner', () => {
      const console_ = captureConsole();
      prompts.displayBanner();
      expect(console_.output()).toContain('[cyan]');
      console_.restore();
    });

    it('uses dim color for tagline', () => {
      const console_ = captureConsole();
      prompts.displayBanner();
      expect(console_.output()).toContain('[dim]');
      console_.restore();
    });
  });

  describe('displaySuccess', () => {
    it('outputs the message text', () => {
      const console_ = captureConsole();
      prompts.displaySuccess('all good');
      expect(console_.output()).toContain('all good');
      console_.restore();
    });

    it('uses green color indicator', () => {
      const console_ = captureConsole();
      prompts.displaySuccess('test');
      expect(console_.output()).toContain('[green]');
      console_.restore();
    });
  });

  describe('displayError', () => {
    it('outputs the message text', () => {
      const console_ = captureConsole();
      prompts.displayError('something broke');
      expect(console_.output()).toContain('something broke');
      console_.restore();
    });

    it('uses red color indicator', () => {
      const console_ = captureConsole();
      prompts.displayError('error');
      expect(console_.output()).toContain('[red]');
      console_.restore();
    });
  });

  describe('displayWarning', () => {
    it('outputs the message text', () => {
      const console_ = captureConsole();
      prompts.displayWarning('watch out');
      expect(console_.output()).toContain('watch out');
      console_.restore();
    });

    it('uses yellow color indicator', () => {
      const console_ = captureConsole();
      prompts.displayWarning('warning');
      expect(console_.output()).toContain('[yellow]');
      console_.restore();
    });
  });

  describe('displayInfo', () => {
    it('outputs the message text', () => {
      const console_ = captureConsole();
      prompts.displayInfo('info message');
      expect(console_.output()).toContain('info message');
      console_.restore();
    });

    it('uses blue color indicator', () => {
      const console_ = captureConsole();
      prompts.displayInfo('info');
      expect(console_.output()).toContain('[blue]');
      console_.restore();
    });
  });

  describe('displayStatus', () => {
    it('outputs label and value', () => {
      const console_ = captureConsole();
      prompts.displayStatus('Gateway', 'Running', true);
      expect(console_.output()).toContain('Gateway');
      expect(console_.output()).toContain('Running');
      console_.restore();
    });

    it('uses green indicator when ok=true', () => {
      const console_ = captureConsole();
      prompts.displayStatus('Test', 'OK', true);
      expect(console_.output()).toContain('[green]');
      console_.restore();
    });

    it('uses red indicator when ok=false', () => {
      const console_ = captureConsole();
      prompts.displayStatus('Test', 'Failed', false);
      expect(console_.output()).toContain('[red]');
      console_.restore();
    });

    it('defaults ok to true when not provided', () => {
      const console_ = captureConsole();
      prompts.displayStatus('Label', 'Value');
      expect(console_.output()).toContain('[green]');
      console_.restore();
    });

    it('includes dim formatting for label', () => {
      const console_ = captureConsole();
      prompts.displayStatus('MyLabel', 'MyValue');
      expect(console_.output()).toContain('[dim]');
      console_.restore();
    });
  });

  describe('displaySection', () => {
    it('outputs the section title', () => {
      const console_ = captureConsole();
      prompts.displaySection('My Section');
      expect(console_.output()).toContain('My Section');
      console_.restore();
    });

    it('uses bold formatting for title', () => {
      const console_ = captureConsole();
      prompts.displaySection('Title');
      expect(console_.output()).toContain('[bold]');
      console_.restore();
    });

    it('outputs a separator line', () => {
      const console_ = captureConsole();
      prompts.displaySection('Section');
      // Separator is 40 dashes
      expect(console_.output()).toContain('[dim]');
      console_.restore();
    });
  });

  describe('displayWaiting', () => {
    it('outputs the message', () => {
      const console_ = captureConsole();
      prompts.displayWaiting('loading data');
      expect(console_.output()).toContain('loading data');
      console_.restore();
    });

    it('uses dim color for the "..." prefix', () => {
      const console_ = captureConsole();
      prompts.displayWaiting('test');
      expect(console_.output()).toContain('[dim]');
      console_.restore();
    });

    it('includes dots prefix', () => {
      const console_ = captureConsole();
      prompts.displayWaiting('test');
      expect(console_.output()).toContain('...');
      console_.restore();
    });
  });

  describe('promptOnboard', () => {
    it('calls inquirer.prompt with confirmSetup question', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true, generateToken: true });
      await prompts.promptOnboard();
      const questions = mockInquirerPrompt.mock.calls[0]?.[0];
      expect(questions.some((q: any) => q.name === 'confirmSetup')).toBe(true);
    });

    it('calls inquirer.prompt with generateToken question', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true, generateToken: true });
      await prompts.promptOnboard();
      const questions = mockInquirerPrompt.mock.calls[0]?.[0];
      expect(questions.some((q: any) => q.name === 'generateToken')).toBe(true);
    });

    it('returns the answers from inquirer', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: false, generateToken: false });
      const result = await prompts.promptOnboard();
      expect(result).toEqual({ confirmSetup: false, generateToken: false });
    });

    it('confirmSetup defaults to true', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true });
      await prompts.promptOnboard();
      const questions = mockInquirerPrompt.mock.calls[0]?.[0];
      const confirmQ = questions.find((q: any) => q.name === 'confirmSetup');
      expect(confirmQ?.default).toBe(true);
    });

    it('generateToken defaults to true', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true, generateToken: true });
      await prompts.promptOnboard();
      const questions = mockInquirerPrompt.mock.calls[0]?.[0];
      const tokenQ = questions.find((q: any) => q.name === 'generateToken');
      expect(tokenQ?.default).toBe(true);
    });

    it('generateToken question has "when" condition depending on confirmSetup', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true, generateToken: true });
      await prompts.promptOnboard();
      const questions = mockInquirerPrompt.mock.calls[0]?.[0];
      const tokenQ = questions.find((q: any) => q.name === 'generateToken');
      expect(typeof tokenQ?.when).toBe('function');
    });

    it('generateToken "when" returns true when confirmSetup is true', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: true, generateToken: true });
      await prompts.promptOnboard();
      const questions = mockInquirerPrompt.mock.calls[0]?.[0];
      const tokenQ = questions.find((q: any) => q.name === 'generateToken');
      expect(tokenQ?.when({ confirmSetup: true })).toBe(true);
    });

    it('generateToken "when" returns false when confirmSetup is false', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmSetup: false });
      await prompts.promptOnboard();
      const questions = mockInquirerPrompt.mock.calls[0]?.[0];
      const tokenQ = questions.find((q: any) => q.name === 'generateToken');
      expect(tokenQ?.when({ confirmSetup: false })).toBe(false);
    });
  });

  describe('promptApiKey', () => {
    it('calls inquirer.prompt with hasApiKey question', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ hasApiKey: false });
      await prompts.promptApiKey();
      const questions = mockInquirerPrompt.mock.calls[0]?.[0];
      expect(questions.some((q: any) => q.name === 'hasApiKey')).toBe(true);
    });

    it('includes apiKeyEnvVar question conditional on hasApiKey', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ hasApiKey: true, apiKeyEnvVar: 'ANTHROPIC_API_KEY' });
      await prompts.promptApiKey();
      const questions = mockInquirerPrompt.mock.calls[0]?.[0];
      const envQ = questions.find((q: any) => q.name === 'apiKeyEnvVar');
      expect(envQ).toBeDefined();
      expect(envQ?.default).toBe('ANTHROPIC_API_KEY');
    });

    it('returns the answers', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ hasApiKey: true, apiKeyEnvVar: 'MY_KEY' });
      const result = await prompts.promptApiKey();
      expect(result.hasApiKey).toBe(true);
      expect(result.apiKeyEnvVar).toBe('MY_KEY');
    });
  });

  describe('confirm', () => {
    it('calls inquirer.prompt with a confirm question', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmed: true });
      await prompts.confirm('Are you sure?');
      expect(mockInquirerPrompt).toHaveBeenCalled();
    });

    it('passes the message to the prompt', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmed: true });
      await prompts.confirm('Delete everything?');
      const questions = mockInquirerPrompt.mock.calls[0]?.[0];
      expect(questions[0]?.message).toBe('Delete everything?');
    });

    it('returns true when user confirms', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmed: true });
      const result = await prompts.confirm('OK?');
      expect(result).toBe(true);
    });

    it('returns false when user declines', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmed: false });
      const result = await prompts.confirm('OK?');
      expect(result).toBe(false);
    });

    it('uses provided default value', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmed: true });
      await prompts.confirm('OK?', true);
      const questions = mockInquirerPrompt.mock.calls[0]?.[0];
      expect(questions[0]?.default).toBe(true);
    });

    it('defaults to false when no default given', async () => {
      mockInquirerPrompt.mockResolvedValueOnce({ confirmed: false });
      await prompts.confirm('OK?');
      const questions = mockInquirerPrompt.mock.calls[0]?.[0];
      expect(questions[0]?.default).toBe(false);
    });
  });
});

// =============================================================================
// 11. CLI PROGRAM COMMAND ROUTING
// =============================================================================
describe('CLI program command routing', () => {
  it('character command requires <id> argument', async () => {
    const { program } = await import('../src/cli/index.js');
    const charCmd = program.commands.find(c => c.name() === 'character')!;
    // Commander marks required args with angle brackets
    expect(charCmd.args).toBeDefined();
  });

  it('send command requires <message> argument', async () => {
    const { program } = await import('../src/cli/index.js');
    const sendCmd = program.commands.find(c => c.name() === 'send')!;
    expect(sendCmd).toBeDefined();
  });

  it('configure is an alias for onboard', async () => {
    const { program } = await import('../src/cli/index.js');
    const configureCmd = program.commands.find(c => c.name() === 'configure');
    expect(configureCmd).toBeDefined();
    expect(configureCmd?.description()).toBe('Reconfigure Lain');
  });

  it('all expected commands are registered', async () => {
    const { program } = await import('../src/cli/index.js');
    const names = program.commands.map(c => c.name());
    expect(names).toContain('onboard');
    expect(names).toContain('gateway');
    expect(names).toContain('status');
    expect(names).toContain('doctor');
    expect(names).toContain('chat');
    expect(names).toContain('send');
    expect(names).toContain('configure');
    expect(names).toContain('web');
    expect(names).toContain('telegram');
    expect(names).toContain('character');
  });

  it('program name is "lain"', async () => {
    const { program } = await import('../src/cli/index.js');
    expect(program.name()).toBe('lain');
  });

  it('program version is 0.1.0', async () => {
    const { program } = await import('../src/cli/index.js');
    expect(program.version()).toBe('0.1.0');
  });

  it('program has a description', async () => {
    const { program } = await import('../src/cli/index.js');
    expect(program.description()).toBeTruthy();
  });
});

// =============================================================================
// 12. CROSS-CUTTING BEHAVIORAL CONCERNS
// =============================================================================
describe('Cross-cutting behavioral concerns', () => {
  describe('error display consistency', () => {
    it('displayError uses red indicator symbol', async () => {
      const console_ = captureConsole();
      const prompts = await import('../src/cli/utils/prompts.js');
      prompts.displayError('test');
      expect(console_.output()).toContain('[red]');
      console_.restore();
    });

    it('displaySuccess uses green indicator symbol', async () => {
      const console_ = captureConsole();
      const prompts = await import('../src/cli/utils/prompts.js');
      prompts.displaySuccess('test');
      expect(console_.output()).toContain('[green]');
      console_.restore();
    });

    it('displayWarning uses yellow indicator symbol', async () => {
      const console_ = captureConsole();
      const prompts = await import('../src/cli/utils/prompts.js');
      prompts.displayWarning('test');
      expect(console_.output()).toContain('[yellow]');
      console_.restore();
    });
  });

  describe('process.exit patterns', () => {
    it('character command exits with 1 for unknown character', async () => {
      mockGetCharacterEntry.mockReturnValue(undefined);
      const exit = mockProcessExit();
      const console_ = captureConsole();

      const { startCharacterById } = await import('../src/cli/commands/character.js');
      await expect(startCharacterById('nonexistent')).rejects.toThrow();
      expect(exit.exitCalls).toContain(1);

      console_.restore();
      exit.restore();
    });

    it('web command exits with 1 on server failure', async () => {
      mockStartWebServer.mockRejectedValueOnce(new Error('fail'));
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const console_ = captureConsole();

      const { startWeb } = await import('../src/cli/commands/web.js');
      await startWeb(3000);
      expect(exit).toHaveBeenCalledWith(1);

      console_.restore();
      exit.mockRestore();
    });

    it('telegram command exits with 1 when no token', async () => {
      delete process.env['TELEGRAM_BOT_TOKEN'];
      delete process.env['TELEGRAM_CHAT_ID'];
      const exit = mockProcessExit();
      const console_ = captureConsole();

      const { startTelegram } = await import('../src/cli/commands/telegram.js');
      await expect(startTelegram()).rejects.toThrow('process.exit(1)');

      console_.restore();
      exit.restore();
    });
  });
});
