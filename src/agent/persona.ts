/**
 * Persona engine for workspace-driven character personalities.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentError } from '../utils/errors.js';

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
 * Build a system prompt from persona files.
 */
export function buildSystemPrompt(persona: Persona): string {
  return `${persona.soul}

---

## Operating Instructions

${persona.agents}

---

## Identity

${persona.identity}`;
}

/**
 * Apply light normalization without overriding the active persona.
 */
export function applyPersonaStyle(text: string): string {
  return text
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Check if a message should trigger persona curiosity.
 */
export function shouldAskFollowUp(userMessage: string, response: string): boolean {
  // Personas ask follow-up questions when:
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
 * Generate a simple follow-up question.
 */
export function generateFollowUp(topic: string): string {
  const templates = [
    `What made you interested in ${topic}?`,
    `How does that work, exactly?`,
    `What does that connect to for you?`,
    `Tell me more.`,
    `Why ${topic}?`,
  ];

  return templates[Math.floor(Math.random() * templates.length)] ?? 'Tell me more.';
}
