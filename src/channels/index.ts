/**
 * Channel module exports
 */

export { BaseChannel, type Channel, type ChannelConfig, type ChannelEvents } from './base.js';
export { TelegramChannel, createTelegramChannel, type TelegramConfig } from './telegram.js';
export { SignalChannel, createSignalChannel, type SignalConfig } from './signal.js';

import type { Channel, ChannelConfig } from './base.js';
import { createTelegramChannel, type TelegramConfig } from './telegram.js';
import { createSignalChannel, type SignalConfig } from './signal.js';

export type AnyChannelConfig =
  | TelegramConfig
  | SignalConfig;

/**
 * Create a channel from configuration
 */
export function createChannel(config: AnyChannelConfig): Channel {
  switch (config.type) {
    case 'telegram':
      return createTelegramChannel(config);
    case 'signal':
      return createSignalChannel(config);
    default:
      throw new Error(`Unknown channel type: ${(config as ChannelConfig).type}`);
  }
}
