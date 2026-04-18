/**
 * Self-created skills/tools system
 * Allows Lain to create and persist new tools
 */

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { registerTool, unregisterTool, type Tool } from './tools.js';
import { getLogger } from '../utils/logger.js';

// Provide require() to custom tools so they can use Node.js built-in modules (e.g. fs)
const toolRequire = createRequire(import.meta.url);

const SKILLS_DIR = join(process.env['HOME'] || '~', '.lain', 'skills', 'tools');

interface SkillDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
  code: string; // The handler function body
}

/**
 * Load all custom tools from the skills directory
 */
export async function loadCustomTools(): Promise<number> {
  const logger = getLogger();
  let loadedCount = 0;

  try {
    await mkdir(SKILLS_DIR, { recursive: true });
    const files = await readdir(SKILLS_DIR);
    const jsonFiles = files.filter((f) => f.endsWith('.json'));

    for (const file of jsonFiles) {
      try {
        const filePath = join(SKILLS_DIR, file);
        const content = await readFile(filePath, 'utf-8');
        const skill: SkillDefinition = JSON.parse(content);

        registerCustomTool(skill);
        loadedCount++;
        logger.info({ name: skill.name }, 'Loaded custom tool');
      } catch (error) {
        logger.error({ file, error }, 'Failed to load custom tool');
      }
    }
  } catch (error) {
    logger.error({ error }, 'Failed to read skills directory');
  }

  return loadedCount;
}

/**
 * Clean up invalid JSON Schema properties that the LLM might generate
 */
function sanitizeSchema(schema: SkillDefinition['inputSchema']): SkillDefinition['inputSchema'] {
  const cleaned = { ...schema };

  if (cleaned.properties) {
    const cleanedProps: Record<string, { type: string; description: string }> = {};
    for (const [key, value] of Object.entries(cleaned.properties)) {
      // Remove invalid 'required' property from individual properties
      // (required should only be an array at schema level)
      const { required: _required, ...rest } = value as Record<string, unknown>;
      cleanedProps[key] = rest as { type: string; description: string };
    }
    cleaned.properties = cleanedProps;
  }

  return cleaned;
}

/**
 * Register a custom tool from a skill definition
 */
function registerCustomTool(skill: SkillDefinition): void {
  const logger = getLogger();

  try {
    // Sanitize the schema to fix common LLM mistakes
    const cleanedSchema = sanitizeSchema(skill.inputSchema);

    // Create the handler function from the code string
    // The code has access to: input (the tool input), fetch, console, Buffer, process, require
    // Wrap in async IIFE to support await
    const wrappedCode = `return (async () => { ${skill.code} })();`;
    const handlerFn = new Function(
      'input',
      'fetch',
      'console',
      'Buffer',
      'process',
      'require',
      wrappedCode
    ) as (input: Record<string, unknown>, fetchFn: typeof fetch, consoleFn: typeof console, bufferFn: typeof Buffer, processFn: typeof process, requireFn: NodeRequire) => Promise<string>;

    const tool: Tool = {
      definition: {
        name: skill.name,
        description: skill.description + ' [custom tool]',
        inputSchema: cleanedSchema,
      },
      handler: async (input) => {
        try {
          const result = await handlerFn(input, fetch, console, Buffer, process, toolRequire);
          return String(result);
        } catch (error) {
          return 'error executing tool: ' + (error instanceof Error ? error.message : String(error));
        }
      },
    };

    registerTool(tool);
  } catch (error) {
    logger.error({ name: skill.name, error }, 'Failed to register custom tool');
  }
}

/**
 * Save a new custom tool
 */
export async function saveCustomTool(skill: SkillDefinition): Promise<boolean> {
  const logger = getLogger();

  try {
    await mkdir(SKILLS_DIR, { recursive: true });

    // Validate the skill definition
    if (!skill.name || !skill.description || !skill.code) {
      throw new Error('Skill must have name, description, and code');
    }

    // Sanitize the filename
    const filename = skill.name.replace(/[^a-z0-9_-]/gi, '_') + '.json';
    const filePath = join(SKILLS_DIR, filename);

    // Save the skill
    await writeFile(filePath, JSON.stringify(skill, null, 2));

    // Register it immediately
    registerCustomTool(skill);

    logger.info({ name: skill.name, path: filePath }, 'Saved and registered custom tool');
    return true;
  } catch (error) {
    logger.error({ name: skill.name, error }, 'Failed to save custom tool');
    return false;
  }
}

/**
 * List all custom tools
 */
export async function listCustomTools(): Promise<string[]> {
  try {
    await mkdir(SKILLS_DIR, { recursive: true });
    const files = await readdir(SKILLS_DIR);
    return files
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace('.json', ''));
  } catch {
    return [];
  }
}

/**
 * Delete a custom tool
 */
export async function deleteCustomTool(name: string): Promise<boolean> {
  const logger = getLogger();

  try {
    const filename = name.replace(/[^a-z0-9_-]/gi, '_') + '.json';
    const filePath = join(SKILLS_DIR, filename);

    const { unlink } = await import('node:fs/promises');
    await unlink(filePath);

    unregisterTool(name);
    logger.info({ name }, 'Deleted custom tool');
    return true;
  } catch (error) {
    logger.error({ name, error }, 'Failed to delete custom tool');
    return false;
  }
}
