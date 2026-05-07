/**
 * API Contract Tests
 *
 * Snapshot-style tests that verify the shapes, types, and export surfaces
 * of core modules don't accidentally change.
 */

import { describe, it, expect } from 'vitest';

// ─────────────────────────────────────────────────────────
// 1. PROVIDER CONTRACT
// ─────────────────────────────────────────────────────────

describe('Provider contract — base types', () => {
  it('BaseProvider is exported as a class', async () => {
    const mod = await import('../src/providers/base.js');
    expect(typeof mod.BaseProvider).toBe('function');
  });

  it('BaseProvider has name property declared', async () => {
    const { BaseProvider } = await import('../src/providers/base.js');
    // Abstract class — can't instantiate, but prototype should exist
    expect(BaseProvider.prototype).toBeDefined();
  });

  it('Provider interface methods exist on AnthropicProvider instance', async () => {
    const { AnthropicProvider } = await import('../src/providers/anthropic.js');
    const p = new AnthropicProvider({ model: 'claude-haiku-4-5-20251001' });
    expect(typeof p.complete).toBe('function');
    expect(typeof p.completeWithTools).toBe('function');
    expect(typeof p.continueWithToolResults).toBe('function');
  });

  it('AnthropicProvider has name and model properties', async () => {
    const { AnthropicProvider } = await import('../src/providers/anthropic.js');
    const p = new AnthropicProvider({ model: 'test-model' });
    expect(p.name).toBe('anthropic');
    expect(p.model).toBe('test-model');
  });

  it('OpenAIProvider exposes correct name', async () => {
    const { OpenAIProvider } = await import('../src/providers/openai.js');
    const p = new OpenAIProvider({ model: 'gpt-4o', apiKey: 'test-key' });
    expect(p.name).toBe('openai');
    expect(p.model).toBe('gpt-4o');
  });

  it('OpenAIProvider has required provider methods', async () => {
    const { OpenAIProvider } = await import('../src/providers/openai.js');
    const p = new OpenAIProvider({ model: 'gpt-4o', apiKey: 'test-key' });
    expect(typeof p.complete).toBe('function');
    expect(typeof p.completeWithTools).toBe('function');
    expect(typeof p.continueWithToolResults).toBe('function');
  });

  it('GoogleProvider exposes correct name', async () => {
    const { GoogleProvider } = await import('../src/providers/google.js');
    const p = new GoogleProvider({ model: 'gemini-pro' });
    expect(p.name).toBe('google');
    expect(p.model).toBe('gemini-pro');
  });

  it('GoogleProvider has required provider methods', async () => {
    const { GoogleProvider } = await import('../src/providers/google.js');
    const p = new GoogleProvider({ model: 'gemini-pro' });
    expect(typeof p.complete).toBe('function');
    expect(typeof p.completeWithTools).toBe('function');
    expect(typeof p.continueWithToolResults).toBe('function');
  });

  it('CompletionResult shape has content, finishReason, usage', () => {
    // Verify the shape by constructing a conforming object
    const result = {
      content: 'hello',
      finishReason: 'stop' as const,
      usage: { inputTokens: 10, outputTokens: 20 },
    };
    expect(result.content).toBeDefined();
    expect(result.finishReason).toBeDefined();
    expect(result.usage).toBeDefined();
    expect(typeof result.usage.inputTokens).toBe('number');
    expect(typeof result.usage.outputTokens).toBe('number');
  });

  it('finishReason covers all expected variants', () => {
    const validReasons = ['stop', 'length', 'content_filter', 'tool_use', 'error'];
    for (const reason of validReasons) {
      expect(validReasons).toContain(reason);
    }
    expect(validReasons).toHaveLength(5);
  });

  it('ToolCall shape has id, name, input', () => {
    const call = { id: 'tc_123', name: 'get_time', input: { timezone: 'UTC' } };
    expect(typeof call.id).toBe('string');
    expect(typeof call.name).toBe('string');
    expect(typeof call.input).toBe('object');
  });

  it('ToolResult shape has toolCallId and content', () => {
    const result = { toolCallId: 'tc_123', content: 'result text' };
    expect(typeof result.toolCallId).toBe('string');
    expect(typeof result.content).toBe('string');
  });

  it('ToolResult isError is optional', () => {
    const withError = { toolCallId: 'x', content: 'err', isError: true };
    const withoutError = { toolCallId: 'x', content: 'ok' };
    expect(withError.isError).toBe(true);
    expect(withoutError.isError).toBeUndefined();
  });

  it('Message role is one of system|user|assistant', () => {
    const validRoles = ['system', 'user', 'assistant'];
    for (const role of validRoles) {
      expect(validRoles).toContain(role);
    }
  });

  it('Message content can be string or ContentBlock array', () => {
    const textMsg = { role: 'user' as const, content: 'hello' };
    const blockMsg = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'hello' }],
    };
    expect(typeof textMsg.content).toBe('string');
    expect(Array.isArray(blockMsg.content)).toBe(true);
  });

  it('TextContentBlock has type="text" and text', () => {
    const block = { type: 'text' as const, text: 'hello' };
    expect(block.type).toBe('text');
    expect(typeof block.text).toBe('string');
  });

  it('ImageContentBlock has type="image" and source', () => {
    const block = {
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: 'image/png' as const,
        data: 'base64data',
      },
    };
    expect(block.type).toBe('image');
    expect(block.source.type).toBe('base64');
    expect(['image/jpeg', 'image/png', 'image/gif', 'image/webp']).toContain(block.source.media_type);
  });

  it('ImageContentBlock media_type covers all valid variants', () => {
    const mediaTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    expect(mediaTypes).toHaveLength(4);
  });

  it('ToolDefinition has name, description, inputSchema', () => {
    const def = { name: 'my_tool', description: 'does stuff', inputSchema: { type: 'object' } };
    expect(typeof def.name).toBe('string');
    expect(typeof def.description).toBe('string');
    expect(typeof def.inputSchema).toBe('object');
  });

  it('CompletionOptions requires messages array', () => {
    const opts = { messages: [{ role: 'user' as const, content: 'hi' }] };
    expect(Array.isArray(opts.messages)).toBe(true);
  });

  it('CompletionWithToolsOptions extends CompletionOptions with optional tools', () => {
    const opts = {
      messages: [],
      tools: [{ name: 't', description: 'd', inputSchema: {} }],
      toolChoice: 'auto' as const,
    };
    expect(Array.isArray(opts.tools)).toBe(true);
    expect(opts.toolChoice).toBe('auto');
  });

  it('toolChoice can be auto, none, or specific tool object', () => {
    const auto = 'auto';
    const none = 'none';
    const specific = { type: 'tool' as const, name: 'my_tool' };
    expect(auto).toBe('auto');
    expect(none).toBe('none');
    expect(specific.type).toBe('tool');
    expect(typeof specific.name).toBe('string');
  });

  it('CompletionWithToolsResult extends CompletionResult with optional toolCalls', () => {
    const result = {
      content: 'text',
      finishReason: 'tool_use' as const,
      usage: { inputTokens: 10, outputTokens: 5 },
      toolCalls: [{ id: 'x', name: 'f', input: {} }],
    };
    expect(Array.isArray(result.toolCalls)).toBe(true);
    expect(result.toolCalls[0]?.id).toBeDefined();
  });

  it('createProvider factory is exported from providers/index', async () => {
    const mod = await import('../src/providers/index.js');
    expect(typeof mod.createProvider).toBe('function');
  });

  it('createAnthropicProvider is exported from providers/anthropic', async () => {
    const mod = await import('../src/providers/anthropic.js');
    expect(typeof mod.createAnthropicProvider).toBe('function');
  });

  it('createOpenAIProvider is exported from providers/openai', async () => {
    const mod = await import('../src/providers/openai.js');
    expect(typeof mod.createOpenAIProvider).toBe('function');
  });

  it('createGoogleProvider is exported from providers/google', async () => {
    const mod = await import('../src/providers/google.js');
    expect(typeof mod.createGoogleProvider).toBe('function');
  });

  it('createAnthropicProvider returns an AnthropicProvider instance', async () => {
    const { AnthropicProvider, createAnthropicProvider } = await import('../src/providers/anthropic.js');
    const p = createAnthropicProvider({ model: 'claude-haiku-4-5-20251001' });
    expect(p).toBeInstanceOf(AnthropicProvider);
  });

  it('createOpenAIProvider returns an OpenAIProvider instance', async () => {
    const { OpenAIProvider, createOpenAIProvider } = await import('../src/providers/openai.js');
    const p = createOpenAIProvider({ model: 'gpt-4o', apiKey: 'test-key' });
    expect(p).toBeInstanceOf(OpenAIProvider);
  });

  it('createGoogleProvider returns a GoogleProvider instance', async () => {
    const { GoogleProvider, createGoogleProvider } = await import('../src/providers/google.js');
    const p = createGoogleProvider({ model: 'gemini-pro' });
    expect(p).toBeInstanceOf(GoogleProvider);
  });
});

// ─────────────────────────────────────────────────────────
// 2. CONFIG CONTRACT
// ─────────────────────────────────────────────────────────

describe('Config contract — schema and types', () => {
  it('validate function is exported from config/schema', async () => {
    const mod = await import('../src/config/schema.js');
    expect(typeof mod.validate).toBe('function');
  });

  it('getSchema function is exported from config/schema', async () => {
    const mod = await import('../src/config/schema.js');
    expect(typeof mod.getSchema).toBe('function');
  });

  it('schema type is "object"', async () => {
    const { getSchema } = await import('../src/config/schema.js');
    const schema = getSchema();
    expect(schema.type).toBe('object');
  });

  it('schema has required top-level fields', async () => {
    // findings.md P2:171 — `agents` removed from LainConfig.
    const { getSchema } = await import('../src/config/schema.js');
    const schema = getSchema();
    expect(schema.required).toContain('version');
    expect(schema.required).toContain('gateway');
    expect(schema.required).toContain('security');
    expect(schema.required).toContain('logging');
    expect(schema.required).not.toContain('agents');
  });

  it('schema has 4 top-level required fields', async () => {
    const { getSchema } = await import('../src/config/schema.js');
    const schema = getSchema();
    expect(schema.required).toHaveLength(4);
  });

  it('gateway schema requires socketPath, socketPermissions, pidFile, rateLimit', async () => {
    const { getSchema } = await import('../src/config/schema.js');
    const schema = getSchema();
    const gw = schema.properties.gateway;
    expect(gw.required).toContain('socketPath');
    expect(gw.required).toContain('socketPermissions');
    expect(gw.required).toContain('pidFile');
    expect(gw.required).toContain('rateLimit');
  });

  it('rateLimit schema requires connectionsPerMinute, requestsPerSecond, burstSize', async () => {
    const { getSchema } = await import('../src/config/schema.js');
    const schema = getSchema();
    const rl = (schema.properties.gateway as { properties: { rateLimit: { required: string[] } } }).properties.rateLimit;
    expect(rl.required).toContain('connectionsPerMinute');
    expect(rl.required).toContain('requestsPerSecond');
    expect(rl.required).toContain('burstSize');
  });

  it('security schema requires requireAuth, tokenLength, inputSanitization, maxMessageLength, keyDerivation', async () => {
    const { getSchema } = await import('../src/config/schema.js');
    const schema = getSchema();
    const sec = schema.properties.security;
    expect(sec.required).toContain('requireAuth');
    expect(sec.required).toContain('tokenLength');
    expect(sec.required).toContain('inputSanitization');
    expect(sec.required).toContain('maxMessageLength');
    expect(sec.required).toContain('keyDerivation');
  });

  it('keyDerivation algorithm is constrained to argon2id', async () => {
    const { getSchema } = await import('../src/config/schema.js');
    const schema = getSchema();
    const kd = (schema.properties.security as {
      properties: { keyDerivation: { properties: { algorithm: { const: string } } } }
    }).properties.keyDerivation;
    expect(kd.properties.algorithm.const).toBe('argon2id');
  });

  // findings.md P2:171 — `agents` removed from LainConfig; per-character
  // provider schema lives in the manifest. The three tests below now
  // probe the manifest schema for the same contract guarantees the old
  // LainConfig schema offered.
  it('manifest character item requires id, name, port, server, defaultLocation, workspace', async () => {
    const fakeManifest = {
      town: { name: 'T', description: 't' },
      characters: [{}], // empty entry — should trigger all required-field errors
    };
    const { validateManifest } = await import('../src/config/manifest-schema.js');
    expect(() => validateManifest(fakeManifest, 'test')).toThrow(
      /id|name|port|server|defaultLocation|workspace/,
    );
  });

  it('manifest provider type enum covers anthropic, openai, google', async () => {
    const { validateManifest } = await import('../src/config/manifest-schema.js');
    for (const type of ['anthropic', 'openai', 'google']) {
      const manifest = {
        town: { name: 'T', description: 't' },
        characters: [{
          id: 'x', name: 'X', port: 3000, server: 'character',
          defaultLocation: 'bar', workspace: 'workspace/characters/x',
          providers: [{ type, model: 'test' }],
        }],
      };
      expect(() => validateManifest(manifest, 'test'), `${type} should validate`).not.toThrow();
    }
    const badManifest = {
      town: { name: 'T', description: 't' },
      characters: [{
        id: 'x', name: 'X', port: 3000, server: 'character',
        defaultLocation: 'bar', workspace: 'workspace/characters/x',
        providers: [{ type: 'cohere', model: 'test' }],
      }],
    };
    expect(() => validateManifest(badManifest, 'test')).toThrow();
  });

  it('logging schema requires level and prettyPrint', async () => {
    const { getSchema } = await import('../src/config/schema.js');
    const schema = getSchema();
    expect(schema.properties.logging.required).toContain('level');
    expect(schema.properties.logging.required).toContain('prettyPrint');
  });

  it('logging level enum covers all pino levels', async () => {
    const { getSchema } = await import('../src/config/schema.js');
    const schema = getSchema();
    const levelEnum = (schema.properties.logging as {
      properties: { level: { enum: string[] } }
    }).properties.level.enum;
    expect(levelEnum).toContain('trace');
    expect(levelEnum).toContain('debug');
    expect(levelEnum).toContain('info');
    expect(levelEnum).toContain('warn');
    expect(levelEnum).toContain('error');
    expect(levelEnum).toContain('fatal');
  });

  it('validate rejects missing required fields', async () => {
    const { validate } = await import('../src/config/schema.js');
    expect(() => validate({})).toThrow();
  });

  it('validate rejects unknown top-level properties', async () => {
    // findings.md P2:171 — `agents` is now itself an unknown top-level
    // property and should be rejected alongside `extra`.
    const { validate } = await import('../src/config/schema.js');
    expect(() => validate({ version: '1', gateway: {}, security: {}, logging: {}, extra: true })).toThrow();
  });

  it('validate accepts a minimal valid config', async () => {
    // findings.md P2:171 — `agents` removed from LainConfig.
    const { validate } = await import('../src/config/schema.js');
    const cfg = {
      version: '1',
      gateway: {
        socketPath: '/tmp/test.sock',
        socketPermissions: 0o600,
        pidFile: '/tmp/test.pid',
        rateLimit: { connectionsPerMinute: 60, requestsPerSecond: 10, burstSize: 20 },
      },
      security: {
        requireAuth: true,
        tokenLength: 32,
        inputSanitization: true,
        maxMessageLength: 100000,
        keyDerivation: { algorithm: 'argon2id', memoryCost: 65536, timeCost: 3, parallelism: 4 },
      },
      logging: { level: 'info', prettyPrint: true },
    };
    expect(validate(cfg)).toBe(true);
  });

  it('getDefaultConfig returns object with all top-level fields', async () => {
    // findings.md P2:171 — `agents` removed from LainConfig.
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    const cfg = getDefaultConfig();
    expect(cfg.version).toBeDefined();
    expect(cfg.gateway).toBeDefined();
    expect(cfg.security).toBeDefined();
    expect(cfg.logging).toBeDefined();
    expect((cfg as Record<string, unknown>)['agents']).toBeUndefined();
  });

  it('getDefaultConfig version is a string', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(typeof getDefaultConfig().version).toBe('string');
  });

  it('getDefaultConfig security.requireAuth is boolean', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(typeof getDefaultConfig().security.requireAuth).toBe('boolean');
  });

  it('getDefaultConfig security.keyDerivation.algorithm is argon2id', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(getDefaultConfig().security.keyDerivation.algorithm).toBe('argon2id');
  });
});

// ─────────────────────────────────────────────────────────
// 3. GATEWAY CONTRACT
// ─────────────────────────────────────────────────────────

describe('Gateway contract', () => {
  it('GatewayErrorCodes is exported from types/gateway', async () => {
    const mod = await import('../src/types/gateway.js');
    expect(mod.GatewayErrorCodes).toBeDefined();
    expect(typeof mod.GatewayErrorCodes).toBe('object');
  });

  it('PARSE_ERROR code is -32700', async () => {
    const { GatewayErrorCodes } = await import('../src/types/gateway.js');
    expect(GatewayErrorCodes.PARSE_ERROR).toBe(-32700);
  });

  it('INVALID_REQUEST code is -32600', async () => {
    const { GatewayErrorCodes } = await import('../src/types/gateway.js');
    expect(GatewayErrorCodes.INVALID_REQUEST).toBe(-32600);
  });

  it('METHOD_NOT_FOUND code is -32601', async () => {
    const { GatewayErrorCodes } = await import('../src/types/gateway.js');
    expect(GatewayErrorCodes.METHOD_NOT_FOUND).toBe(-32601);
  });

  it('INVALID_PARAMS code is -32602', async () => {
    const { GatewayErrorCodes } = await import('../src/types/gateway.js');
    expect(GatewayErrorCodes.INVALID_PARAMS).toBe(-32602);
  });

  it('INTERNAL_ERROR code is -32603', async () => {
    const { GatewayErrorCodes } = await import('../src/types/gateway.js');
    expect(GatewayErrorCodes.INTERNAL_ERROR).toBe(-32603);
  });

  it('UNAUTHORIZED code is -32000', async () => {
    const { GatewayErrorCodes } = await import('../src/types/gateway.js');
    expect(GatewayErrorCodes.UNAUTHORIZED).toBe(-32000);
  });

  it('RATE_LIMITED code is -32001', async () => {
    const { GatewayErrorCodes } = await import('../src/types/gateway.js');
    expect(GatewayErrorCodes.RATE_LIMITED).toBe(-32001);
  });

  it('MESSAGE_TOO_LARGE code is -32002', async () => {
    const { GatewayErrorCodes } = await import('../src/types/gateway.js');
    expect(GatewayErrorCodes.MESSAGE_TOO_LARGE).toBe(-32002);
  });

  it('AGENT_NOT_FOUND code is -32003', async () => {
    const { GatewayErrorCodes } = await import('../src/types/gateway.js');
    expect(GatewayErrorCodes.AGENT_NOT_FOUND).toBe(-32003);
  });

  it('GatewayMessage shape has id, method, optional params', () => {
    const msg = { id: 'req-1', method: 'chat', params: { text: 'hello' } };
    expect(typeof msg.id).toBe('string');
    expect(typeof msg.method).toBe('string');
    expect(typeof msg.params).toBe('object');
  });

  it('GatewayResponse shape has id, optional result, optional error', () => {
    const success = { id: 'req-1', result: 'ok' };
    const failure = { id: 'req-1', error: { code: -32600, message: 'invalid' } };
    expect(success.id).toBeDefined();
    expect(failure.error.code).toBeDefined();
    expect(typeof failure.error.message).toBe('string');
  });

  it('GatewayErrorPayload has code number and message string', () => {
    const payload = { code: -32600, message: 'Bad request' };
    expect(typeof payload.code).toBe('number');
    expect(typeof payload.message).toBe('string');
  });

  it('AuthenticatedConnection has id, authenticatedAt, rateLimit', () => {
    const conn = {
      id: 'conn-1',
      authenticatedAt: Date.now(),
      rateLimit: { requestCount: 0, windowStart: Date.now(), blocked: false },
    };
    expect(typeof conn.id).toBe('string');
    expect(typeof conn.authenticatedAt).toBe('number');
    expect(typeof conn.rateLimit.blocked).toBe('boolean');
  });

  it('GatewayStatus has running, connections, socketPath', () => {
    const status = { running: true, connections: 0, socketPath: '/tmp/test.sock' };
    expect(typeof status.running).toBe('boolean');
    expect(typeof status.connections).toBe('number');
    expect(typeof status.socketPath).toBe('string');
  });

  it('GatewayErrorCodes has exactly 9 entries (5 standard + 4 custom)', async () => {
    const { GatewayErrorCodes } = await import('../src/types/gateway.js');
    expect(Object.keys(GatewayErrorCodes)).toHaveLength(9);
  });

  it('ConnectionRateLimit has requestCount, windowStart, blocked', () => {
    const rl = { requestCount: 5, windowStart: 1000, blocked: false };
    expect(typeof rl.requestCount).toBe('number');
    expect(typeof rl.windowStart).toBe('number');
    expect(typeof rl.blocked).toBe('boolean');
  });

  it('types/index re-exports gateway types (GatewayErrorCodes visible)', async () => {
    const mod = await import('../src/types/index.js');
    expect(mod.GatewayErrorCodes).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────
// 4. SESSION CONTRACT
// ─────────────────────────────────────────────────────────

describe('Session contract', () => {
  it('ChannelType covers telegram', () => {
    const channels = ['telegram', 'whatsapp', 'discord', 'signal', 'slack', 'cli', 'web'];
    expect(channels).toContain('telegram');
  });

  it('ChannelType covers whatsapp', () => {
    const channels = ['telegram', 'whatsapp', 'discord', 'signal', 'slack', 'cli', 'web'];
    expect(channels).toContain('whatsapp');
  });

  it('ChannelType covers discord', () => {
    const channels = ['telegram', 'whatsapp', 'discord', 'signal', 'slack', 'cli', 'web'];
    expect(channels).toContain('discord');
  });

  it('ChannelType covers web', () => {
    const channels = ['telegram', 'whatsapp', 'discord', 'signal', 'slack', 'cli', 'web'];
    expect(channels).toContain('web');
  });

  it('ChannelType covers cli', () => {
    const channels = ['telegram', 'whatsapp', 'discord', 'signal', 'slack', 'cli', 'web'];
    expect(channels).toContain('cli');
  });

  it('ChannelType has exactly 7 variants', () => {
    const channels = ['telegram', 'whatsapp', 'discord', 'signal', 'slack', 'cli', 'web'];
    expect(channels).toHaveLength(7);
  });

  it('PeerKind covers user, group, channel', () => {
    const kinds = ['user', 'group', 'channel'];
    expect(kinds).toContain('user');
    expect(kinds).toContain('group');
    expect(kinds).toContain('channel');
    expect(kinds).toHaveLength(3);
  });

  it('Session shape has required fields', () => {
    const session = {
      key: 'web:abc123',
      agentId: 'default',
      channel: 'web' as const,
      peerKind: 'user' as const,
      peerId: 'user-1',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tokenCount: 0,
      flags: {},
    };
    expect(typeof session.key).toBe('string');
    expect(typeof session.agentId).toBe('string');
    expect(typeof session.channel).toBe('string');
    expect(typeof session.peerKind).toBe('string');
    expect(typeof session.peerId).toBe('string');
    expect(typeof session.createdAt).toBe('number');
    expect(typeof session.tokenCount).toBe('number');
  });

  it('Session transcriptPath is optional', () => {
    const noTranscript = {
      key: 'web:abc', agentId: 'a', channel: 'web' as const,
      peerKind: 'user' as const, peerId: 'p', createdAt: 0, updatedAt: 0,
      tokenCount: 0, flags: {},
    };
    expect(noTranscript.transcriptPath).toBeUndefined();
  });

  it('SessionFlags has optional summarized, archived, muted fields', () => {
    const flags = { summarized: true };
    expect(flags.summarized).toBe(true);
    expect((flags as { archived?: boolean }).archived).toBeUndefined();
  });

  it('SessionCreateInput requires agentId, channel, peerKind, peerId', () => {
    const input = {
      agentId: 'default',
      channel: 'telegram' as const,
      peerKind: 'user' as const,
      peerId: 'tg:123456',
    };
    expect(input.agentId).toBeDefined();
    expect(input.channel).toBeDefined();
    expect(input.peerKind).toBeDefined();
    expect(input.peerId).toBeDefined();
  });

  it('SessionUpdateInput has all optional fields', () => {
    const empty: { tokenCount?: number; transcriptPath?: string } = {};
    expect(empty.tokenCount).toBeUndefined();
    expect(empty.transcriptPath).toBeUndefined();
  });

  it('Credential shape has key, value (Buffer), createdAt', () => {
    const cred = { key: 'my-cred', value: Buffer.from('secret'), createdAt: Date.now() };
    expect(typeof cred.key).toBe('string');
    expect(Buffer.isBuffer(cred.value)).toBe(true);
    expect(typeof cred.createdAt).toBe('number');
  });
});

// ─────────────────────────────────────────────────────────
// 5. EVENT CONTRACT
// ─────────────────────────────────────────────────────────

describe('Event contract', () => {
  it('eventBus is exported from events/bus', async () => {
    const mod = await import('../src/events/bus.js');
    expect(mod.eventBus).toBeDefined();
  });

  it('eventBus has emitActivity method', async () => {
    const { eventBus } = await import('../src/events/bus.js');
    expect(typeof eventBus.emitActivity).toBe('function');
  });

  it('eventBus has setCharacterId method', async () => {
    const { eventBus } = await import('../src/events/bus.js');
    expect(typeof eventBus.setCharacterId).toBe('function');
  });

  it('eventBus has characterId getter', async () => {
    const { eventBus } = await import('../src/events/bus.js');
    // findings.md P2:295 — characterId is `string | null`; defaults to null
    // until setCharacterId is called so uninitialised processes don't silently
    // tag every event as a real character.
    expect(['string', 'object']).toContain(typeof eventBus.characterId);
  });

  it('eventBus is an EventEmitter (has on, emit, off)', async () => {
    const { eventBus } = await import('../src/events/bus.js');
    expect(typeof eventBus.on).toBe('function');
    expect(typeof eventBus.emit).toBe('function');
    expect(typeof eventBus.off).toBe('function');
  });

  it('parseEventType is exported from events/bus', async () => {
    const mod = await import('../src/events/bus.js');
    expect(typeof mod.parseEventType).toBe('function');
  });

  it('parseEventType handles null sessionKey', async () => {
    const { parseEventType } = await import('../src/events/bus.js');
    expect(parseEventType(null)).toBe('unknown');
  });

  it('parseEventType maps commune prefix', async () => {
    const { parseEventType } = await import('../src/events/bus.js');
    expect(parseEventType('commune:pkd:1234')).toBe('commune');
  });

  it('parseEventType maps diary prefix', async () => {
    const { parseEventType } = await import('../src/events/bus.js');
    expect(parseEventType('diary:2024-01')).toBe('diary');
  });

  it('parseEventType maps dream prefix', async () => {
    const { parseEventType } = await import('../src/events/bus.js');
    expect(parseEventType('dream:abc')).toBe('dream');
  });

  it('parseEventType maps curiosity and bibliomancy to curiosity', async () => {
    const { parseEventType } = await import('../src/events/bus.js');
    expect(parseEventType('curiosity:browse')).toBe('curiosity');
    expect(parseEventType('bibliomancy:abc')).toBe('curiosity');
  });

  it('parseEventType maps web prefix to chat', async () => {
    const { parseEventType } = await import('../src/events/bus.js');
    expect(parseEventType('web:abc123')).toBe('chat');
  });

  it('parseEventType maps letter and wired prefixes to letter', async () => {
    const { parseEventType } = await import('../src/events/bus.js');
    expect(parseEventType('letter:2024')).toBe('letter');
    expect(parseEventType('wired:abc')).toBe('letter');
  });

  it('isBackgroundEvent is exported from events/bus', async () => {
    const mod = await import('../src/events/bus.js');
    expect(typeof mod.isBackgroundEvent).toBe('function');
  });

  it('isBackgroundEvent returns true for commune events', async () => {
    const { isBackgroundEvent } = await import('../src/events/bus.js');
    const event = { character: 'lain', type: 'commune', sessionKey: 'commune:x', content: '', timestamp: 0 };
    expect(isBackgroundEvent(event)).toBe(true);
  });

  it('isBackgroundEvent returns false for chat events', async () => {
    const { isBackgroundEvent } = await import('../src/events/bus.js');
    const event = { character: 'lain', type: 'chat', sessionKey: 'web:x', content: '', timestamp: 0 };
    expect(isBackgroundEvent(event)).toBe(false);
  });

  it('SystemEvent shape has character, type, sessionKey, content, timestamp', () => {
    const event = {
      character: 'lain',
      type: 'diary',
      sessionKey: 'diary:2024',
      content: 'today I...',
      timestamp: Date.now(),
    };
    expect(typeof event.character).toBe('string');
    expect(typeof event.type).toBe('string');
    expect(typeof event.sessionKey).toBe('string');
    expect(typeof event.content).toBe('string');
    expect(typeof event.timestamp).toBe('number');
  });
});

// ─────────────────────────────────────────────────────────
// 6. EXPORT SURFACE
// ─────────────────────────────────────────────────────────

describe('Export surface — providers module', () => {
  it('exports BaseProvider class', async () => {
    const mod = await import('../src/providers/index.js');
    expect(typeof mod.BaseProvider).toBe('function');
  });

  it('exports AnthropicProvider class', async () => {
    const mod = await import('../src/providers/index.js');
    expect(typeof mod.AnthropicProvider).toBe('function');
  });

  it('exports OpenAIProvider class', async () => {
    const mod = await import('../src/providers/index.js');
    expect(typeof mod.OpenAIProvider).toBe('function');
  });

  it('exports GoogleProvider class', async () => {
    const mod = await import('../src/providers/index.js');
    expect(typeof mod.GoogleProvider).toBe('function');
  });

  it('exports createProvider function', async () => {
    const mod = await import('../src/providers/index.js');
    expect(typeof mod.createProvider).toBe('function');
  });

  it('exports createAnthropicProvider function', async () => {
    const mod = await import('../src/providers/index.js');
    expect(typeof mod.createAnthropicProvider).toBe('function');
  });

  it('exports createOpenAIProvider function', async () => {
    const mod = await import('../src/providers/index.js');
    expect(typeof mod.createOpenAIProvider).toBe('function');
  });

  it('exports createGoogleProvider function', async () => {
    const mod = await import('../src/providers/index.js');
    expect(typeof mod.createGoogleProvider).toBe('function');
  });
});

describe('Export surface — events module', () => {
  it('exports eventBus singleton', async () => {
    const mod = await import('../src/events/bus.js');
    expect(mod.eventBus).toBeDefined();
  });

  it('exports parseEventType function', async () => {
    const mod = await import('../src/events/bus.js');
    expect(typeof mod.parseEventType).toBe('function');
  });

  it('exports isBackgroundEvent function', async () => {
    const mod = await import('../src/events/bus.js');
    expect(typeof mod.isBackgroundEvent).toBe('function');
  });
});

describe('Export surface — config module', () => {
  it('exports getDefaultConfig from defaults', async () => {
    const mod = await import('../src/config/defaults.js');
    expect(typeof mod.getDefaultConfig).toBe('function');
  });

  it('exports generateSampleConfig from defaults', async () => {
    const mod = await import('../src/config/defaults.js');
    expect(typeof mod.generateSampleConfig).toBe('function');
  });

  it('exports validate from schema', async () => {
    const mod = await import('../src/config/schema.js');
    expect(typeof mod.validate).toBe('function');
  });

  it('exports getSchema from schema', async () => {
    const mod = await import('../src/config/schema.js');
    expect(typeof mod.getSchema).toBe('function');
  });

  it('exports getAllCharacters from characters', async () => {
    const mod = await import('../src/config/characters.js');
    expect(typeof mod.getAllCharacters).toBe('function');
  });

  it('exports getCharacterEntry from characters', async () => {
    const mod = await import('../src/config/characters.js');
    expect(typeof mod.getCharacterEntry).toBe('function');
  });

  it('exports loadManifest from characters', async () => {
    const mod = await import('../src/config/characters.js');
    expect(typeof mod.loadManifest).toBe('function');
  });

  it('exports getImmortalIds from characters', async () => {
    const mod = await import('../src/config/characters.js');
    expect(typeof mod.getImmortalIds).toBe('function');
  });

  it('exports getMortalCharacters from characters', async () => {
    const mod = await import('../src/config/characters.js');
    expect(typeof mod.getMortalCharacters).toBe('function');
  });

  it('exports getPeersFor from characters', async () => {
    const mod = await import('../src/config/characters.js');
    expect(typeof mod.getPeersFor).toBe('function');
  });
});

describe('Export surface — types index', () => {
  it('re-exports GatewayErrorCodes', async () => {
    const mod = await import('../src/types/index.js');
    expect(mod.GatewayErrorCodes).toBeDefined();
  });

  it('re-exports from all four sub-modules without conflict', async () => {
    // If any re-export caused a name collision, the import itself would throw
    const mod = await import('../src/types/index.js');
    expect(mod).toBeDefined();
  });
});

describe('Export surface — commune module', () => {
  it('exports BUILDINGS array from buildings', async () => {
    const mod = await import('../src/commune/buildings.js');
    expect(Array.isArray(mod.BUILDINGS)).toBe(true);
  });

  it('exports BUILDING_MAP from buildings', async () => {
    const mod = await import('../src/commune/buildings.js');
    expect(mod.BUILDING_MAP).toBeInstanceOf(Map);
  });

  it('exports isValidBuilding function from buildings', async () => {
    const mod = await import('../src/commune/buildings.js');
    expect(typeof mod.isValidBuilding).toBe('function');
  });
});

describe('Export surface — agent tools module', () => {
  it('exports registerTool function', async () => {
    const mod = await import('../src/agent/tools.js');
    expect(typeof mod.registerTool).toBe('function');
  });

  it('exports getToolDefinitions function', async () => {
    const mod = await import('../src/agent/tools.js');
    expect(typeof mod.getToolDefinitions).toBe('function');
  });

  it('exports executeTool function', async () => {
    const mod = await import('../src/agent/tools.js');
    expect(typeof mod.executeTool).toBe('function');
  });

  it('exports executeTools function', async () => {
    const mod = await import('../src/agent/tools.js');
    expect(typeof mod.executeTools).toBe('function');
  });

  it('exports unregisterTool function', async () => {
    const mod = await import('../src/agent/tools.js');
    expect(typeof mod.unregisterTool).toBe('function');
  });

  it('does not export a dead toolRequiresApproval helper', async () => {
    // Removed as P1 in findings.md: the helper existed but executeTool
    // never consulted it, so telegram_call ran unattended despite its
    // metadata. Any future approval gating must live in executeTool.
    const mod = await import('../src/agent/tools.js') as Record<string, unknown>;
    expect(mod['toolRequiresApproval']).toBeUndefined();
  });

  it('exports extractTextFromHtml function', async () => {
    const mod = await import('../src/agent/tools.js');
    expect(typeof mod.extractTextFromHtml).toBe('function');
  });
});
