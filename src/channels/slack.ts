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
  /**
   * Opt-in to public mode: when no allowlists are set, messages are
   * denied by default unless this is `true`.
   */
  public?: boolean;
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

    const emptyAllowlists =
      !this.config.allowedUsers?.length && !this.config.allowedChannels?.length;
    if (emptyAllowlists) {
      if (this.config.public === true) {
        logger.warn(
          { channelId: this.id },
          'Slack channel running in PUBLIC mode — every workspace user can message this bot',
        );
      } else {
        logger.warn(
          { channelId: this.id },
          'Slack channel has empty allowlists and public !== true — all incoming messages will be rejected. Set public: true or populate allowedUsers/allowedChannels.',
        );
      }
    }

    this.app = new App({
      token: this.config.botToken,
      appToken: this.config.appToken,
      signingSecret: this.config.signingSecret,
      socketMode: true,
    });

    // Handle all messages
    this.app.message(async ({ message }) => {
      this.acceptSlackEvent(message as SlackMessageEvent);
    });

    // findings.md P2:2586 — app_mention must share the same bot-filter and
    // isAllowed gate as `message`; another bot @-mentioning us would otherwise
    // bypass the allowlist entirely.
    this.app.event('app_mention', async ({ event }) => {
      this.acceptSlackEvent(event as SlackMessageEvent);
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

  private acceptSlackEvent(msg: SlackMessageEvent): void {
    if (msg.bot_id) return;
    const incoming = this.slackToIncoming(msg);
    if (incoming && this.isAllowed(msg)) {
      this.emitMessage(incoming);
    }
  }

  private isAllowed(msg: SlackMessageEvent): boolean {
    // Empty allowlists are fail-closed by default. Only allow all when
    // the operator has explicitly set `public: true`.
    if (!this.config.allowedUsers?.length && !this.config.allowedChannels?.length) {
      return this.config.public === true;
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
      const filename = file.name ?? 'file';

      // findings.md P2:199 — Slack gives us url_private (auth-gated) but
      // not always; downstream consumers need either a URL or base64
      // bytes. Keep url_private when present; otherwise fall back to a
      // text placeholder so we never emit a media content with no data
      // pointer.
      if (file.url_private) {
        const url = file.url_private;
        if (mimeType.startsWith('image/')) {
          content = { type: 'image', mimeType, url };
        } else if (mimeType.startsWith('audio/')) {
          content = { type: 'audio', mimeType, url };
        } else {
          content = { type: 'file', mimeType, filename, url };
        }
      } else {
        if (mimeType.startsWith('image/')) {
          content = { type: 'text', text: '[image attachment]' } satisfies TextContent;
        } else if (mimeType.startsWith('audio/')) {
          content = { type: 'text', text: '[audio attachment]' } satisfies TextContent;
        } else {
          content = {
            type: 'text',
            text: '[file attachment: ' + filename + ']',
          } satisfies TextContent;
        }
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
