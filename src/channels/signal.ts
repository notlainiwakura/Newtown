/**
 * Signal channel connector using signal-cli
 *
 * signal-cli provides a JSON-RPC interface for Signal messaging.
 * It can communicate via Unix socket, TCP, or HTTP.
 *
 * Setup:
 * 1. Install signal-cli: brew install signal-cli (macOS) or see https://github.com/AsamK/signal-cli
 * 2. Link your phone: signal-cli link --name "Lain Bot"
 * 3. Start daemon: signal-cli -a +YOURNUMBER daemon --socket ~/.lain/signal.sock
 * 4. Configure this connector with the socket path and account phone number
 */

import { createConnection, type Socket } from 'node:net';
import { nanoid } from 'nanoid';
import { BaseChannel, type ChannelConfig } from './base.js';
import type { OutgoingMessage, IncomingMessage, TextContent } from '../types/message.js';
import { getLogger } from '../utils/logger.js';

export interface SignalConfig extends ChannelConfig {
  type: 'signal';
  socketPath: string;
  account: string; // Phone number in E.164 format (e.g., +1234567890)
  allowedUsers?: string[];
  allowedGroups?: string[];
}

// JSON-RPC types for signal-cli
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

// signal-cli message envelope
interface SignalEnvelope {
  source?: string;
  sourceNumber?: string;
  sourceUuid?: string;
  sourceName?: string;
  sourceDevice?: number;
  timestamp?: number;
  dataMessage?: SignalDataMessage;
  syncMessage?: {
    sentMessage?: {
      destination?: string;
      destinationNumber?: string;
      destinationUuid?: string;
      timestamp?: number;
      message?: string;
      groupInfo?: SignalGroupInfo;
    };
  };
}

interface SignalDataMessage {
  timestamp?: number;
  message?: string;
  groupInfo?: SignalGroupInfo;
  attachments?: SignalAttachment[];
  quote?: {
    id?: number;
    author?: string;
    authorNumber?: string;
    authorUuid?: string;
    text?: string;
  };
  mentions?: Array<{
    start?: number;
    length?: number;
    uuid?: string;
    number?: string;
  }>;
}

interface SignalGroupInfo {
  groupId?: string;
  type?: string;
}

interface SignalAttachment {
  contentType?: string;
  filename?: string;
  id?: string;
  size?: number;
  width?: number;
  height?: number;
  caption?: string;
  voiceNote?: boolean;
}

export class SignalChannel extends BaseChannel {
  readonly id: string;
  readonly type = 'signal';
  private socket: Socket | null = null;
  private config: SignalConfig;
  private buffer = '';
  private pendingRequests = new Map<string, {
    resolve: (value: JsonRpcResponse) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 5000;
  private requestId = 0;

  constructor(config: SignalConfig) {
    super();
    this.id = config.id;
    this.config = config;
  }

  async connect(): Promise<void> {
    const logger = getLogger();

    if (this.socket) {
      logger.warn({ channelId: this.id }, 'Signal already connected');
      return;
    }

    logger.info({ channelId: this.id, socketPath: this.config.socketPath }, 'Connecting to signal-cli');

    return new Promise((resolve, reject) => {
      this.socket = createConnection(this.config.socketPath);

      this.socket.on('connect', () => {
        logger.info({ channelId: this.id }, 'Connected to signal-cli socket');
        this.reconnectAttempts = 0;
        this.emitConnect();
        resolve();
      });

      this.socket.on('data', (data) => {
        this.handleData(data.toString());
      });

      this.socket.on('error', (error) => {
        logger.error({ channelId: this.id, error }, 'signal-cli socket error');
        if (!this._connected) {
          reject(error);
        } else {
          this.emitError(error);
        }
        this.handleDisconnect();
      });

      this.socket.on('close', () => {
        logger.info({ channelId: this.id }, 'signal-cli socket closed');
        this.handleDisconnect();
      });

      this.socket.on('end', () => {
        logger.info({ channelId: this.id }, 'signal-cli socket ended');
        this.handleDisconnect();
      });
    });
  }

  private handleDisconnect(): void {
    if (this.socket) {
      this.socket = null;
      this.emitDisconnect();
    }

    // Clean up pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Connection lost'));
      this.pendingRequests.delete(id);
    }

    // Attempt reconnection
    if (this.reconnectAttempts < this.maxReconnectAttempts && this._connected) {
      this.reconnectAttempts++;
      const logger = getLogger();
      logger.info(
        { channelId: this.id, attempt: this.reconnectAttempts },
        'Attempting to reconnect to signal-cli'
      );
      setTimeout(() => this.connect().catch(() => {}), this.reconnectDelay);
    }
  }

  private handleData(data: string): void {
    const logger = getLogger();
    this.buffer += data;

    // Process complete JSON messages (newline-delimited)
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const message = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;
        this.handleMessage(message);
      } catch (error) {
        logger.error({ error, line }, 'Failed to parse signal-cli message');
      }
    }
  }

  private handleMessage(message: JsonRpcResponse | JsonRpcNotification): void {
    const logger = getLogger();

    // Handle responses to our requests
    if ('id' in message && message.id && this.pendingRequests.has(message.id)) {
      const pending = this.pendingRequests.get(message.id)!;
      this.pendingRequests.delete(message.id);
      clearTimeout(pending.timeout);

      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message as JsonRpcResponse);
      }
      return;
    }

    // Handle notifications (incoming messages)
    if ('method' in message && message.method === 'receive') {
      const envelope = message.params?.envelope as SignalEnvelope | undefined;
      if (envelope) {
        const incoming = this.envelopeToIncoming(envelope);
        if (incoming && this.isAllowed(incoming)) {
          this.emitMessage(incoming);
        }
      }
    } else {
      logger.debug({ method: (message as JsonRpcNotification).method }, 'signal-cli notification');
    }
  }

  private async sendRequest(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.socket) {
      throw new Error('Signal not connected');
    }

    const id = `${++this.requestId}`;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params: {
        account: this.config.account,
        ...params,
      },
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('Request timeout'));
      }, 30000);

      this.pendingRequests.set(id, {
        resolve: (response) => resolve(response.result),
        reject,
        timeout,
      });

      this.socket!.write(JSON.stringify(request) + '\n', (error) => {
        if (error) {
          clearTimeout(timeout);
          this.pendingRequests.delete(id);
          reject(error);
        }
      });
    });
  }

  async disconnect(): Promise<void> {
    const logger = getLogger();

    if (!this.socket) {
      return;
    }

    logger.info({ channelId: this.id }, 'Disconnecting from signal-cli');

    this.maxReconnectAttempts = 0; // Prevent reconnection
    this.socket.destroy();
    this.socket = null;
    this.emitDisconnect();
  }

  async send(message: OutgoingMessage): Promise<void> {
    if (!this.socket) {
      throw new Error('Signal not connected');
    }

    const logger = getLogger();
    const recipient = message.peerId;
    const isGroup = recipient.startsWith('group:');

    logger.debug({ recipient, isGroup }, 'Sending Signal message');

    const params: Record<string, unknown> = {};

    if (isGroup) {
      params.groupId = recipient.replace('group:', '');
    } else {
      params.recipient = [recipient];
    }

    if (message.content.type === 'text') {
      params.message = message.content.text;

      // Add quote if replying
      if (message.replyTo) {
        const [timestamp, author] = message.replyTo.split(':');
        if (timestamp && author) {
          params.quoteTimestamp = parseInt(timestamp, 10);
          params.quoteAuthor = author;
        }
      }

      await this.sendRequest('send', params);
    } else if (message.content.type === 'image' || message.content.type === 'file' || message.content.type === 'audio') {
      const source = message.content.url ?? message.content.base64;

      if (source) {
        // For attachments, signal-cli expects file paths
        // If we have a data URL, we'd need to save it to a temp file first
        if (!source.startsWith('data:')) {
          params.attachment = [source];
        }

        // Add caption for images
        if (message.content.type === 'image' && message.content.caption) {
          params.message = message.content.caption;
        }

        await this.sendRequest('send', params);
      }
    }
  }

  private isAllowed(message: IncomingMessage): boolean {
    // If no restrictions, allow all
    if (!this.config.allowedUsers?.length && !this.config.allowedGroups?.length) {
      return true;
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

  private envelopeToIncoming(envelope: SignalEnvelope): IncomingMessage | null {
    const dataMessage = envelope.dataMessage;

    // Skip messages without content
    if (!dataMessage || (!dataMessage.message && !dataMessage.attachments?.length)) {
      return null;
    }

    const isGroup = !!dataMessage.groupInfo;
    const senderId = envelope.sourceNumber ?? envelope.sourceUuid ?? envelope.source ?? '';
    const peerId = isGroup && dataMessage.groupInfo?.groupId
      ? `group:${dataMessage.groupInfo.groupId}`
      : senderId;

    let content: IncomingMessage['content'];

    if (dataMessage.message) {
      content = { type: 'text', text: dataMessage.message } satisfies TextContent;
    } else if (dataMessage.attachments && dataMessage.attachments.length > 0) {
      const attachment = dataMessage.attachments[0]!;
      const mimeType = attachment.contentType ?? 'application/octet-stream';

      if (mimeType.startsWith('image/')) {
        const imageContent: IncomingMessage['content'] = {
          type: 'image',
          mimeType,
        };
        if (attachment.caption) {
          (imageContent as { caption?: string }).caption = attachment.caption;
        }
        content = imageContent;
      } else if (mimeType.startsWith('audio/') || attachment.voiceNote) {
        content = {
          type: 'audio',
          mimeType,
        };
      } else {
        content = {
          type: 'file',
          mimeType,
          filename: attachment.filename ?? 'attachment',
        };
      }
    } else {
      return null;
    }

    const result: IncomingMessage = {
      id: nanoid(16),
      channel: 'signal',
      peerKind: isGroup ? 'group' : 'user',
      peerId,
      senderId,
      content,
      timestamp: dataMessage.timestamp ?? envelope.timestamp ?? Date.now(),
      metadata: {
        sourceUuid: envelope.sourceUuid,
        sourceName: envelope.sourceName,
        sourceDevice: envelope.sourceDevice,
      },
    };

    // Add sender name if available
    if (envelope.sourceName) {
      result.senderName = envelope.sourceName;
    }

    // Add reply reference if present
    if (dataMessage.quote) {
      const quoteAuthor = dataMessage.quote.authorNumber ?? dataMessage.quote.authorUuid ?? dataMessage.quote.author;
      if (dataMessage.quote.id && quoteAuthor) {
        result.replyTo = `${dataMessage.quote.id}:${quoteAuthor}`;
      }
    }

    return result;
  }
}

/**
 * Create a Signal channel from config
 */
export function createSignalChannel(config: SignalConfig): SignalChannel {
  return new SignalChannel(config);
}
