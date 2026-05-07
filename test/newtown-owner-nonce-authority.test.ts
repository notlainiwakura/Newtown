import { afterEach, describe, expect, it, vi } from 'vitest';

describe('Newtown owner nonce authority', () => {
  const originalCharacterId = process.env['LAIN_CHARACTER_ID'];

  afterEach(() => {
    vi.resetModules();
    if (originalCharacterId === undefined) delete process.env['LAIN_CHARACTER_ID'];
    else process.env['LAIN_CHARACTER_ID'] = originalCharacterId;
  });

  it('treats the manifest web character as the owner nonce authority', async () => {
    process.env['LAIN_CHARACTER_ID'] = 'newtown';
    const { isOwnerNonceAuthority } = await import('../src/web/owner-nonce-store.js');
    expect(isOwnerNonceAuthority()).toBe(true);
  });
});
