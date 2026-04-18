/**
 * Persistent data workspace for experiments.
 * Stores datasets (from curiosity downloads) and experiment outputs
 * in getBasePath()/experiment-data/ — per-character, isolated.
 */

import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { getBasePath } from '../config/paths.js';

/** Absolute path to the data workspace */
export function getDataWorkspacePath(): string {
  return join(getBasePath(), 'experiment-data');
}

/** Maximum total size of the data workspace (100 MB) */
export const MAX_DATA_DIR_BYTES = 100 * 1024 * 1024;

/** Maximum size of a single data file (10 MB) */
export const MAX_SINGLE_FILE_BYTES = 10 * 1024 * 1024;

/** Extensions allowed in the data workspace */
export const ALLOWED_DATA_EXTENSIONS = new Set(['.csv', '.json', '.txt', '.tsv']);

/** Ensure the data workspace directory exists */
export function ensureDataWorkspace(): string {
  const dir = getDataWorkspacePath();
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Sum the byte sizes of all files in the workspace */
export function getDataWorkspaceSize(): number {
  const dir = getDataWorkspacePath();
  try {
    const files = readdirSync(dir);
    let total = 0;
    for (const f of files) {
      try {
        total += statSync(join(dir, f)).size;
      } catch {
        // skip unreadable files
      }
    }
    return total;
  } catch {
    return 0;
  }
}

export interface DataFileInfo {
  name: string;
  sizeKB: number;
}

/** List data files in the workspace with sizes */
export function listDataFiles(): DataFileInfo[] {
  const dir = getDataWorkspacePath();
  try {
    const files = readdirSync(dir);
    const result: DataFileInfo[] = [];
    for (const f of files) {
      const ext = extname(f).toLowerCase();
      if (!ALLOWED_DATA_EXTENSIONS.has(ext)) continue;
      try {
        const size = statSync(join(dir, f)).size;
        if (size <= MAX_SINGLE_FILE_BYTES) {
          result.push({ name: f, sizeKB: Math.round(size / 1024) });
        }
      } catch {
        // skip
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * Sanitize a filename for the data workspace.
 * Strips path components, rejects traversal, validates extension.
 * Returns null if the name is invalid.
 */
export function sanitizeDataFileName(name: string): string | null {
  // Strip path components
  let clean = basename(name);

  // Reject traversal and absolute paths
  if (clean.includes('..') || clean.startsWith('/') || clean.startsWith('\\')) {
    return null;
  }

  // Remove any remaining path separators
  clean = clean.replace(/[/\\]/g, '');

  // Must have an allowed extension
  const ext = extname(clean).toLowerCase();
  if (!ALLOWED_DATA_EXTENSIONS.has(ext)) {
    return null;
  }

  // Must have a meaningful name
  if (clean.length < 2 || clean.length > 200) {
    return null;
  }

  return clean;
}
