/**
 * WhatsApp channel connector using Baileys
 */

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  type WASocket,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { nanoid } from 'nanoid';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { BaseChannel, type ChannelConfig } from './base.js';
import type { OutgoingMessage, IncomingMessage, TextContent } from '../types/message.js';
import { getLogger } from '../utils/logger.js';

export interface WhatsAppConfig extends ChannelConfig {
  type: 'whatsapp';
  authDir: string;
  allowedUsers?: string[];
  allowedGroups?: string[];
  /**
   * Opt-in to public mode: when no allowedUsers/allowedGroups are set,
   * empty allowlists deny all incoming messages unless this is `true`.
   */
  public?: boolean;
}

export class WhatsAppChannel extends BaseChannel {
  readonly id: string;
  readonly type = 'whatsapp';
  private socket: WASocket | null = null;
  private config: WhatsAppConfig;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;
  private static readonly MAX_RECONNECT_DELAY_MS = 5 * 60 * 1000;
  private static readonly MAX_RECONNECT_ATTEMPTS = 15;

  constructor(config: WhatsAppConfig) {
    super();
    this.id = config.id;
    this.config = config;
  }

  async connect(): Promise<void> {
    const logger = getLogger();

    if (this.socket) {
      logger.warn({ channelId: this.id }, 'WhatsApp already connected');
      return;
    }

    this.shuttingDown = false;

    logger.info({ channelId: this.id }, 'Connecting WhatsApp');

    const emptyAllowlists =
      !this.config.allowedUsers?.length && !this.config.allowedGroups?.length;
    if (emptyAllowlists) {
      if (this.config.public === true) {
        logger.warn(
          { channelId: this.id },
          'WhatsApp channel running in PUBLIC mode — every sender will be allowed',
        );
      } else {
        logger.warn(
          { channelId: this.id },
          'WhatsApp channel has empty allowlists and public !== true — all incoming messages will be rejected. Set public: true or populate allowedUsers/allowedGroups.',
        );
      }
    }

    // Ensure auth directory exists
    await mkdir(this.config.authDir, { recursive: true });

    // Load auth state
    const { state, saveCreds } = await useMultiFileAuthState(
      join(this.config.authDir, 'auth')
    );

    // Create socket
    this.socket = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      logger: logger as any, // Baileys uses pino-compatible logger
    });

    // Save credentials on update
    this.socket.ev.on('creds.update', saveCreds);

    // Handle connection updates
    this.socket.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        logger.info({ channelId: this.id }, 'Scan QR code to connect WhatsApp');
      }

      if (connection === 'close') {
        const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
        // Null the socket so connect() will proceed past its early-return
        // guard on the reconnect attempt.
        this.socket = null;

        if (reason === DisconnectReason.loggedOut) {
          logger.info({ channelId: this.id }, 'WhatsApp logged out');
          this.emitDisconnect();
        } else if (this.shuttingDown) {
          logger.info({ channelId: this.id }, 'WhatsApp disconnected during shutdown');
          this.emitDisconnect();
        } else {
          logger.warn({ channelId: this.id, reason }, 'WhatsApp disconnected, scheduling reconnect');
          this.emitDisconnect();
          this.scheduleReconnect();
        }
      } else if (connection === 'open') {
        logger.info({ channelId: this.id }, 'WhatsApp connected');
        this.reconnectAttempt = 0;
        this.emitConnect();
      }
    });

    // Handle messages
    this.socket.ev.on('messages.upsert', async (m) => {
      for (const msg of m.messages) {
        if (msg.key.fromMe) continue; // Ignore own messages

        const message = this.messageToIncoming(msg);
        if (message && this.isAllowed(message)) {
          this.emitMessage(message);
        }
      }
    });
  }

  private scheduleReconnect(): void {
    const logger = getLogger();

    if (this.shuttingDown) {
      return;
    }

    this.reconnectAttempt++;
    if (this.reconnectAttempt > WhatsAppChannel.MAX_RECONNECT_ATTEMPTS) {
      logger.error(
        { channelId: this.id, attempts: this.reconnectAttempt },
        'WhatsApp max reconnect attempts reached, giving up'
      );
      return;
    }

    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempt - 1),
      WhatsAppChannel.MAX_RECONNECT_DELAY_MS
    );
    logger.warn(
      { channelId: this.id, attempt: this.reconnectAttempt, delayMs: delay },
      'Scheduling WhatsApp reconnect'
    );
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (this.shuttingDown) return;
      this.connect().catch((err) => {
        logger.error({ error: err, channelId: this.id }, 'WhatsApp reconnect failed');
        this.scheduleReconnect();
      });
    }, delay);
  }

  async disconnect(): Promise<void> {
    const logger = getLogger();

    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (!this.socket) {
      return;
    }

    logger.info({ channelId: this.id }, 'Disconnecting WhatsApp');

    this.socket.end(undefined);
    this.socket = null;
    this.emitDisconnect();
  }

  async send(message: OutgoingMessage): Promise<void> {
    if (!this.socket) {
      throw new Error('WhatsApp not connected');
    }

    const jid = message.peerId.includes('@') ? message.peerId : `${message.peerId}@s.whatsapp.net`;

    if (message.content.type === 'text') {
      await this.socket.sendMessage(jid, {
        text: message.content.text,
      });
    } else if (message.content.type === 'image') {
      const source = message.content.url ?? message.content.base64;
      if (source) {
        const imagePayload: { image: Buffer | { url: string }; caption?: string } = {
          image: source.startsWith('data:') ? Buffer.from(source.split(',')[1]!, 'base64') : { url: source },
        };
        if (message.content.caption) {
          imagePayload.caption = message.content.caption;
        }
        await this.socket.sendMessage(jid, imagePayload);
      }
    } else if (message.content.type === 'file') {
      const source = message.content.url ?? message.content.base64;
      if (source) {
        const docPayload: Record<string, unknown> = {
          document: source.startsWith('data:') ? Buffer.from(source.split(',')[1]!, 'base64') : { url: source },
          mimetype: message.content.mimeType,
        };
        if (message.content.filename) {
          docPayload.fileName = message.content.filename;
        }
        await this.socket.sendMessage(jid, docPayload as Parameters<typeof this.socket.sendMessage>[1]);
      }
    } else if (message.content.type === 'audio') {
      const source = message.content.url ?? message.content.base64;
      if (source) {
        await this.socket.sendMessage(jid, {
          audio: source.startsWith('data:') ? Buffer.from(source.split(',')[1]!, 'base64') : { url: source },
          ptt: true,
        });
      }
    }
  }

  private isAllowed(message: IncomingMessage): boolean {
    // Empty allowlists are fail-closed by default. Only allow all when
    // the operator has explicitly set `public: true`.
    if (!this.config.allowedUsers?.length && !this.config.allowedGroups?.length) {
      return this.config.public === true;
    }

    // Check user whitelist
    if (this.config.allowedUsers?.includes(message.senderId)) {
      return true;
    }

    // Check group whitelist
    if (message.peerKind === 'group' && this.config.allowedGroups?.includes(message.peerId)) {
      return true;
    }

    return false;
  }

  private messageToIncoming(msg: any): IncomingMessage | null {
    const key = msg.key;
    const message = msg.message;

    if (!key || !message) return null;

    const isGroup = key.remoteJid?.endsWith('@g.us') ?? false;
    const senderId = isGroup ? (key.participant ?? '') : (key.remoteJid ?? '');

    let content: IncomingMessage['content'];

    if (message.conversation) {
      content = { type: 'text', text: message.conversation } satisfies TextContent;
    } else if (message.extendedTextMessage?.text) {
      content = { type: 'text', text: message.extendedTextMessage.text } satisfies TextContent;
    } else if (message.imageMessage) {
      // findings.md P2:199 — Baileys delivers encrypted media that must be
      // downloaded via downloadMediaMessage(); we don't plumb those bytes
      // here, so emit a text placeholder instead of an ImageContent with
      // no url/base64.
      const caption = message.imageMessage.caption ? ' ' + message.imageMessage.caption : '';
      content = {
        type: 'text',
        text: '[image attachment]' + caption,
      } satisfies TextContent;
    } else if (message.documentMessage) {
      const filename = message.documentMessage.fileName ?? 'document';
      content = {
        type: 'text',
        text: '[file attachment: ' + filename + ']',
      } satisfies TextContent;
    } else if (message.audioMessage) {
      content = {
        type: 'text',
        text: '[audio attachment]',
      } satisfies TextContent;
    } else {
      // Unsupported message type
      return null;
    }

    const result: IncomingMessage = {
      id: nanoid(16),
      channel: 'whatsapp',
      peerKind: isGroup ? 'group' : 'user',
      peerId: key.remoteJid ?? '',
      senderId: senderId.replace(/@.*$/, ''),
      content,
      timestamp: (msg.messageTimestamp ?? Date.now() / 1000) * 1000,
      metadata: {
        messageId: key.id,
        pushName: msg.pushName,
      },
    };
    const stanzaId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
    if (stanzaId) {
      result.replyTo = stanzaId;
    }
    return result;
  }
}

/**
 * Create a WhatsApp channel from config
 */
export function createWhatsAppChannel(config: WhatsAppConfig): WhatsAppChannel {
  return new WhatsAppChannel(config);
}
