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

/**
 * findings.md P2:215 — `'peer'` covers inter-character traffic that arrives
 * over the interlink (direct peer-to-peer messages and letter-as-chat
 * delivery). Before this label existed, those sessions were stamped as
 * `'web'`, which meant any future channel-filtered query (analytics, budget,
 * hot-memories) would silently conflate peer traffic with real user web
 * traffic. The peerId format was the only distinguishing field, which is
 * brittle. `'interlink'` is reserved for a follow-up (the few channels that
 * open a typed interlink session rather than forwarding a user message).
 */
export type ChannelType =
  | 'telegram'
  | 'whatsapp'
  | 'discord'
  | 'signal'
  | 'slack'
  | 'cli'
  | 'web'
  | 'peer';

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
