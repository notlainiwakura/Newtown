/**
 * `replyTo` allowlist tests — defense against SSRF in the interlink
 * research-request delivery path (server.ts handleResearchRequest).
 *
 * The replyTo URL comes from an interlink-authenticated caller and is used
 * as the base for a server-side POST. Without a guard, it's a fully
 * controllable SSRF primitive (cloud metadata, internal services, any
 * localhost port). safeFetch() would reject legit localhost peer traffic —
 * so we instead pin replyTo to host=127.0.0.1|localhost AND port ∈ manifest.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

import { isAllowedReplyTo } from '../src/security/reply-to.js';

const KNOWN_PORTS = [3000, 3001, 3002, 3003, 3004];

describe('isAllowedReplyTo', () => {
  it('accepts http://127.0.0.1:<known-port>', () => {
    expect(isAllowedReplyTo('http://127.0.0.1:3003', KNOWN_PORTS)).toBe(true);
  });

  it('accepts http://localhost:<known-port>', () => {
    expect(isAllowedReplyTo('http://localhost:3001', KNOWN_PORTS)).toBe(true);
  });

  it('rejects https (character peers talk HTTP on localhost)', () => {
    expect(isAllowedReplyTo('https://127.0.0.1:3003', KNOWN_PORTS)).toBe(false);
  });

  it('rejects unknown ports', () => {
    expect(isAllowedReplyTo('http://127.0.0.1:9999', KNOWN_PORTS)).toBe(false);
  });

  it('rejects non-loopback hosts', () => {
    expect(isAllowedReplyTo('http://example.com:3001', KNOWN_PORTS)).toBe(false);
    expect(isAllowedReplyTo('http://10.0.0.5:3001', KNOWN_PORTS)).toBe(false);
  });

  it('rejects cloud metadata IP', () => {
    expect(isAllowedReplyTo('http://169.254.169.254:3001', KNOWN_PORTS)).toBe(false);
  });

  it('rejects IPv6 loopback [::1] (not in loopback whitelist)', () => {
    // We deliberately only accept 127.0.0.1 / localhost since that's what
    // the manifest and peer URLs use. Extending is easy but broadens the
    // attack surface.
    expect(isAllowedReplyTo('http://[::1]:3001', KNOWN_PORTS)).toBe(false);
  });

  it('rejects credentialed URLs', () => {
    expect(isAllowedReplyTo('http://user:pass@127.0.0.1:3001', KNOWN_PORTS)).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(isAllowedReplyTo('not a url', KNOWN_PORTS)).toBe(false);
    expect(isAllowedReplyTo('', KNOWN_PORTS)).toBe(false);
  });

  it('rejects file:// and javascript:', () => {
    expect(isAllowedReplyTo('file:///etc/passwd', KNOWN_PORTS)).toBe(false);
    expect(isAllowedReplyTo('javascript:alert(1)', KNOWN_PORTS)).toBe(false);
  });

  it('ignores URL path / query — only origin is compared', () => {
    expect(isAllowedReplyTo('http://127.0.0.1:3001/api/interlink/letter?x=1', KNOWN_PORTS)).toBe(true);
  });
});
