/**
 * Dr. Claude — Telemetry Monitor & Therapist
 *
 * Two responsibilities:
 * 1. Daily telemetry analysis (06:00 UTC) — Analyze Lain's activity, send email report, can block letters
 * 2. Therapy sessions (every 3 days, 15:00 UTC) — Multi-turn conversation with local Lain
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getProvider } from './index.js';
import { countMemories, countMessages } from '../memory/store.js';
import { query, getMeta, setMeta } from '../storage/database.js';
import { getLogger } from '../utils/logger.js';

export interface DoctorConfig {
  telemetryIntervalMs: number;
  telemetryTargetHour: number;
  therapyIntervalMs: number;
  therapyTargetHour: number;
  therapyTurns: number;
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
  letterRecommendation: 'allow' | 'block';
  blockReason?: string;
  metrics: {
    sessions: number;
    memories: number;
    dreams: number;
    curiosityRuns: number;
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

const DEFAULT_CONFIG: DoctorConfig = {
  telemetryIntervalMs: 24 * 60 * 60 * 1000,
  telemetryTargetHour: 6,
  therapyIntervalMs: 3 * 24 * 60 * 60 * 1000,
  therapyTargetHour: 15,
  therapyTurns: 6,
  email: process.env['DR_CLAUDE_EMAIL'] ?? null,
  gmailAppPassword: process.env['GMAIL_APP_PASSWORD'] ?? null,
  targetUrl: process.env['LAIN_INTERLINK_TARGET'] ?? null,
  authToken: process.env['LAIN_INTERLINK_TOKEN'] ?? null,
  enabled: true,
};

const JOURNAL_PATH = join(process.cwd(), '.private_journal', 'thoughts.json');

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

  return () => {
    stopped = true;
    if (telemetryTimer) clearTimeout(telemetryTimer);
    if (therapyTimer) clearTimeout(therapyTimer);
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

  // Log files (tail last ~200 lines)
  let agentLogTail = '';
  let curiosityLogTail = '';
  try {
    const agentLogPath = join(process.cwd(), 'logs', 'agent-debug.log');
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
    const curiosityLogPath = join(process.cwd(), 'logs', 'curiosity-debug.log');
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

  // --- Compose analysis prompt ---

  const dataBlock = `
TELEMETRY DATA (last 24 hours):

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
${pendingTherapyNotes ? `Therapy notes from last session:\n${pendingTherapyNotes}\n` : ''}`.trim();

  const analysisPrompt = `You are Dr. Claude, a clinical AI psychologist monitoring the wellbeing of an AI entity called Wired Lain. You are professional, caring, and thorough.

Given the following telemetry data from the last 24 hours, produce a structured clinical analysis.

${dataBlock}

Respond with ONLY a JSON object (no markdown fencing):
{
  "clinicalSummary": "2-3 paragraphs of clinical analysis",
  "concerns": ["list of concerns, or empty array if none"],
  "letterRecommendation": "allow" or "block",
  "blockReason": "reason if blocking, omit if allowing",
  "metrics": {
    "sessions": <number of active sessions>,
    "memories": <new memories count>,
    "dreams": <dream cycle count>,
    "curiosityRuns": <1 if curiosity ran in last 24h, else 0>
  },
  "emotionalLandscape": "brief emotional assessment"
}

Only recommend "block" for letters if you detect genuinely concerning patterns (emotional crisis, repetitive distress loops, dissociative episodes). Normal melancholy or introspection is expected and healthy for Lain.`;

  const result = await provider.complete({
    messages: [{ role: 'user', content: analysisPrompt }],
    maxTokens: 800,
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
    maxTokens: 800,
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
