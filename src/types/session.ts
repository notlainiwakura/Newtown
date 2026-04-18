/**
 * Session types for conversation state management
 */

export interface Session {
  key: string;
  agentId: string;
  channel: ChannelType;
  peerKind: PeerKind;
  peerId: string;
  createdAt: number;
  updatedAt: number;
  tokenCount: number;
  transcriptPath?: string;
  flags: SessionFlags;
}

export type ChannelType =
  | 'telegram'
  | 'whatsapp'
  | 'discord'
  | 'signal'
  | 'slack'
  | 'cli'
  | 'web';

export type PeerKind = 'user' | 'group' | 'channel';

export interface SessionFlags {
  summarized?: boolean;
  archived?: boolean;
  muted?: boolean;
}

export interface SessionCreateInput {
  agentId: string;
  channel: ChannelType;
  peerKind: PeerKind;
  peerId: string;
}

export interface SessionUpdateInput {
  tokenCount?: number;
  transcriptPath?: string;
  flags?: Partial<SessionFlags>;
}

export interface Credential {
  key: string;
  value: Buffer;
  createdAt: number;
}
