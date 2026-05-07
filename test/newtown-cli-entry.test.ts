import { describe, expect, it } from 'vitest';
import { isCliEntryPath } from '../src/cli/entry-path.js';

describe('CLI entry detection', () => {
  it('recognizes the Windows dist entry path', () => {
    expect(isCliEntryPath('C:\\Users\\akaik\\Documents\\newtown\\Newtown\\dist\\index.js')).toBe(true);
  });

  it('recognizes the Newtown bin shim', () => {
    expect(isCliEntryPath('C:\\Users\\akaik\\Documents\\newtown\\Newtown\\bin\\newtown.js')).toBe(true);
  });
});
