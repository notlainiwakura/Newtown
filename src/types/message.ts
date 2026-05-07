/**
 * Message types for agent communication
 */

import type { ChannelType, PeerKind } from './session.js';

export interface IncomingMessage {
  id: string;
  channel: ChannelType;
  peerKind: PeerKind;
  peerId: string;
  senderId: string;
  senderName?: string;
  content: MessageContent;
  replyTo?: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface OutgoingMessage {
  id: string;
  channel: ChannelType;
  peerId: string;
  content: MessageContent;
  replyTo?: string;
  metadata?: Record<string, unknown>;
}

export type MessageContent =
  | TextContent
  | ImageContent
  | FileContent
  | AudioContent;

export interface TextContent {
  type: 'text';
  text: string;
}

/**
 * findings.md P2:199 — media payloads require at least one pointer to
 * the bytes. The legacy shape had both `url?` and `base64?` optional,
 * which TypeScript accepted as `{ type: 'image', mimeType: 'image/png' }`
 * with no data pointer at all, forcing every downstream consumer
 * (agent/conversation.ts et al) into defensive null checks that we
 * sometimes forgot. Model the constraint at the type level: either
 * `url` is a string, or `base64` is a string. Both may be populated
 * (e.g. a channel that caches the download locally) but neither alone
 * is allowed.
 */
export type MediaPayload =
  | { url: string; base64?: string }
  | { url?: string; base64: string };

export type ImageContent = MediaPayload & {
  type: 'image';
  mimeType: string;
  caption?: string;
};

export type FileContent = MediaPayload & {
  type: 'file';
  mimeType: string;
  filename: string;
};

export type AudioContent = MediaPayload & {
  type: 'audio';
  mimeType: string;
  duration?: number;
};

export interface AgentRequest {
  sessionKey: string;
  message: IncomingMessage;
}

export interface AgentResponse {
  sessionKey: string;
  messages: OutgoingMessage[];
  tokenUsage?: TokenUsage;
}

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
}
