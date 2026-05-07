/**
 * Channel module exports
 */

export { BaseChannel, type Channel, type ChannelConfig, type ChannelEvents } from './base.js';
export { TelegramChannel, createTelegramChannel, type TelegramConfig } from './telegram.js';
export { WhatsAppChannel, createWhatsAppChannel, type WhatsAppConfig } from './whatsapp.js';
export { DiscordChannel, createDiscordChannel, type DiscordConfig } from './discord.js';
export { SlackChannel, createSlackChannel, type SlackConfig } from './slack.js';
export { SignalChannel, createSignalChannel, type SignalConfig } from './signal.js';

import type { Channel, ChannelConfig } from './base.js';
import { createTelegramChannel, type TelegramConfig } from './telegram.js';
import { createWhatsAppChannel, type WhatsAppConfig } from './whatsapp.js';
import { createDiscordChannel, type DiscordConfig } from './discord.js';
import { createSlackChannel, type SlackConfig } from './slack.js';
import { createSignalChannel, type SignalConfig } from './signal.js';

export type AnyChannelConfig =
  | TelegramConfig
  | WhatsAppConfig
  | DiscordConfig
  | SlackConfig
  | SignalConfig;

// findings.md P2:2656 — the factory used to dispatch on `config.type`
// with no per-type field validation. A typo'd `.env` produced an
// unhelpful "undefined" error deep inside a channel constructor and
// operators chased ghosts. Assert the required fields here with
// named error messages so config mistakes surface at boot.
function assertNonEmptyString(
  value: unknown,
  channel: string,
  field: string,
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `Channel config invalid: ${channel} requires non-empty string field "${field}"`,
    );
  }
}

function validateChannelConfig(config: AnyChannelConfig): void {
  // Shared fields from ChannelConfig.
  assertNonEmptyString(config.id, config.type, 'id');
  assertNonEmptyString(config.agentId, config.type, 'agentId');

  switch (config.type) {
    case 'telegram':
      assertNonEmptyString(config.token, 'telegram', 'token');
      return;
    case 'whatsapp':
      assertNonEmptyString(config.authDir, 'whatsapp', 'authDir');
      return;
    case 'discord':
      assertNonEmptyString(config.token, 'discord', 'token');
      return;
    case 'slack':
      assertNonEmptyString(config.botToken, 'slack', 'botToken');
      assertNonEmptyString(config.appToken, 'slack', 'appToken');
      assertNonEmptyString(config.signingSecret, 'slack', 'signingSecret');
      return;
    case 'signal':
      assertNonEmptyString(config.socketPath, 'signal', 'socketPath');
      assertNonEmptyString(config.account, 'signal', 'account');
      return;
  }
}

/**
 * Create a channel from configuration
 */
export function createChannel(config: AnyChannelConfig): Channel {
  validateChannelConfig(config);

  switch (config.type) {
    case 'telegram':
      return createTelegramChannel(config);
    case 'whatsapp':
      return createWhatsAppChannel(config);
    case 'discord':
      return createDiscordChannel(config);
    case 'slack':
      return createSlackChannel(config);
    case 'signal':
      return createSignalChannel(config);
    default:
      throw new Error(`Unknown channel type: ${(config as ChannelConfig).type}`);
  }
}
