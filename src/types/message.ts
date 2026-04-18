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

export interface ImageContent {
  type: 'image';
  url?: string;
  base64?: string;
  mimeType: string;
  caption?: string;
}

export interface FileContent {
  type: 'file';
  url?: string;
  base64?: string;
  mimeType: string;
  filename: string;
}

export interface AudioContent {
  type: 'audio';
  url?: string;
  base64?: string;
  mimeType: string;
  duration?: number;
}

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
