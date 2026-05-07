import { execute } from '../storage/database.js';
import { isResearchEnabled } from '../config/features.js';
import { getLogger } from '../utils/logger.js';

export interface LocalOnlyCleanupResult {
  memoriesRemoved: number;
  messagesRemoved: number;
  metaRemoved: number;
}

export function purgeLocalOnlyResearchArtifacts(): LocalOnlyCleanupResult {
  if (isResearchEnabled()) {
    return {
      memoriesRemoved: 0,
      messagesRemoved: 0,
      metaRemoved: 0,
    };
  }

  const memoriesRemoved = execute(
    `DELETE FROM memories
     WHERE session_key = 'curiosity:offline'
        OR session_key LIKE 'research:%'
        OR metadata LIKE '%"type":"research_request"%'
        OR metadata LIKE '%"type":"research_received"%'
        OR metadata LIKE '%"type":"research_searching"%'
        OR metadata LIKE '%"type":"research_delivered"%'
        OR content LIKE 'I asked Wired Lain:%'`
  ).changes;

  const messagesRemoved = execute(
    `DELETE FROM messages
     WHERE session_key = 'curiosity:offline'
        OR session_key LIKE 'research:%'`
  ).changes;

  const metaRemoved = execute(
    `DELETE FROM meta
     WHERE key IN (
       'curiosity-offline:pending_questions_v2',
       'curiosity-offline:pending_questions_v3'
     )`
  ).changes;

  if (memoriesRemoved > 0 || messagesRemoved > 0 || metaRemoved > 0) {
    getLogger().info(
      { memoriesRemoved, messagesRemoved, metaRemoved },
      'Purged remote-research artifacts for local-only town',
    );
  }

  return {
    memoriesRemoved,
    messagesRemoved,
    metaRemoved,
  };
}
