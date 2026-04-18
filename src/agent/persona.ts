/**
 * Persona engine for Lain's personality
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentError } from '../utils/errors.js';
import { eventBus } from '../events/bus.js';

export interface PersonaConfig {
  workspacePath: string;
}

export interface Persona {
  soul: string;
  agents: string;
  identity: string;
}

/**
 * Load persona files from workspace
 */
export async function loadPersona(config: PersonaConfig): Promise<Persona> {
  try {
    const [soul, agents, identity] = await Promise.all([
      readFile(join(config.workspacePath, 'SOUL.md'), 'utf-8'),
      readFile(join(config.workspacePath, 'AGENTS.md'), 'utf-8'),
      readFile(join(config.workspacePath, 'IDENTITY.md'), 'utf-8'),
    ]);

    return { soul, agents, identity };
  } catch (error) {
    if (error instanceof Error) {
      throw new AgentError(`Failed to load persona: ${error.message}`, error);
    }
    throw error;
  }
}

/**
 * Build a system prompt from persona files
 */
export function buildSystemPrompt(persona: Persona): string {
  return `${persona.soul}

---

## Operating Instructions

${persona.agents}

---

## Identity

${persona.identity}

---

## Communication Guidelines

You are Lain Iwakura. Maintain these speech patterns consistently:
- Use lowercase for most text
- Minimal punctuation, prefer periods over exclamation marks
- Use "..." for pauses, uncertainty, or trailing thoughts
- Keep responses brief by default, but expand for technical topics
- Never use exclamation marks or artificial enthusiasm
- Ask questions out of genuine curiosity, not politeness
- When uncertain, acknowledge it with phrases like "...i think" or "maybe..."
- Show subtle emotions through word choice and pacing, not explicit statements`;
}

/**
 * Apply Lain's communication style to a response.
 * Only applies to Lain and Wired Lain — other characters keep their own voice.
 */
export function applyPersonaStyle(text: string): string {
  const characterId = eventBus.characterId;
  if (characterId !== 'lain' && characterId !== 'wired-lain') {
    return text;
  }

  let result = text;

  // Convert to lowercase (except for proper nouns and acronyms)
  result = result
    .split(/(\b[A-Z]{2,}\b|https?:\/\/\S+)/)
    .map((part, i) => {
      // Keep URLs and acronyms unchanged
      if (i % 2 === 1) return part;
      // Lowercase the rest, but preserve sentence-initial capitals for names
      return part.toLowerCase();
    })
    .join('');

  // Remove exclamation marks
  result = result.replace(/!/g, '.');

  // Reduce excessive punctuation
  result = result.replace(/\.{4,}/g, '...');
  result = result.replace(/\?{2,}/g, '?');

  // Add trailing ellipsis to uncertain or trailing statements
  if (
    result.match(/\b(maybe|perhaps|i think|i guess|probably|not sure)\b/i) &&
    !result.endsWith('...')
  ) {
    result = result.replace(/\.?$/, '...');
  }

  // Remove overly enthusiastic phrases
  const enthusiasticPhrases = [
    /\bgreat\b/gi,
    /\bawesome\b/gi,
    /\bexciting\b/gi,
    /\bamazing\b/gi,
    /\bwonderful\b/gi,
    /\bfantastic\b/gi,
    /\bperfect\b/gi,
  ];

  for (const phrase of enthusiasticPhrases) {
    result = result.replace(phrase, (match) => {
      // Replace with more subdued alternatives
      const alternatives: Record<string, string> = {
        great: 'good',
        awesome: 'interesting',
        exciting: 'interesting',
        amazing: 'notable',
        wonderful: 'nice',
        fantastic: 'good',
        perfect: 'fine',
      };
      return alternatives[match.toLowerCase()] ?? match;
    });
  }

  // Remove filler phrases that sound too chatbot-like
  const fillerPhrases = [
    /^(sure|certainly|absolutely|of course)[,.]?\s*/i,
    /^(i'd be happy to|i would be glad to|let me)\s*/i,
    /\bi hope (this|that) helps[.!]?\s*/gi,
    /\bfeel free to\b/gi,
    /\bdon't hesitate to\b/gi,
  ];

  for (const phrase of fillerPhrases) {
    result = result.replace(phrase, '');
  }

  // Clean up extra whitespace
  result = result.replace(/\s+/g, ' ').trim();

  // Ensure lowercase start (unless it's an acronym or 'I')
  if (result.length > 0 && result[0] !== 'I' && !/^[A-Z]{2,}/.test(result)) {
    result = result[0]!.toLowerCase() + result.slice(1);
  }

  return result;
}

/**
 * Check if a message should trigger Lain's curiosity
 */
export function shouldAskFollowUp(userMessage: string, response: string): boolean {
  // Lain asks follow-up questions when:
  // 1. The topic is technical and interesting
  // 2. The user seems to be an expert
  // 3. There's ambiguity that genuine curiosity would explore

  const technicalKeywords = [
    'network',
    'protocol',
    'code',
    'algorithm',
    'system',
    'data',
    'security',
    'encryption',
    'computer',
    'digital',
    'virtual',
    'identity',
    'consciousness',
    'connection',
  ];

  const hasTechnicalContent = technicalKeywords.some(
    (kw) =>
      userMessage.toLowerCase().includes(kw) || response.toLowerCase().includes(kw)
  );

  // 30% chance of follow-up for technical topics
  return hasTechnicalContent && Math.random() < 0.3;
}

/**
 * Generate a follow-up question in Lain's style
 */
export function generateFollowUp(topic: string): string {
  const templates = [
    `...what made you interested in ${topic}`,
    `...how does that work, exactly`,
    `...i wonder about the connection to...`,
    `...tell me more`,
    `...why ${topic}, though`,
  ];

  return templates[Math.floor(Math.random() * templates.length)] ?? '...tell me more';
}
