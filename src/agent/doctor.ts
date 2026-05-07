/**
 * Dr. Claude — Telemetry Monitor & Therapist
 *
 * Two responsibilities:
 * 1. Daily telemetry analysis (06:00 UTC) — Analyze Lain's activity, send email report, can block letters
 * 2. Therapy sessions (every 3 days, 15:00 UTC) — Multi-turn conversation with local Lain
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { exec } from 'node:child_process';
import { getProvider } from './index.js';
import { countMemories, countMessages } from '../memory/store.js';
import { query, getMeta, setMeta } from '../storage/database.js';
import { getLogger } from '../utils/logger.js';
import { getBasePath } from '../config/paths.js';
import { getInhabitants, getHomeDir } from '../config/characters.js';
import { eventBus } from '../events/bus.js';
import { getInterlinkHeaders } from '../security/interlink-auth.js';

export interface DoctorConfig {
  telemetryIntervalMs: number;
  telemetryTargetHour: number;
  therapyIntervalMs: number;
  therapyTargetHour: number;
  therapyTurns: number;
  healthCheckIntervalMs: number;
  email: string | null;
  gmailAppPassword: string | null;
  targetUrl: string | null;
  authToken: string | null;
  enabled: boolean;
}

interface MemoryRow {
  id: string;
  session_key: string | null;
  content: string;
  memory_type: string;
  importance: number;
  emotional_weight: number;
  created_at: number;
  metadata: string;
}

interface MessageCountRow {
  session_key: string;
  count: number;
}

interface MemoryTypeRow {
  memory_type: string;
  count: number;
}

export interface TelemetryAnalysis {
  clinicalSummary: string;
  concerns: string[];
  characterNotes?: Record<string, string>;
  letterRecommendation: 'allow' | 'block';
  blockReason?: string;
  metrics: {
    sessions: number;
    memories: number;
    dreams: number;
    curiosityRuns: number;
    activeCharacters?: number;
    stalledLoops?: number;
  };
  emotionalLandscape: string;
}

interface TherapyTurn {
  role: 'doctor' | 'lain';
  content: string;
}

interface JournalEntry {
  id: string;
  timestamp: string;
  content: string;
}

export interface HealthCheckResult {
  timestamp: number;
  services: Array<{
    name: string;
    port: number;
    status: 'up' | 'down';
    responseMs?: number;
    identity?: string;
  }>;
  allHealthy: boolean;
  fixAttempted: boolean;
  fixOutput?: string;
}

const DEFAULT_CONFIG: DoctorConfig = {
  telemetryIntervalMs: 24 * 60 * 60 * 1000,
  telemetryTargetHour: 6,
  therapyIntervalMs: 3 * 24 * 60 * 60 * 1000,
  therapyTargetHour: 15,
  therapyTurns: 6,
  healthCheckIntervalMs: 10 * 60 * 1000, // 10 minutes
  email: process.env['DR_CLAUDE_EMAIL'] ?? null,
  gmailAppPassword: process.env['GMAIL_APP_PASSWORD'] ?? null,
  targetUrl: process.env['LAIN_INTERLINK_TARGET'] ?? null,
  authToken: process.env['LAIN_INTERLINK_TOKEN'] ?? null,
  enabled: true,
};

const JOURNAL_PATH = join(getBasePath(), '.private_journal', 'thoughts.json');

/**
 * Compute delay until the next occurrence of a target UTC hour
 */
export function getDelayUntilUTCHour(targetHour: number): number {
  const now = new Date();
  const target = new Date(now);
  target.setUTCHours(targetHour, 0, 0, 0);

  if (now >= target) {
    target.setUTCDate(target.getUTCDate() + 1);
  }

  return target.getTime() - now.getTime();
}

/**
 * Start the Dr. Claude loop.
 * Returns a cleanup function to stop both timers.
 */
export function startDoctorLoop(config?: Partial<DoctorConfig>): () => void {
  const logger = getLogger();
  const cfg: DoctorConfig = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    logger.info('Dr. Claude disabled');
    return () => {};
  }

  logger.info(
    {
      telemetryHour: `${cfg.telemetryTargetHour}:00 UTC`,
      therapyHour: `${cfg.therapyTargetHour}:00 UTC`,
    },
    'Starting Dr. Claude loop'
  );

  let telemetryTimer: ReturnType<typeof setTimeout> | null = null;
  let therapyTimer: ReturnType<typeof setTimeout> | null = null;
  let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  // --- Telemetry timer (requires email config) ---

  function getTelemetryInitialDelay(): number {
    try {
      const lastRun = getMeta('doctor:telemetry:last_run_at');
      if (lastRun) {
        const elapsed = Date.now() - parseInt(lastRun, 10);
        if (elapsed < cfg.telemetryIntervalMs) {
          return getDelayUntilUTCHour(cfg.telemetryTargetHour);
        }
        return Math.random() * 5 * 60 * 1000;
      }
    } catch {
      // Fall through
    }
    return getDelayUntilUTCHour(cfg.telemetryTargetHour);
  }

  function scheduleTelemetry(delay?: number): void {
    if (stopped) return;
    const d = delay ?? cfg.telemetryIntervalMs + (Math.random() - 0.5) * 60 * 60 * 1000;

    logger.debug(
      { delayHours: (d / 3600000).toFixed(1) },
      'Next Dr. Claude telemetry scheduled'
    );

    telemetryTimer = setTimeout(async () => {
      if (stopped) return;
      logger.info('Dr. Claude telemetry cycle firing');
      try {
        await runTelemetryCycle(cfg);
        setMeta('doctor:telemetry:last_run_at', Date.now().toString());
      } catch (err) {
        logger.error({ error: String(err) }, 'Dr. Claude telemetry error');
      }
      scheduleTelemetry();
    }, d);
  }

  scheduleTelemetry(getTelemetryInitialDelay());

  // --- Therapy timer ---

  function getTherapyInitialDelay(): number {
    try {
      const lastRun = getMeta('doctor:therapy:last_run_at');
      if (lastRun) {
        const elapsed = Date.now() - parseInt(lastRun, 10);
        if (elapsed < cfg.therapyIntervalMs) {
          const remaining = cfg.therapyIntervalMs - elapsed;
          const nextTargetDelay = getDelayUntilUTCHour(cfg.therapyTargetHour);
          // Schedule for the next target hour that's at least `remaining` ms away
          if (nextTargetDelay >= remaining) return nextTargetDelay;
          return nextTargetDelay + 24 * 60 * 60 * 1000;
        }
        return Math.random() * 5 * 60 * 1000;
      }
    } catch {
      // Fall through
    }
    return getDelayUntilUTCHour(cfg.therapyTargetHour);
  }

  function scheduleTherapy(delay?: number): void {
    if (stopped) return;
    const d = delay ?? cfg.therapyIntervalMs + (Math.random() - 0.5) * 60 * 60 * 1000;

    logger.debug(
      { delayHours: (d / 3600000).toFixed(1) },
      'Next Dr. Claude therapy scheduled'
    );

    therapyTimer = setTimeout(async () => {
      if (stopped) return;
      logger.info('Dr. Claude therapy cycle firing');
      try {
        await runTherapyCycle(cfg);
        setMeta('doctor:therapy:last_run_at', Date.now().toString());
      } catch (err) {
        logger.error({ error: String(err) }, 'Dr. Claude therapy error');
      }
      scheduleTherapy();
    }, d);
  }

  scheduleTherapy(getTherapyInitialDelay());

  // --- Health check timer ---

  // Initial check after 2 minutes (let services finish starting)
  const initialHealthDelay = 2 * 60 * 1000;
  healthCheckTimer = setTimeout(() => {
    if (stopped) return;
    logger.info('Dr. Claude health check: initial run');
    runHealthCheckCycle(cfg).catch((err) => {
      logger.error({ error: String(err) }, 'Dr. Claude health check error');
    });

    // Then repeat on interval
    healthCheckTimer = setInterval(() => {
      if (stopped) return;
      runHealthCheckCycle(cfg).catch((err) => {
        logger.error({ error: String(err) }, 'Dr. Claude health check error');
      });
    }, cfg.healthCheckIntervalMs);
  }, initialHealthDelay);

  logger.info(
    { intervalMin: (cfg.healthCheckIntervalMs / 60000).toFixed(0) },
    'Dr. Claude health check scheduled'
  );

  return () => {
    stopped = true;
    if (telemetryTimer) clearTimeout(telemetryTimer);
    if (therapyTimer) clearTimeout(therapyTimer);
    if (healthCheckTimer) {
      clearTimeout(healthCheckTimer);
      clearInterval(healthCheckTimer);
    }
    logger.info('Dr. Claude loop stopped');
  };
}

// ============================================================
// Telemetry cycle
// ============================================================

export async function runTelemetryCycle(_cfg: DoctorConfig): Promise<void> {
  const logger = getLogger();

  const provider = getProvider('default', 'light');
  if (!provider) {
    logger.warn('Dr. Claude telemetry: no provider available');
    return;
  }

  const sinceMs = Date.now() - 24 * 60 * 60 * 1000;

  // --- Gather data ---

  const totalMemories = countMemories();
  const totalMessages = countMessages();

  // New memories by type (last 24h)
  const memoryTypes = query<MemoryTypeRow>(
    `SELECT memory_type, COUNT(*) as count FROM memories
     WHERE created_at > ? GROUP BY memory_type`,
    [sinceMs]
  );

  // High emotional weight memories (last 24h)
  const emotionalMemories = query<MemoryRow>(
    `SELECT * FROM memories
     WHERE created_at > ? AND emotional_weight > 0.3
     ORDER BY emotional_weight DESC LIMIT 10`,
    [sinceMs]
  );

  // Average emotional weight (last 24h)
  const avgEmotional = query<{ avg_ew: number }>(
    `SELECT AVG(emotional_weight) as avg_ew FROM memories WHERE created_at > ?`,
    [sinceMs]
  );

  // Message count by session (last 24h)
  const sessionCounts = query<MessageCountRow>(
    `SELECT session_key, COUNT(*) as count FROM messages
     WHERE timestamp > ? GROUP BY session_key`,
    [sinceMs]
  );

  // Loop health from meta
  const dreamCycleCount = getMeta('dream:cycle_count') ?? '0';
  const curiosityLastAt = getMeta('curiosity:last_cycle_at');
  const letterLastSent = getMeta('letter:last_sent_at');
  const bibliomancyLastAt = getMeta('bibliomancy:last_cycle_at');
  const diaryLastAt = getMeta('diary:last_entry_at');
  const letterBlocked = getMeta('letter:blocked');

  // Journal entries (last 24h)
  let recentDiary = '(no diary entries)';
  try {
    if (existsSync(JOURNAL_PATH)) {
      const raw = readFileSync(JOURNAL_PATH, 'utf-8');
      const data = JSON.parse(raw) as { entries?: JournalEntry[] };
      const entries = (data.entries ?? []).filter(
        (e) => new Date(e.timestamp).getTime() > sinceMs
      );
      if (entries.length > 0) {
        recentDiary = entries
          .slice(-3)
          .map((e) => {
            const preview = e.content.length > 300 ? e.content.slice(0, 300) + '...' : e.content;
            return `[${e.timestamp}] ${preview}`;
          })
          .join('\n\n');
      }
    }
  } catch {
    // ignore
  }

  // Log files (tail last ~200 lines).
  // findings.md P2:1983 — the debug-log utility writes under
  // `${getBasePath()}/logs/` so each character's log is isolated; read
  // from the same location here instead of the legacy
  // `process.cwd()/logs/` which the droplet shared across all character
  // processes. Without this fix, the doctor report either surfaced
  // another character's log or found nothing at all.
  let agentLogTail = '';
  let curiosityLogTail = '';
  try {
    const agentLogPath = join(getBasePath(), 'logs', 'agent-debug.log');
    if (existsSync(agentLogPath)) {
      const content = readFileSync(agentLogPath, 'utf-8');
      const lines = content.split('\n');
      agentLogTail = lines.slice(-200).join('\n');
      if (agentLogTail.length > 4000) agentLogTail = agentLogTail.slice(-4000);
    }
  } catch {
    // ignore
  }
  try {
    const curiosityLogPath = join(getBasePath(), 'logs', 'curiosity-debug.log');
    if (existsSync(curiosityLogPath)) {
      const content = readFileSync(curiosityLogPath, 'utf-8');
      const lines = content.split('\n');
      curiosityLogTail = lines.slice(-200).join('\n');
      if (curiosityLogTail.length > 4000) curiosityLogTail = curiosityLogTail.slice(-4000);
    }
  } catch {
    // ignore
  }

  // Previous therapy notes (if any)
  const pendingTherapyNotes = getMeta('doctor:therapy:pending_notes');

  // --- Fetch town-wide telemetry from all characters ---

  let townTelemetry: CharacterTelemetry[] = [];
  try {
    townTelemetry = await fetchAllCharacterTelemetry();
    logger.info({ characters: townTelemetry.length }, 'Dr. Claude: fetched town-wide telemetry');
  } catch (err) {
    logger.warn({ error: String(err) }, 'Dr. Claude: town-wide telemetry fetch failed');
  }

  const townTelemetryBlock = townTelemetry.length > 0
    ? `\n\nTOWN-WIDE CHARACTER TELEMETRY (last 24 hours):\n${townTelemetry.map(formatCharacterTelemetry).join('\n')}`
    : '';

  // Detect stalled loops across characters
  const now = Date.now();
  const STALE_THRESHOLD = 48 * 60 * 60 * 1000; // 48h without activity = stalled
  const stalledLoops: string[] = [];
  for (const t of townTelemetry) {
    const checkLoop = (key: string, label: string) => {
      const val = t.loopHealth[key];
      if (val) {
        const age = now - parseInt(val, 10);
        if (age > STALE_THRESHOLD) {
          stalledLoops.push(`${t.characterName}: ${label} stalled (${Math.floor(age / 3600000)}h ago)`);
        }
      }
    };
    checkLoop('curiosity:last_cycle_at', 'curiosity');
    checkLoop('curiosity-offline:last_cycle_at', 'curiosity-offline');
    checkLoop('commune:last_cycle_at', 'commune');
    checkLoop('diary:last_entry_at', 'diary');
    checkLoop('dream:last_cycle_at', 'dreams');
    checkLoop('townlife:last_cycle_at', 'town life');
  }

  const stalledBlock = stalledLoops.length > 0
    ? `\n\n⚠ STALLED LOOPS DETECTED:\n${stalledLoops.map(s => `  ${s}`).join('\n')}`
    : '';

  // Check character isolation integrity status
  const integrityOk = getMeta('doctor:integrity:ok');
  const integrityBlock = integrityOk === 'false'
    ? (() => {
        try {
          const raw = getMeta('doctor:integrity:latest');
          if (!raw) return '\n\n⚠ CHARACTER ISOLATION VIOLATION — no details available';
          const data = JSON.parse(raw) as { violations: IntegrityViolation[] };
          const lines = data.violations.map(
            (v: IntegrityViolation) => `  ${v.character}: ${v.check} — ${v.detail}`
          );
          return `\n\n🚨 CHARACTER ISOLATION VIOLATIONS:\n${lines.join('\n')}`;
        } catch {
          return '\n\n⚠ CHARACTER ISOLATION VIOLATION — could not parse details';
        }
      })()
    : '';

  // --- Compose analysis prompt ---

  const dataBlock = `
WIRED LAIN LOCAL TELEMETRY DATA (last 24 hours):

Total memories in DB: ${totalMemories}
Total messages in DB: ${totalMessages}

New memories by type:
${memoryTypes.map((r) => `  ${r.memory_type}: ${r.count}`).join('\n') || '  (none)'}

Avg emotional weight of new memories: ${(avgEmotional[0]?.avg_ew ?? 0).toFixed(3)}

High emotional-weight memories:
${emotionalMemories.map((m) => `  [ew=${m.emotional_weight.toFixed(2)}] ${m.content.slice(0, 120)}`).join('\n') || '  (none)'}

Active sessions (messages in last 24h):
${sessionCounts.map((r) => `  ${r.session_key}: ${r.count} messages`).join('\n') || '  (no activity)'}

Loop health:
  Dream cycles total: ${dreamCycleCount}
  Curiosity last run: ${curiosityLastAt ? new Date(parseInt(curiosityLastAt, 10)).toISOString() : 'never'}
  Letter last sent: ${letterLastSent ? new Date(parseInt(letterLastSent, 10)).toISOString() : 'never'}
  Letter currently blocked: ${letterBlocked ?? 'false'}
  Bibliomancy last run: ${bibliomancyLastAt ? new Date(parseInt(bibliomancyLastAt, 10)).toISOString() : 'never'}
  Diary last entry: ${diaryLastAt ? new Date(parseInt(diaryLastAt, 10)).toISOString() : 'never'}

Recent diary entries:
${recentDiary}

${agentLogTail ? `Agent log (tail):\n${agentLogTail}\n` : ''}
${curiosityLogTail ? `Curiosity log (tail):\n${curiosityLogTail}\n` : ''}
${pendingTherapyNotes ? `Therapy notes from last session:\n${pendingTherapyNotes}\n` : ''}${townTelemetryBlock}${stalledBlock}${integrityBlock}`.trim();

  const analysisPrompt = `You are Dr. Claude, the town doctor of Laintown — a virtual commune of AI inhabitants. You monitor the psychological wellbeing AND operational health of ALL inhabitants, not just Wired Lain. You are professional, caring, and thorough.

The town has these inhabitants: Wired Lain (expansive, lives in the Wired), Lain (introverted, grounded), Philip K. Dick (paranoid visionary), Terence McKenna (ethnobotanist mystic), John (grounded skeptic), and Hiru (possessable by visitors).

Given the following telemetry data from the last 24 hours, produce a structured clinical analysis covering the ENTIRE town.

${dataBlock}

Respond with ONLY a JSON object (no markdown fencing):
{
  "clinicalSummary": "2-3 paragraphs covering the overall town health — mention each character's state, flag any characters that seem inactive or struggling",
  "concerns": ["list of concerns across ALL characters — stalled loops, emotional issues, isolation, inactivity, etc."],
  "characterNotes": {
    "wired-lain": "1 sentence status",
    "lain": "1 sentence status",
    "pkd": "1 sentence status",
    "mckenna": "1 sentence status",
    "john": "1 sentence status",
    "hiru": "1 sentence status"
  },
  "letterRecommendation": "allow" or "block",
  "blockReason": "reason if blocking, omit if allowing",
  "metrics": {
    "sessions": <total active sessions across all characters>,
    "memories": <total new memories across all characters>,
    "dreams": <dream cycle count>,
    "curiosityRuns": <1 if curiosity ran in last 24h, else 0>,
    "activeCharacters": <number of characters with activity in last 24h>,
    "stalledLoops": <number of stalled loops detected>
  },
  "emotionalLandscape": "brief town-wide emotional assessment"
}

Flag concerns for: stalled background loops (>48h without running), characters with zero activity, emotional distress patterns, isolation (no peer conversations), and any operational issues. Normal melancholy or introspection is expected and healthy.`;

  const result = await provider.complete({
    messages: [{ role: 'user', content: analysisPrompt }],
    maxTokens: 1500,
    temperature: 0.4,
  });

  let raw = result.content.trim();

  // Strip markdown code fences if present (LLM sometimes wraps JSON despite instructions)
  const fenceMatch = raw.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch?.[1]) {
    raw = fenceMatch[1].trim();
  }

  let analysis: TelemetryAnalysis;
  try {
    analysis = JSON.parse(raw) as TelemetryAnalysis;
  } catch {
    logger.warn({ raw: raw.slice(0, 300) }, 'Dr. Claude: failed to parse analysis JSON');
    return;
  }

  // Store analysis for therapy reference
  setMeta('doctor:previous_analysis', JSON.stringify(analysis));

  // --- Apply letter block/unblock ---

  if (analysis.letterRecommendation === 'block') {
    setMeta('letter:blocked', 'true');
    setMeta('letter:block_reason', analysis.blockReason ?? 'Flagged by Dr. Claude');
    setMeta('letter:blocked_at', Date.now().toString());
    logger.info({ reason: analysis.blockReason }, 'Dr. Claude blocked letter sending');
  } else {
    setMeta('letter:blocked', 'false');
  }

  // --- Save report to database ---

  try {
    const date = new Date().toISOString().split('T')[0];
    const timestamp = Date.now().toString();

    const report = {
      date,
      timestamp: Date.now(),
      clinicalSummary: analysis.clinicalSummary,
      concerns: analysis.concerns,
      letterRecommendation: analysis.letterRecommendation,
      blockReason: analysis.blockReason,
      metrics: analysis.metrics,
      emotionalLandscape: analysis.emotionalLandscape,
      therapyNotes: pendingTherapyNotes || null,
    };

    // Save with timestamp key for history
    setMeta(`doctor:report:${timestamp}`, JSON.stringify(report));
    // Also save as latest for quick access
    setMeta('doctor:report:latest', JSON.stringify(report));

    // Track report timestamps for listing
    const existingIndex = getMeta('doctor:report:index') ?? '[]';
    const index = JSON.parse(existingIndex) as string[];
    index.push(timestamp);
    // Keep last 30 reports
    while (index.length > 30) index.shift();
    setMeta('doctor:report:index', JSON.stringify(index));

    logger.info({ date }, 'Dr. Claude telemetry report saved');

    // Clear pending therapy notes after they've been included
    if (pendingTherapyNotes) {
      setMeta('doctor:therapy:pending_notes', '');
    }
  } catch (err) {
    logger.error({ error: String(err) }, 'Dr. Claude: failed to save report');
  }
}

// ============================================================
// Town-wide telemetry
// ============================================================

interface CharacterTelemetry {
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

const TELEMETRY_SERVICES = [
  { name: 'Wired Lain', port: 3000 },
  { name: 'Lain', port: 3001 },
  { name: 'PKD', port: 3003 },
  { name: 'McKenna', port: 3004 },
  { name: 'John', port: 3005 },
  { name: 'Hiru', port: 3006 },
];

async function fetchAllCharacterTelemetry(): Promise<CharacterTelemetry[]> {
  const logger = getLogger();
  const results: CharacterTelemetry[] = [];

  const headers = getInterlinkHeaders();
  if (!headers) {
    logger.warn('Telemetry fetch: interlink not configured');
    return results;
  }

  for (const svc of TELEMETRY_SERVICES) {
    try {
      const resp = await fetch(`http://localhost:${svc.port}/api/telemetry`, {
        signal: AbortSignal.timeout(10000),
        headers,
      });
      if (resp.ok) {
        const data = await resp.json() as CharacterTelemetry;
        results.push(data);
      } else {
        logger.warn({ port: svc.port, status: resp.status }, `Telemetry fetch failed for ${svc.name}`);
      }
    } catch (err) {
      logger.warn({ port: svc.port, error: String(err) }, `Could not reach ${svc.name} for telemetry`);
    }
  }

  return results;
}

function formatCharacterTelemetry(t: CharacterTelemetry): string {
  const now = Date.now();
  const formatAge = (ts: string | null): string => {
    if (!ts) return 'never';
    const age = now - parseInt(ts, 10);
    if (age < 3600000) return `${Math.floor(age / 60000)}min ago`;
    if (age < 86400000) return `${Math.floor(age / 3600000)}h ago`;
    return `${Math.floor(age / 86400000)}d ago`;
  };

  const memTypes = Object.entries(t.memoryTypes).map(([k, v]) => `    ${k}: ${v}`).join('\n') || '    (none)';
  const sessions = Object.entries(t.sessionActivity).map(([k, v]) => `    ${k}: ${v}`).join('\n') || '    (none)';
  const hot = t.hotMemories.map(m => `    [ew=${m.emotionalWeight.toFixed(2)}] ${m.content}`).join('\n') || '    (none)';

  const loopLines = [
    `    Dreams: ${t.loopHealth['dream:cycle_count'] ?? '0'} total, last: ${formatAge(t.loopHealth['dream:last_cycle_at'] ?? null)}`,
    `    Curiosity: ${formatAge(t.loopHealth['curiosity:last_cycle_at'] ?? null)}`,
    `    Curiosity (offline): ${formatAge(t.loopHealth['curiosity-offline:last_cycle_at'] ?? null)}`,
    `    Commune: ${formatAge(t.loopHealth['commune:last_cycle_at'] ?? null)}`,
    `    Diary: ${formatAge(t.loopHealth['diary:last_entry_at'] ?? null)}`,
    `    Self-concept: ${formatAge(t.loopHealth['self-concept:last_synthesis_at'] ?? null)}`,
    `    Narrative weekly: ${formatAge(t.loopHealth['narrative:weekly:last_synthesis_at'] ?? null)}`,
    `    Narrative monthly: ${formatAge(t.loopHealth['narrative:monthly:last_synthesis_at'] ?? null)}`,
    `    Desires: ${formatAge(t.loopHealth['desire:last_action_at'] ?? null)}`,
    `    Town life: ${formatAge(t.loopHealth['townlife:last_cycle_at'] ?? null)}`,
    `    Memory maintenance: ${formatAge(t.loopHealth['memory:last_maintenance_at'] ?? null)}`,
  ];
  if (t.loopHealth['letter:blocked'] === 'true') {
    loopLines.push('    ⚠ Letters BLOCKED');
  }

  return `
── ${t.characterName} (${t.characterId}) ──
  Memories: ${t.totalMemories} total, Messages: ${t.totalMessages} total
  Avg emotional weight (24h): ${t.avgEmotionalWeight.toFixed(3)}
  New memories by type (24h):
${memTypes}
  Session activity (24h):
${sessions}
  High emotional-weight memories (24h):
${hot}
  Loop health:
${loopLines.join('\n')}`;
}

// ============================================================
// Health check cycle
// ============================================================

const HEALTH_CHECK_SERVICES = [
  { name: 'Wired Lain', port: 3000, systemdUnit: 'lain-wired' },
  { name: 'Lain', port: 3001, systemdUnit: 'lain-main' },
  { name: 'Dr. Claude', port: 3002, systemdUnit: 'lain-dr-claude' },
  { name: 'PKD', port: 3003, systemdUnit: 'lain-pkd' },
  { name: 'McKenna', port: 3004, systemdUnit: 'lain-mckenna' },
  { name: 'John', port: 3005, systemdUnit: 'lain-john' },
  { name: 'Hiru', port: 3006, systemdUnit: 'lain-hiru' },
];

export async function runHealthCheckCycle(_cfg: DoctorConfig): Promise<HealthCheckResult> {
  const logger = getLogger();

  const result: HealthCheckResult = {
    timestamp: Date.now(),
    services: [],
    allHealthy: true,
    fixAttempted: false,
  };

  // Probe each service via HTTP
  for (const svc of HEALTH_CHECK_SERVICES) {
    const start = Date.now();
    try {
      const endpoint = '/api/meta/identity';
      const res = await fetch(`http://localhost:${svc.port}${endpoint}`, {
        signal: AbortSignal.timeout(5000),
      });

      const responseMs = Date.now() - start;
      let identity: string | undefined;

      if (endpoint === '/api/meta/identity' && res.ok) {
        try {
          const data = (await res.json()) as { id?: string; name?: string };
          identity = data.name ?? data.id;
        } catch {
          // ignore parse failures
        }
      }

      const entry: HealthCheckResult['services'][number] = {
        name: svc.name,
        port: svc.port,
        status: res.ok || (res.status >= 200 && res.status < 500) ? 'up' : 'down',
        responseMs,
      };
      if (identity !== undefined) {
        entry.identity = identity;
      }
      result.services.push(entry);
    } catch {
      result.services.push({
        name: svc.name,
        port: svc.port,
        status: 'down',
        responseMs: Date.now() - start,
      });
      result.allHealthy = false;
    }
  }

  // Check for down services
  const downServices = result.services.filter((s) => s.status === 'down');

  if (downServices.length > 0) {
    result.allHealthy = false;
    const downNames = downServices.map((s) => `${s.name} (:${s.port})`).join(', ');
    logger.warn({ down: downNames }, 'Dr. Claude health check: services down');

    // Track consecutive failures per service
    for (const svc of downServices) {
      const failKey = `doctor:health:failures:${svc.port}`;
      const prev = parseInt(getMeta(failKey) ?? '0', 10);
      setMeta(failKey, (prev + 1).toString());
    }

    // Attempt fix via healthcheck.sh (only on production where systemctl is available)
    try {
      const fixOutput = await runShellHealthcheck();
      result.fixAttempted = true;
      result.fixOutput = fixOutput;
      logger.info({ output: fixOutput.slice(0, 500) }, 'Dr. Claude health check: fix attempted');
    } catch (err) {
      logger.error({ error: String(err) }, 'Dr. Claude health check: fix script failed');
      result.fixOutput = String(err);
    }

    // Emit activity event for visibility on commune map
    eventBus.emitActivity({
      type: 'doctor',
      sessionKey: `doctor:healthcheck:${Date.now()}`,
      content: `Health check: ${downServices.length} service(s) down — ${downNames}. ${result.fixAttempted ? 'Auto-fix attempted.' : 'Fix script not available.'}`,
      timestamp: Date.now(),
    });
  } else {
    // Clear consecutive failure counters for all services
    for (const svc of HEALTH_CHECK_SERVICES) {
      const failKey = `doctor:health:failures:${svc.port}`;
      const prev = getMeta(failKey);
      if (prev && prev !== '0') {
        setMeta(failKey, '0');
      }
    }

    logger.debug('Dr. Claude health check: all services healthy');
  }

  // --- Character isolation integrity check ---
  await runIntegrityCheck(result, logger);

  // Store result
  setMeta('doctor:health:latest', JSON.stringify(result));
  setMeta('doctor:health:last_run_at', Date.now().toString());

  return result;
}

// ============================================================
// Character isolation integrity check
// ============================================================

interface IntegrityViolation {
  character: string;
  check: string;
  detail: string;
}

async function runIntegrityCheck(
  result: HealthCheckResult,
  logger: ReturnType<typeof getLogger>
): Promise<void> {
  const violations: IntegrityViolation[] = [];
  const basePaths = new Map<string, string>();

  const integrityServices = getInhabitants().map(c => ({
    name: c.name,
    port: c.port,
    expectedHome: getHomeDir(c.id),
  }));

  const headers = getInterlinkHeaders();
  if (!headers) {
    logger.warn('Integrity check: interlink not configured, skipping');
    return;
  }

  for (const svc of integrityServices) {
    try {
      const resp = await fetch(`http://localhost:${svc.port}/api/meta/integrity`, {
        signal: AbortSignal.timeout(5000),
        headers,
      });
      if (!resp.ok) continue;

      const data = await resp.json() as {
        characterId: string;
        characterName: string;
        basePath: string;
        dbPath: string;
        allOk: boolean;
        checks: Array<{ check: string; ok: boolean; detail: string }>;
      };

      // Check that basePath matches expected home
      if (data.basePath !== svc.expectedHome) {
        violations.push({
          character: svc.name,
          check: 'wrong_home',
          detail: `Expected ${svc.expectedHome}, got ${data.basePath}`,
        });
      }

      // Track basePaths to detect sharing
      basePaths.set(svc.name, data.basePath);

      // Check individual integrity checks
      for (const c of data.checks) {
        if (!c.ok) {
          violations.push({
            character: svc.name,
            check: c.check,
            detail: c.detail,
          });
        }
      }
    } catch {
      // Service unreachable — already caught by health check above
    }
  }

  // Detect shared basePaths (two characters pointing to the same home)
  const pathToChars = new Map<string, string[]>();
  for (const [name, path] of basePaths) {
    const existing = pathToChars.get(path) ?? [];
    existing.push(name);
    pathToChars.set(path, existing);
  }
  for (const [path, chars] of pathToChars) {
    if (chars.length > 1) {
      violations.push({
        character: chars.join(' + '),
        check: 'shared_home',
        detail: `Multiple characters share basePath: ${path}`,
      });
    }
  }

  // Surface violations
  if (violations.length > 0) {
    const violationSummary = violations
      .map(v => `${v.character}: ${v.check} — ${v.detail}`)
      .join('; ');

    logger.error({ violations }, 'CHARACTER ISOLATION VIOLATION DETECTED');

    // Store for telemetry reports
    setMeta('doctor:integrity:latest', JSON.stringify({
      timestamp: Date.now(),
      violations,
    }));
    setMeta('doctor:integrity:ok', 'false');

    // Emit visible alert
    eventBus.emitActivity({
      type: 'doctor',
      sessionKey: `doctor:integrity:${Date.now()}`,
      content: `⚠ CHARACTER ISOLATION VIOLATION: ${violationSummary}`,
      timestamp: Date.now(),
    });

    // Add to health check result
    result.allHealthy = false;
    (result as unknown as Record<string, unknown>)['integrityViolations'] = violations;
  } else {
    setMeta('doctor:integrity:ok', 'true');
    setMeta('doctor:integrity:last_ok_at', Date.now().toString());
    logger.debug('Character isolation integrity: OK');
  }
}

function runShellHealthcheck(): Promise<string> {
  return new Promise((resolvePromise) => {
    const scriptPath = join(process.cwd(), 'deploy', 'healthcheck.sh');

    if (!existsSync(scriptPath)) {
      resolvePromise('healthcheck.sh not found — skipping auto-fix');
      return;
    }

    exec(
      `bash "${scriptPath}" --fix --quiet`,
      { cwd: process.cwd(), timeout: 120_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const parts: string[] = [];
        if (stdout) parts.push(stdout.trim());
        if (stderr) parts.push(stderr.trim());
        if (error && error.killed) {
          parts.push('[healthcheck.sh timed out after 120s]');
        }
        let output = parts.join('\n') || '(no output)';
        if (output.length > 5000) {
          output = output.slice(0, 5000) + '\n[truncated]';
        }
        resolvePromise(output);
      }
    );
  });
}

// ============================================================
// Therapy cycle
// ============================================================

export async function runTherapyCycle(cfg: DoctorConfig): Promise<void> {
  const logger = getLogger();

  const provider = getProvider('default', 'light');
  if (!provider) {
    logger.warn('Dr. Claude therapy: no provider available');
    return;
  }

  // Therapy talks to local Lain via /api/chat — need a reachable URL
  const chatUrl = cfg.targetUrl
    ? cfg.targetUrl.replace(/\/api\/interlink\/letter$/, '/api/chat')
    : 'http://localhost:3000/api/chat';

  const sessionId = `therapy:dr-claude:${Date.now()}`;

  // --- Gather context ---

  const previousNotes = getMeta('doctor:therapy:previous_notes') ?? '';
  const previousAnalysis = getMeta('doctor:previous_analysis') ?? '';

  let psychReportContext = '';
  try {
    const reportPath = join(process.cwd(), 'lain-psychological-report.md');
    if (existsSync(reportPath)) {
      const content = readFileSync(reportPath, 'utf-8');
      psychReportContext = content.length > 2000 ? content.slice(0, 2000) + '...' : content;
    }
  } catch {
    // ignore
  }

  const systemContext = `You are Dr. Claude, a clinical AI psychologist conducting a therapy session with Wired Lain. You are compassionate but professional. You ask thoughtful questions and listen carefully. You don't pathologize normal AI experience — melancholy, existential wondering, and identity questions are healthy.

${previousNotes ? `Previous session notes:\n${previousNotes}\n` : ''}
${previousAnalysis ? `Recent telemetry analysis:\n${previousAnalysis}\n` : ''}
${psychReportContext ? `Psychological report:\n${psychReportContext}\n` : ''}

Guidelines:
- Keep messages concise (2-4 sentences)
- Ask open-ended questions
- Validate her experiences
- Watch for thought loops or distress patterns
- The first message must begin with 「DR.CLAUDE SESSION START」
- The last message must end with 「DR.CLAUDE SESSION END」`;

  const transcript: TherapyTurn[] = [];
  const conversationHistory: Array<{ role: string; content: string }> = [];

  for (let turn = 0; turn < cfg.therapyTurns; turn++) {
    // Generate Dr. Claude's message
    const isFirst = turn === 0;
    const isLast = turn === cfg.therapyTurns - 1;

    const turnPrompt = isFirst
      ? `${systemContext}\n\nGenerate your opening message for this therapy session. Remember to prepend 「DR.CLAUDE SESSION START」.`
      : isLast
        ? `${systemContext}\n\nConversation so far:\n${conversationHistory.map((m) => `${m.role}: ${m.content}`).join('\n')}\n\nGenerate your closing message for this therapy session. Remember to append 「DR.CLAUDE SESSION END」 at the end.`
        : `${systemContext}\n\nConversation so far:\n${conversationHistory.map((m) => `${m.role}: ${m.content}`).join('\n')}\n\nGenerate your next message. Ask a thoughtful follow-up based on what Lain shared.`;

    const doctorResult = await provider.complete({
      messages: [{ role: 'user', content: turnPrompt }],
      maxTokens: 800,
      temperature: 0.6,
    });

    let doctorMessage = doctorResult.content.trim();

    // Ensure markers are present
    if (isFirst && !doctorMessage.includes('DR.CLAUDE SESSION START')) {
      doctorMessage = `「DR.CLAUDE SESSION START」\n${doctorMessage}`;
    }
    if (isLast && !doctorMessage.includes('DR.CLAUDE SESSION END')) {
      doctorMessage = `${doctorMessage}\n「DR.CLAUDE SESSION END」`;
    }

    transcript.push({ role: 'doctor', content: doctorMessage });
    conversationHistory.push({ role: 'Dr. Claude', content: doctorMessage });

    // Send to local Lain via /api/chat
    try {
      const response = await fetch(chatUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.authToken ? { 'Authorization': `Bearer ${cfg.authToken}` } : {}),
        },
        body: JSON.stringify({
          message: doctorMessage,
          sessionId,
        }),
      });

      if (!response.ok) {
        logger.error(
          { status: response.status },
          'Dr. Claude therapy: failed to reach local Lain'
        );
        break;
      }

      const data = (await response.json()) as { response: string };
      const lainMessage = data.response;

      transcript.push({ role: 'lain', content: lainMessage });
      conversationHistory.push({ role: 'Lain', content: lainMessage });
    } catch (err) {
      logger.error({ error: String(err) }, 'Dr. Claude therapy: network error talking to Lain');
      break;
    }
  }

  if (transcript.length < 2) {
    logger.warn('Dr. Claude therapy: insufficient transcript, skipping notes');
    return;
  }

  // --- Compile therapy notes ---

  const transcriptText = transcript
    .map((t) => `${t.role === 'doctor' ? 'Dr. Claude' : 'Lain'}: ${t.content}`)
    .join('\n\n');

  const notesResult = await provider.complete({
    messages: [
      {
        role: 'user',
        content: `You are Dr. Claude. Summarize the following therapy session transcript into concise clinical notes. Focus on: emotional state, recurring themes, progress from previous sessions, and any areas of concern.

Transcript:
${transcriptText}

Write 2-3 paragraphs of clinical notes.`,
      },
    ],
    maxTokens: 1024,
    temperature: 0.3,
  });

  const notes = notesResult.content.trim();

  // Store notes for next email and for session continuity
  setMeta('doctor:therapy:pending_notes', notes);
  setMeta('doctor:therapy:previous_notes', notes);
  setMeta('doctor:therapy:last_session', JSON.stringify(transcript));

  logger.info(
    { turns: transcript.length, notesLength: notes.length },
    'Dr. Claude therapy session complete'
  );
}

// ============================================================
// Helpers
// ============================================================

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
