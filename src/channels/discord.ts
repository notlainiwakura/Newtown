/**
 * Discord channel connector using discord.js
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message as DiscordMessage,
  type TextChannel,
  type DMChannel,
} from 'discord.js';
import { nanoid } from 'nanoid';
import { BaseChannel, type ChannelConfig } from './base.js';
import type { OutgoingMessage, IncomingMessage, TextContent } from '../types/message.js';
import { getLogger } from '../utils/logger.js';

export interface DiscordConfig extends ChannelConfig {
  type: 'discord';
  token: string;
  allowedUsers?: string[];
  allowedGuilds?: string[];
  allowedChannels?: string[];
  respondToBots?: boolean;
  /**
   * Opt-in to public mode: when no allowlists are set, incoming messages
   * are denied unless this is `true`.
   */
  public?: boolean;
}

export class DiscordChannel extends BaseChannel {
  readonly id: string;
  readonly type = 'discord';
  private client: Client | null = null;
  private config: DiscordConfig;

  constructor(config: DiscordConfig) {
    super();
    this.id = config.id;
    this.config = config;
  }

  async connect(): Promise<void> {
    const logger = getLogger();

    if (this.client) {
      logger.warn({ channelId: this.id }, 'Discord already connected');
      return;
    }

    logger.info({ channelId: this.id }, 'Connecting Discord bot');

    const emptyAllowlists =
      !this.config.allowedUsers?.length &&
      !this.config.allowedGuilds?.length &&
      !this.config.allowedChannels?.length;
    if (emptyAllowlists) {
      if (this.config.public === true) {
        logger.warn(
          { channelId: this.id },
          'Discord channel running in PUBLIC mode — every user in reachable guilds/DMs can message this bot',
        );
      } else {
        logger.warn(
          { channelId: this.id },
          'Discord channel has empty allowlists and public !== true — all incoming messages will be rejected. Set public: true or populate allowedUsers/allowedGuilds/allowedChannels.',
        );
      }
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    this.client.on('ready', () => {
      logger.info(
        { channelId: this.id, username: this.client?.user?.tag },
        'Discord bot connected'
      );
      this.emitConnect();
    });

    this.client.on('messageCreate', async (msg) => {
      // Ignore own messages
      if (msg.author.id === this.client?.user?.id) return;

      // Optionally ignore bots
      if (msg.author.bot && !this.config.respondToBots) return;

      const message = this.discordToIncoming(msg);
      if (message && this.isAllowed(msg)) {
        this.emitMessage(message);
      }
    });

    this.client.on('error', (error) => {
      logger.error({ channelId: this.id, error }, 'Discord error');
      this.emitError(error);
    });

    this.client.on('disconnect', () => {
      logger.info({ channelId: this.id }, 'Discord disconnected');
      this.emitDisconnect();
    });

    await this.client.login(this.config.token);
  }

  async disconnect(): Promise<void> {
    const logger = getLogger();

    if (!this.client) {
      return;
    }

    logger.info({ channelId: this.id }, 'Disconnecting Discord bot');

    await this.client.destroy();
    this.client = null;
    this.emitDisconnect();
  }

  async send(message: OutgoingMessage): Promise<void> {
    if (!this.client) {
      throw new Error('Discord not connected');
    }

    const channel = await this.client.channels.fetch(message.peerId);

    if (!channel || !('send' in channel)) {
      throw new Error(`Invalid channel: ${message.peerId}`);
    }

    const textChannel = channel as TextChannel | DMChannel;

    if (message.content.type === 'text') {
      const options: Parameters<typeof textChannel.send>[0] = {
        content: message.content.text,
      };
      if (message.replyTo) {
        options.reply = { messageReference: message.replyTo };
      }
      await textChannel.send(options);
    } else if (message.content.type === 'image') {
      const source = message.content.url ?? message.content.base64;
      if (source) {
        const options: Parameters<typeof textChannel.send>[0] = {
          files: [source],
        };
        if (message.content.caption) {
          options.content = message.content.caption;
        }
        if (message.replyTo) {
          options.reply = { messageReference: message.replyTo };
        }
        await textChannel.send(options);
      }
    } else if (message.content.type === 'file') {
      const source = message.content.url ?? message.content.base64;
      if (source) {
        const options: Parameters<typeof textChannel.send>[0] = {
          files: [{ attachment: source, name: message.content.filename }],
        };
        if (message.replyTo) {
          options.reply = { messageReference: message.replyTo };
        }
        await textChannel.send(options);
      }
    }
  }

  private isAllowed(msg: DiscordMessage): boolean {
    // Empty allowlists are fail-closed by default. Only allow all when
    // the operator has explicitly set `public: true`.
    if (
      !this.config.allowedUsers?.length &&
      !this.config.allowedGuilds?.length &&
      !this.config.allowedChannels?.length
    ) {
      return this.config.public === true;
    }

    // Check user whitelist
    if (this.config.allowedUsers?.includes(msg.author.id)) {
      return true;
    }

    // Check guild whitelist
    if (msg.guild && this.config.allowedGuilds?.includes(msg.guild.id)) {
      return true;
    }

    // Check channel whitelist
    if (this.config.allowedChannels?.includes(msg.channel.id)) {
      return true;
    }

    return false;
  }

  private discordToIncoming(msg: DiscordMessage): IncomingMessage | null {
    const isGroup = msg.guild !== null;

    let content: IncomingMessage['content'];

    if (msg.content) {
      content = { type: 'text', text: msg.content } satisfies TextContent;
    } else if (msg.attachments.size > 0) {
      const attachment = msg.attachments.first()!;
      const mimeType = attachment.contentType ?? 'application/octet-stream';

      if (mimeType.startsWith('image/')) {
        content = {
          type: 'image',
          url: attachment.url,
          mimeType,
        };
      } else if (mimeType.startsWith('audio/')) {
        content = {
          type: 'audio',
          url: attachment.url,
          mimeType,
        };
      } else {
        content = {
          type: 'file',
          url: attachment.url,
          mimeType,
          filename: attachment.name ?? 'attachment',
        };
      }
    } else {
      // Empty or unsupported message
      return null;
    }

    const result: IncomingMessage = {
      id: nanoid(16),
      channel: 'discord',
      peerKind: isGroup ? 'group' : 'user',
      peerId: msg.channel.id,
      senderId: msg.author.id,
      senderName: msg.author.displayName ?? msg.author.username,
      content,
      timestamp: msg.createdTimestamp,
      metadata: {
        messageId: msg.id,
        guildId: msg.guild?.id,
        guildName: msg.guild?.name,
      },
    };
    if (msg.reference?.messageId) {
      result.replyTo = msg.reference.messageId;
    }
    return result;
  }
}

/**
 * Create a Discord channel from config
 */
export function createDiscordChannel(config: DiscordConfig): DiscordChannel {
  return new DiscordChannel(config);
}
