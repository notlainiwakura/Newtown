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

/**
 * Create a channel from configuration
 */
export function createChannel(config: AnyChannelConfig): Channel {
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
