/**
 * Slack channel connector using Bolt
 */

import { App } from '@slack/bolt';
import { nanoid } from 'nanoid';
import { BaseChannel, type ChannelConfig } from './base.js';
import type { OutgoingMessage, IncomingMessage, TextContent } from '../types/message.js';
import { getLogger } from '../utils/logger.js';

// Type definition for Slack message events
interface SlackMessageEvent {
  type: string;
  user?: string;
  text?: string;
  ts: string;
  channel: string;
  channel_type?: string;
  thread_ts?: string;
  bot_id?: string;
  files?: Array<{
    id: string;
    name?: string;
    mimetype?: string;
    url_private?: string;
  }>;
}

export interface SlackConfig extends ChannelConfig {
  type: 'slack';
  botToken: string;
  appToken: string;
  signingSecret: string;
  allowedUsers?: string[];
  allowedChannels?: string[];
}

export class SlackChannel extends BaseChannel {
  readonly id: string;
  readonly type = 'slack';
  private app: App | null = null;
  private config: SlackConfig;

  constructor(config: SlackConfig) {
    super();
    this.id = config.id;
    this.config = config;
  }

  async connect(): Promise<void> {
    const logger = getLogger();

    if (this.app) {
      logger.warn({ channelId: this.id }, 'Slack already connected');
      return;
    }

    logger.info({ channelId: this.id }, 'Connecting Slack bot');

    this.app = new App({
      token: this.config.botToken,
      appToken: this.config.appToken,
      signingSecret: this.config.signingSecret,
      socketMode: true,
    });

    // Handle all messages
    this.app.message(async ({ message }) => {
      const msg = message as SlackMessageEvent;

      // Ignore bot messages
      if (msg.bot_id) return;

      const incoming = this.slackToIncoming(msg);
      if (incoming && this.isAllowed(msg)) {
        this.emitMessage(incoming);
      }
    });

    // Handle direct messages
    this.app.event('app_mention', async ({ event }) => {
      const incoming = this.slackToIncoming(event as SlackMessageEvent);
      if (incoming) {
        this.emitMessage(incoming);
      }
    });

    // Start the app
    await this.app.start();

    logger.info({ channelId: this.id }, 'Slack bot connected');
    this.emitConnect();
  }

  async disconnect(): Promise<void> {
    const logger = getLogger();

    if (!this.app) {
      return;
    }

    logger.info({ channelId: this.id }, 'Disconnecting Slack bot');

    await this.app.stop();
    this.app = null;
    this.emitDisconnect();
  }

  async send(message: OutgoingMessage): Promise<void> {
    if (!this.app) {
      throw new Error('Slack not connected');
    }

    const channel = message.peerId;

    if (message.content.type === 'text') {
      const params: Parameters<typeof this.app.client.chat.postMessage>[0] = {
        channel,
        text: message.content.text,
      };
      if (message.replyTo) {
        params.thread_ts = message.replyTo;
      }
      await this.app.client.chat.postMessage(params);
    } else if (message.content.type === 'image') {
      const source = message.content.url;
      if (source) {
        const params: Parameters<typeof this.app.client.chat.postMessage>[0] = {
          channel,
          text: message.content.caption ?? '',
          attachments: [
            {
              image_url: source,
              fallback: message.content.caption ?? 'Image',
            },
          ],
        };
        if (message.replyTo) {
          params.thread_ts = message.replyTo;
        }
        await this.app.client.chat.postMessage(params);
      }
    } else if (message.content.type === 'file') {
      // For files, we need to upload first
      const source = message.content.url ?? message.content.base64;
      if (source) {
        const uploadParams: Record<string, unknown> = {
          channel_id: channel,
          filename: message.content.filename,
          file: source.startsWith('data:')
            ? Buffer.from(source.split(',')[1]!, 'base64')
            : source,
        };
        if (message.replyTo) {
          uploadParams.thread_ts = message.replyTo;
        }
        await this.app.client.files.uploadV2(uploadParams as unknown as Parameters<typeof this.app.client.files.uploadV2>[0]);
      }
    }
  }

  private isAllowed(msg: SlackMessageEvent): boolean {
    // If no restrictions, allow all
    if (!this.config.allowedUsers?.length && !this.config.allowedChannels?.length) {
      return true;
    }

    // Check user whitelist
    if (msg.user && this.config.allowedUsers?.includes(msg.user)) {
      return true;
    }

    // Check channel whitelist
    if (msg.channel && this.config.allowedChannels?.includes(msg.channel)) {
      return true;
    }

    return false;
  }

  private slackToIncoming(msg: SlackMessageEvent): IncomingMessage | null {
    if (!msg.text && !msg.files?.length) {
      return null;
    }

    const isChannel = msg.channel_type === 'channel' || msg.channel_type === 'group';

    let content: IncomingMessage['content'];

    if (msg.text) {
      content = { type: 'text', text: msg.text } satisfies TextContent;
    } else if (msg.files && msg.files.length > 0) {
      const file = msg.files[0]!;
      const mimeType = file.mimetype ?? 'application/octet-stream';

      if (mimeType.startsWith('image/')) {
        const imageContent: IncomingMessage['content'] = {
          type: 'image',
          mimeType,
        };
        if (file.url_private) {
          (imageContent as { url?: string }).url = file.url_private;
        }
        content = imageContent;
      } else if (mimeType.startsWith('audio/')) {
        const audioContent: IncomingMessage['content'] = {
          type: 'audio',
          mimeType,
        };
        if (file.url_private) {
          (audioContent as { url?: string }).url = file.url_private;
        }
        content = audioContent;
      } else {
        const fileContent: IncomingMessage['content'] = {
          type: 'file',
          mimeType,
          filename: file.name ?? 'file',
        };
        if (file.url_private) {
          (fileContent as { url?: string }).url = file.url_private;
        }
        content = fileContent;
      }
    } else {
      return null;
    }

    const result: IncomingMessage = {
      id: nanoid(16),
      channel: 'slack',
      peerKind: isChannel ? 'channel' : 'user',
      peerId: msg.channel,
      senderId: msg.user ?? '',
      content,
      timestamp: parseFloat(msg.ts) * 1000,
      metadata: {
        messageTs: msg.ts,
        threadTs: msg.thread_ts,
        channelType: msg.channel_type,
      },
    };
    if (msg.thread_ts) {
      result.replyTo = msg.thread_ts;
    }
    return result;
  }
}

/**
 * Create a Slack channel from config
 */
export function createSlackChannel(config: SlackConfig): SlackChannel {
  return new SlackChannel(config);
}
