/**
 * findings.md P2:195 — zod schemas for every `GatewayResponse.result` shape
 * returned by a registered gateway method.
 *
 * Before this landed, `GatewayResponse.result` was typed as `unknown` and
 * every caller did ad-hoc `'key' in result` narrowing. That pattern was the
 * root cause of the P2:46 auth-check bug (a response of `{ authenticated:
 * false }` passed an `'authenticated' in result` check and silently entered
 * chat mode). It also meant a handler that accidentally returned the wrong
 * shape — say, `{ pong: false }` from a refactor — would ship malformed
 * data to clients with no runtime complaint.
 *
 * The fix: one zod schema per method. The router validates handler output
 * against its schema before sending the response (see `registerTypedMethod`
 * in `router.ts`); clients validate incoming results with the same schemas
 * instead of structural checks.
 */

import { z } from 'zod';

export const AuthResultSchema = z.object({
  authenticated: z.literal(true),
  connectionId: z.string(),
});
export type AuthResult = z.infer<typeof AuthResultSchema>;

export const PingResultSchema = z.object({
  pong: z.literal(true),
  timestamp: z.number(),
});
export type PingResult = z.infer<typeof PingResultSchema>;

export const EchoResultSchema = z.object({
  echo: z.unknown(),
});
export type EchoResult = z.infer<typeof EchoResultSchema>;

export const StatusResultSchema = z.object({
  status: z.string(),
  timestamp: z.number(),
  uptime: z.number(),
});
export type StatusResult = z.infer<typeof StatusResultSchema>;

export const SetAgentResultSchema = z.object({
  success: z.literal(true),
  agentId: z.string(),
});
export type SetAgentResult = z.infer<typeof SetAgentResultSchema>;

// Matches `TokenUsage` in src/types/message.ts but keeps all three fields
// optional: the mock agent in test/gateway-behavioral.test.ts returns only
// `input` + `output`, and some provider paths omit `total` when the SDK
// doesn't expose it (Anthropic streaming, for instance).
const TokenUsageSchema = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  total: z.number().optional(),
});

export const ChatResultSchema = z.object({
  response: z.string(),
  sessionKey: z.string(),
  tokenUsage: TokenUsageSchema.optional(),
});
export type ChatResult = z.infer<typeof ChatResultSchema>;

/**
 * Map of built-in gateway method name → result schema. The router validates
 * every handler output against the entry for that method before forwarding.
 * Callers can look up the schema by method name and call `.parse()` /
 * `.safeParse()` on incoming `response.result`.
 */
export const GatewayResultSchemas = {
  auth: AuthResultSchema,
  ping: PingResultSchema,
  echo: EchoResultSchema,
  status: StatusResultSchema,
  setAgent: SetAgentResultSchema,
  chat: ChatResultSchema,
} as const;

export type GatewayMethodName = keyof typeof GatewayResultSchemas;
export type GatewayResultFor<M extends GatewayMethodName> = z.infer<
  (typeof GatewayResultSchemas)[M]
>;

/** Discriminated union of every built-in method result. Clients that don't
 * know which method produced a response can iterate this union with zod's
 * `.safeParse()` to find the matching shape. */
export type GatewayResult =
  | AuthResult
  | PingResult
  | EchoResult
  | StatusResult
  | SetAgentResult
  | ChatResult;
