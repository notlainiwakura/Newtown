/**
 * Base channel interface for all messaging platform connectors
 */

import type { IncomingMessage, OutgoingMessage } from '../types/message.js';

export interface ChannelConfig {
  id: string;
  type: string;
  enabled: boolean;
  agentId: string;
}

export interface ChannelEvents {
  onMessage: (message: IncomingMessage) => Promise<void>;
  onError: (error: Error) => void;
  onConnect: () => void;
  onDisconnect: () => void;
}

export interface Channel {
  readonly id: string;
  readonly type: string;
  readonly connected: boolean;

  /**
   * Initialize and connect the channel
   */
  connect(): Promise<void>;

  /**
   * Disconnect and cleanup
   */
  disconnect(): Promise<void>;

  /**
   * Send a message through this channel
   */
  send(message: OutgoingMessage): Promise<void>;

  /**
   * Set event handlers
   */
  setEventHandlers(handlers: Partial<ChannelEvents>): void;
}

export abstract class BaseChannel implements Channel {
  abstract readonly id: string;
  abstract readonly type: string;
  protected _connected = false;
  protected handlers: Partial<ChannelEvents> = {};

  get connected(): boolean {
    return this._connected;
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract send(message: OutgoingMessage): Promise<void>;

  setEventHandlers(handlers: Partial<ChannelEvents>): void {
    this.handlers = { ...this.handlers, ...handlers };
  }

  protected emitMessage(message: IncomingMessage): void {
    this.handlers.onMessage?.(message).catch((error) => {
      this.handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
    });
  }

  protected emitError(error: Error): void {
    this.handlers.onError?.(error);
  }

  protected emitConnect(): void {
    this._connected = true;
    this.handlers.onConnect?.();
  }

  protected emitDisconnect(): void {
    this._connected = false;
    this.handlers.onDisconnect?.();
  }
}
