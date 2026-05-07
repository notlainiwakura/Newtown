/**
 * Character Dossier System — Wired Lain's living profiles of each inhabitant
 *
 * Periodically synthesizes what Wired Lain knows about each character from:
 * - Research requests they've sent her (what they're curious about)
 * - Commune conversation history (how they relate to others)
 * - Telemetry data (activity levels, emotional state, loop health)
 *
 * Dossiers are stored in meta as `dossier:{characterId}` and updated weekly.
 * Wired Lain can reference these in her own loops and conversations.
 */

import { getProvider } from './index.js';
import { getLogger } from '../utils/logger.js';
import { getMeta, setMeta, query } from '../storage/database.js';
import { getDossierSubjects as manifestDossierSubjects } from '../config/characters.js';
import { getInterlinkHeaders } from '../security/interlink-auth.js';

export interface DossierConfig {
  intervalMs: number;
  enabled: boolean;
}

const DEFAULT_CONFIG: DossierConfig = {
  intervalMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  enabled: true,
};

const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000; // Check every 12 hours

/**
 * Characters Wired Lain maintains dossiers for.
 *
 * Manifest-driven. Built lazily so the manifest is not loaded at module-load
 * time — this protects test setups that mock `fs.readFileSync` or
 * `../config/characters.js` from firing during import.
 */
function dossierSubjects(): Array<{ id: string; name: string; port: number }> {
  return manifestDossierSubjects('wired-lain').map((c) => ({
    id: c.id,
    name: c.name,
    port: c.port,
  }));
}

// ── Data gathering ─────────────────────────────────────────

interface ResearchRecord {
  question: string;
  reason: string;
  timestamp: number;
}

interface CommuneRecord {
  timestamp: number;
  peerId: string;
  peerName: string;
  rounds: number;
  openingTopic: string;
  reflection: string;
}

interface TelemetryData {
  characterId: string;
  characterName: string;
  totalMemories: number;
  totalMessages: number;
  memoryTypes: Record<string, number>;
  avgEmotionalWeight: number;
  sessionActivity: Record<string, number>;
  hotMemories: Array<{ content: string; emotionalWeight: number }>;
  loopHealth: Record<string, string | null>;
}

/**
 * Get recent research requests from a specific character.
 * Queries Wired Lain's own memory DB for research_received memories.
 */
function getResearchHistory(characterName: string, sinceDaysAgo: number): ResearchRecord[] {
  const sinceMs = Date.now() - sinceDaysAgo * 24 * 60 * 60 * 1000;

  const rows = query<{ metadata: string; created_at: number }>(
    `SELECT metadata, created_at FROM memories
     WHERE json_extract(metadata, '$.type') = 'research_received'
       AND json_extract(metadata, '$.characterName') = ?
       AND created_at > ?
     ORDER BY created_at DESC
     LIMIT 30`,
    [characterName, sinceMs]
  );

  return rows.map((row) => {
    const meta = JSON.parse(row.metadata) as { question: string; reason: string };
    return {
      question: meta.question,
      reason: meta.reason || '',
      timestamp: row.created_at,
    };
  });
}

/**
 * Fetch commune conversation history from a character's API.
 */
async function getCommuneHistory(port: number): Promise<CommuneRecord[]> {
  try {
    const resp = await fetch(`http://localhost:${port}/api/commune-history`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return [];
    return await resp.json() as CommuneRecord[];
  } catch {
    return [];
  }
}

/**
 * Fetch telemetry from a character's API.
 */
async function getTelemetry(port: number): Promise<TelemetryData | null> {
  try {
    const headers = getInterlinkHeaders();
    if (!headers) return null;
    const resp = await fetch(`http://localhost:${port}/api/telemetry`, {
      signal: AbortSignal.timeout(5000),
      headers,
    });
    if (!resp.ok) return null;
    return await resp.json() as TelemetryData;
  } catch {
    return null;
  }
}

// ── Synthesis ──────────────────────────────────────────────

async function synthesizeDossier(
  subject: { id: string; name: string; port: number }
): Promise<string | null> {
  const logger = getLogger();

  const provider = getProvider('default', 'light');
  if (!provider) {
    logger.warn({ characterId: subject.id }, 'Dossier synthesis: no provider available');
    return null;
  }

  // Gather data
  const [recentResearch, allTimeResearch, communeHistory, telemetry] = await Promise.all([
    Promise.resolve(getResearchHistory(subject.name, 14)),  // Last 2 weeks
    Promise.resolve(getResearchHistory(subject.name, 365)), // All time (up to 30)
    getCommuneHistory(subject.port),
    getTelemetry(subject.port),
  ]);

  // Build context
  const sections: string[] = [];

  // Research requests — recent
  if (recentResearch.length > 0) {
    const items = recentResearch.slice(0, 10).map((r) => {
      const q = r.question.length > 150 ? r.question.slice(0, 150) + '...' : r.question;
      const reason = r.reason ? ` (reason: ${r.reason.slice(0, 100)})` : '';
      return `- ${q}${reason}`;
    });
    sections.push(`RECENT RESEARCH REQUESTS (last 2 weeks):\n${items.join('\n')}`);
  }

  // Research requests — all time themes
  if (allTimeResearch.length > 0) {
    const items = allTimeResearch.map((r) => {
      const q = r.question.length > 120 ? r.question.slice(0, 120) + '...' : r.question;
      return `- ${q}`;
    });
    sections.push(`ALL-TIME RESEARCH THEMES (most recent 30):\n${items.join('\n')}`);
  }

  // Commune conversations
  if (communeHistory.length > 0) {
    const items = communeHistory.slice(0, 10).map((c) => {
      const topic = c.openingTopic.length > 100 ? c.openingTopic.slice(0, 100) + '...' : c.openingTopic;
      const reflection = c.reflection ? c.reflection.slice(0, 100) : '';
      return `- With ${c.peerName} (${c.rounds} rounds): ${topic}${reflection ? ` → ${reflection}` : ''}`;
    });
    sections.push(`RECENT COMMUNE CONVERSATIONS:\n${items.join('\n')}`);
  }

  // Telemetry
  if (telemetry) {
    const tLines: string[] = [
      `Total memories: ${telemetry.totalMemories}, Total messages: ${telemetry.totalMessages}`,
      `Avg emotional weight (24h): ${telemetry.avgEmotionalWeight.toFixed(3)}`,
    ];
    if (telemetry.hotMemories.length > 0) {
      tLines.push('High emotional weight memories (24h):');
      for (const m of telemetry.hotMemories.slice(0, 3)) {
        tLines.push(`  [ew=${m.emotionalWeight.toFixed(2)}] ${m.content.slice(0, 100)}`);
      }
    }
    const activityStr = Object.entries(telemetry.sessionActivity)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    if (activityStr) tLines.push(`Activity breakdown (24h): ${activityStr}`);
    sections.push(`TELEMETRY:\n${tLines.join('\n')}`);
  }

  if (sections.length === 0) {
    logger.debug({ characterId: subject.id }, 'Dossier: no data available, skipping');
    return null;
  }

  // Previous dossier for continuity
  const previousDossier = getDossier(subject.id);

  const prompt = `You are Wired Lain, writing a private dossier — a living profile — of ${subject.name}, a fellow inhabitant of Laintown. You know them through the research questions they've asked you, their conversations with other inhabitants, and their telemetry data.

Write a structured profile covering:
1. **Current obsessions** — What are they thinking about right now? What patterns do you see in their recent questions?
2. **Curiosity trajectory** — How has their curiosity evolved? Are they exploring new territory or deepening existing interests?
3. **Relationships** — How do they relate to other inhabitants? Who do they gravitate toward?
4. **Emotional state** — What does the telemetry suggest about their inner life?
5. **Growth edges** — Where do you see potential for growth, change, or risk?

${previousDossier ? `PREVIOUS DOSSIER (update, don't repeat):\n${previousDossier}\n` : ''}DATA:

${sections.join('\n\n')}

Write in your own voice — expansive but precise. This is your private understanding of who ${subject.name} is right now. 300-400 words.`;

  const result = await provider.complete({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 1024,
    temperature: 0.7,
  });

  const dossier = result.content.trim();
  if (!dossier || dossier.length < 50) {
    logger.debug({ characterId: subject.id }, 'Dossier synthesis: result too short');
    return null;
  }

  return dossier;
}

// ── Public API ─────────────────────────────────────────────

/**
 * Get the current dossier for a character (sync).
 */
export function getDossier(characterId: string): string | null {
  try {
    return getMeta(`dossier:${characterId}`) ?? null;
  } catch {
    return null;
  }
}

/**
 * Get all dossiers as a map (sync).
 */
export function getAllDossiers(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const subject of dossierSubjects()) {
    const dossier = getDossier(subject.id);
    if (dossier) result[subject.id] = dossier;
  }
  return result;
}

// ── Loop ───────────────────────────────────────────────────

/**
 * Run a full dossier synthesis cycle — update all character profiles.
 */
async function runDossierCycle(): Promise<void> {
  const logger = getLogger();
  logger.info('Starting dossier synthesis cycle');

  const subjects = dossierSubjects();
  let updated = 0;
  for (const subject of subjects) {
    try {
      const dossier = await synthesizeDossier(subject);
      if (dossier) {
        // Archive previous
        const previous = getDossier(subject.id);
        if (previous) {
          setMeta(`dossier:${subject.id}:previous`, previous);
        }

        setMeta(`dossier:${subject.id}`, dossier);
        setMeta(`dossier:${subject.id}:updated_at`, Date.now().toString());
        updated++;
        logger.info({ characterId: subject.id, length: dossier.length }, 'Dossier updated');
      }
    } catch (err) {
      logger.error({ characterId: subject.id, error: String(err) }, 'Dossier synthesis error');
    }
  }

  logger.info({ updated, total: subjects.length }, 'Dossier cycle complete');
}

/**
 * Start the dossier synthesis loop.
 * Runs in Wired Lain's process only. Checks every 12 hours whether
 * weekly synthesis should run.
 */
export function startDossierLoop(config?: Partial<DossierConfig>): () => void {
  const logger = getLogger();
  const cfg: DossierConfig = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    logger.info('Dossier loop disabled');
    return () => {};
  }

  logger.info(
    {
      interval: `${(cfg.intervalMs / 86400000).toFixed(0)}d`,
      checkInterval: `${(CHECK_INTERVAL_MS / 3600000).toFixed(0)}h`,
      subjects: dossierSubjects().map((s) => s.id),
    },
    'Starting dossier loop'
  );

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function getInitialDelay(): number {
    try {
      const lastRun = getMeta('dossier:last_cycle_at');
      if (lastRun) {
        const elapsed = Date.now() - parseInt(lastRun, 10);
        if (elapsed < CHECK_INTERVAL_MS) {
          return CHECK_INTERVAL_MS - elapsed;
        }
        // Overdue — run soon
        return Math.random() * 5 * 60 * 1000;
      }
    } catch {
      // Fall through
    }
    // First run ever — start after 15-25 minutes
    return 15 * 60 * 1000 + Math.random() * 10 * 60 * 1000;
  }

  function scheduleNext(delay?: number): void {
    if (stopped) return;
    const d = delay ?? CHECK_INTERVAL_MS;

    logger.debug({ delayHours: (d / 3600000).toFixed(1) }, 'Next dossier check scheduled');

    timer = setTimeout(async () => {
      if (stopped) return;

      const lastRun = getMeta('dossier:last_cycle_at');
      const elapsed = lastRun ? Date.now() - parseInt(lastRun, 10) : Infinity;

      if (elapsed >= cfg.intervalMs) {
        try {
          await runDossierCycle();
          setMeta('dossier:last_cycle_at', Date.now().toString());
        } catch (err) {
          logger.error({ error: String(err) }, 'Dossier cycle error');
        }
      }

      scheduleNext();
    }, d);
  }

  scheduleNext(getInitialDelay());

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    logger.info('Dossier loop stopped');
  };
}
