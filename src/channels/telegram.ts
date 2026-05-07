/**
 * Telegram channel connector using grammY
 */

import { Bot, type Context } from 'grammy';
import { nanoid } from 'nanoid';
import { BaseChannel, type ChannelConfig } from './base.js';
import type { OutgoingMessage, IncomingMessage, TextContent } from '../types/message.js';
import { getLogger } from '../utils/logger.js';

export interface TelegramConfig extends ChannelConfig {
  type: 'telegram';
  token: string;
  allowedUsers?: string[];
  allowedGroups?: string[];
  /**
   * Explicit opt-in to serve every user on the platform when no
   * allowedUsers/allowedGroups are configured. Default is fail-closed —
   * empty allowlists reject all senders. Set `true` only if you really
   * want a bot that answers anyone who discovers the handle.
   */
  public?: boolean;
}

export class TelegramChannel extends BaseChannel {
  readonly id: string;
  readonly type = 'telegram';
  private bot: Bot | null = null;
  private config: TelegramConfig;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly MAX_RECONNECT_DELAY_MS = 5 * 60 * 1000; // 5 min
  private static readonly MAX_RECONNECT_ATTEMPTS = 15;

  constructor(config: TelegramConfig) {
    super();
    this.id = config.id;
    this.config = config;
  }

  async connect(): Promise<void> {
    const logger = getLogger();

    if (this.bot) {
      logger.warn({ channelId: this.id }, 'Telegram bot already connected');
      return;
    }

    logger.info({ channelId: this.id }, 'Connecting Telegram bot');

    const emptyAllowlists =
      !this.config.allowedUsers?.length && !this.config.allowedGroups?.length;
    if (emptyAllowlists) {
      if (this.config.public === true) {
        logger.warn(
          { channelId: this.id },
          'Telegram channel running in PUBLIC mode — every user on the platform can message this bot',
        );
      } else {
        logger.warn(
          { channelId: this.id },
          'Telegram channel has empty allowlists and public !== true — all incoming messages will be rejected. Set public: true or populate allowedUsers/allowedGroups.',
        );
      }
    }

    this.bot = new Bot(this.config.token);

    // Handle text messages
    this.bot.on('message:text', async (ctx) => {
      if (!this.isAllowed(ctx)) {
        logger.debug({ chatId: ctx.chat.id }, 'Message from unauthorized chat');
        return;
      }

      const message = this.contextToMessage(ctx);
      this.emitMessage(message);
    });

    // Handle photos
    this.bot.on('message:photo', async (ctx) => {
      if (!this.isAllowed(ctx)) return;

      const message = this.contextToMessage(ctx, 'photo');
      this.emitMessage(message);
    });

    // Handle documents
    this.bot.on('message:document', async (ctx) => {
      if (!this.isAllowed(ctx)) return;

      const message = this.contextToMessage(ctx, 'document');
      this.emitMessage(message);
    });

    // Handle voice messages
    this.bot.on('message:voice', async (ctx) => {
      if (!this.isAllowed(ctx)) return;

      const message = this.contextToMessage(ctx, 'voice');
      this.emitMessage(message);
    });

    // Error handling with auto-reconnect
    this.bot.catch((err) => {
      logger.error({ error: err, channelId: this.id }, 'Telegram bot error');
      this.emitError(err instanceof Error ? err : new Error(String(err)));
      this.attemptReconnect();
    });

    // Start the bot
    this.bot.start({
      onStart: (botInfo) => {
        this.reconnectAttempt = 0;
        logger.info(
          { channelId: this.id, username: botInfo.username },
          'Telegram bot started'
        );
        this.emitConnect();
      },
    });
  }

  private attemptReconnect(): void {
    const logger = getLogger();
    this.reconnectAttempt++;

    if (this.reconnectAttempt > TelegramChannel.MAX_RECONNECT_ATTEMPTS) {
      logger.error(
        { channelId: this.id, attempts: this.reconnectAttempt },
        'Max reconnect attempts reached, giving up'
      );
      return;
    }

    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempt - 1),
      TelegramChannel.MAX_RECONNECT_DELAY_MS
    );
    logger.warn(
      { channelId: this.id, attempt: this.reconnectAttempt, delayMs: delay },
      'Scheduling Telegram reconnect'
    );
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      logger.info({ channelId: this.id, attempt: this.reconnectAttempt }, 'Attempting Telegram reconnect');
      this.bot = null;
      this.connect().catch((err) => {
        logger.error({ error: err, channelId: this.id }, 'Reconnect failed');
        this.attemptReconnect();
      });
    }, delay);
  }

  async disconnect(): Promise<void> {
    const logger = getLogger();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (!this.bot) {
      return;
    }

    logger.info({ channelId: this.id }, 'Disconnecting Telegram bot');

    await this.bot.stop();
    this.bot = null;
    this.emitDisconnect();
  }

  async send(message: OutgoingMessage): Promise<void> {
    if (!this.bot) {
      throw new Error('Telegram bot not connected');
    }

    const chatId = message.peerId;

    if (message.content.type === 'text') {
      const options: Parameters<typeof this.bot.api.sendMessage>[2] = {};
      if (message.replyTo) {
        options.reply_to_message_id = parseInt(message.replyTo, 10);
      }
      // Telegram has a 4096 character limit per message — chunk long texts
      const chunks = splitTelegramMessage(message.content.text);
      for (const chunk of chunks) {
        await this.bot.api.sendMessage(chatId, chunk, options);
        // Only reply to original message on first chunk
        delete options.reply_to_message_id;
      }
    } else if (message.content.type === 'image') {
      const source = message.content.url ?? message.content.base64;
      if (source) {
        const options: Parameters<typeof this.bot.api.sendPhoto>[2] = {};
        if (message.content.caption) {
          options.caption = message.content.caption;
        }
        if (message.replyTo) {
          options.reply_to_message_id = parseInt(message.replyTo, 10);
        }
        await this.bot.api.sendPhoto(chatId, source, options);
      }
    } else if (message.content.type === 'file') {
      const source = message.content.url ?? message.content.base64;
      if (source) {
        const options: Parameters<typeof this.bot.api.sendDocument>[2] = {};
        if (message.content.filename) {
          options.caption = message.content.filename;
        }
        if (message.replyTo) {
          options.reply_to_message_id = parseInt(message.replyTo, 10);
        }
        await this.bot.api.sendDocument(chatId, source, options);
      }
    } else if (message.content.type === 'audio') {
      const source = message.content.url ?? message.content.base64;
      if (source) {
        const options: Parameters<typeof this.bot.api.sendVoice>[2] = {};
        if (message.replyTo) {
          options.reply_to_message_id = parseInt(message.replyTo, 10);
        }
        await this.bot.api.sendVoice(chatId, source, options);
      }
    }
  }

  private isAllowed(ctx: Context): boolean {
    const chatId = ctx.chat?.id.toString();
    const userId = ctx.from?.id.toString();

    if (!chatId || !userId) {
      return false;
    }

    // Empty allowlists are fail-closed by default. Only serve every user
    // when the operator has explicitly set `public: true` in the config.
    if (!this.config.allowedUsers?.length && !this.config.allowedGroups?.length) {
      return this.config.public === true;
    }

    // Check user whitelist
    if (this.config.allowedUsers?.includes(userId)) {
      return true;
    }

    // Check group whitelist for group chats
    if (ctx.chat?.type !== 'private' && this.config.allowedGroups?.includes(chatId)) {
      return true;
    }

    return false;
  }

  private contextToMessage(ctx: Context, mediaType?: string): IncomingMessage {
    const chat = ctx.chat!;
    const from = ctx.from!;
    const msg = ctx.message!;

    let content: IncomingMessage['content'];

    // findings.md P2:199 — Telegram media requires a separate getFile /
    // download round-trip; we don't do that here, so emit a text
    // placeholder instead of a media content with no url/base64.
    if (mediaType === 'photo') {
      const caption = msg.caption ? ' ' + msg.caption : '';
      content = {
        type: 'text',
        text: '[image attachment]' + caption,
      } satisfies TextContent;
    } else if (mediaType === 'document') {
      const filename = msg.document?.file_name ?? 'document';
      content = {
        type: 'text',
        text: '[file attachment: ' + filename + ']',
      } satisfies TextContent;
    } else if (mediaType === 'voice') {
      content = {
        type: 'text',
        text: '[audio attachment]',
      } satisfies TextContent;
    } else {
      content = {
        type: 'text',
        text: msg.text ?? '',
      } satisfies TextContent;
    }

    const result: IncomingMessage = {
      id: nanoid(16),
      channel: 'telegram',
      peerKind: chat.type === 'private' ? 'user' : 'group',
      peerId: chat.id.toString(),
      senderId: from.id.toString(),
      senderName: from.first_name + (from.last_name ? ` ${from.last_name}` : ''),
      content,
      timestamp: msg.date * 1000,
      metadata: {
        messageId: msg.message_id,
        chatType: chat.type,
        username: from.username,
      },
    };
    if (msg.reply_to_message?.message_id) {
      result.replyTo = msg.reply_to_message.message_id.toString();
    }
    return result;
  }
}

const TELEGRAM_MAX_LENGTH = 4096;

/**
 * Split a long message into chunks that fit Telegram's 4096 char limit.
 * Splits on paragraph boundaries (double newline), falling back to single
 * newlines, then hard-cutting as a last resort.
 */
function splitTelegramMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_LENGTH) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > TELEGRAM_MAX_LENGTH) {
    let splitAt = -1;

    // Try to split on paragraph boundary
    const paragraphBreak = remaining.lastIndexOf('\n\n', TELEGRAM_MAX_LENGTH);
    if (paragraphBreak > TELEGRAM_MAX_LENGTH * 0.3) {
      splitAt = paragraphBreak;
    }

    // Fall back to single newline
    if (splitAt === -1) {
      const lineBreak = remaining.lastIndexOf('\n', TELEGRAM_MAX_LENGTH);
      if (lineBreak > TELEGRAM_MAX_LENGTH * 0.3) {
        splitAt = lineBreak;
      }
    }

    // Hard cut as last resort
    if (splitAt === -1) {
      splitAt = TELEGRAM_MAX_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

/**
 * Create a Telegram channel from config
 */
export function createTelegramChannel(config: TelegramConfig): TelegramChannel {
  return new TelegramChannel(config);
}
