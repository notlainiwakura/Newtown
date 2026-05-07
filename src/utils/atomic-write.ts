/**
 * Atomic file-write helpers.
 *
 * findings.md P2:2261 — Section 8 (narrative systems) previously used
 * plain `writeFile(path, content, 'utf8')` everywhere: book.ts outline
 * and chapter files, experiments.ts, narratives.ts, dossier.ts. A crash
 * or power loss mid-write leaves a truncated / zero-byte file and weeks
 * of LLM-generated context vanish. The write-temp-then-rename pattern
 * replaces any existing file in a single filesystem op, so the only
 * observable states are "before" and "after" — never "partial".
 */

import { writeFile, rename, unlink } from 'node:fs/promises';

/**
 * Atomically write `content` to `path` by writing a sibling `.tmp` file
 * and renaming into place. The rename is atomic on POSIX filesystems.
 */
export async function writeFileAtomic(
  path: string,
  content: string | Buffer,
  encoding: BufferEncoding = 'utf8',
): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    if (typeof content === 'string') {
      await writeFile(tmp, content, encoding);
    } else {
      await writeFile(tmp, content);
    }
    await rename(tmp, path);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}
