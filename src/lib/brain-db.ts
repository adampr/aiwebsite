import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

// Read-only admin queries against the brain's own tables (shared Postgres,
// prefix BRAIN_DB_TABLE_PREFIX). The brain owns these schemas — never write
// to them from the site; the only brain table the site writes is
// brain_memories (seed SQL + nightly crawl). Timestamps in brain tables are
// TEXT ISO-8601 strings, so they sort correctly as text.
const PREFIX = process.env.BRAIN_DB_TABLE_PREFIX || "brain_";
const T = (name: string) => sql.raw(`"${PREFIX}${name}"`);

async function rows<Row>(query: ReturnType<typeof sql>): Promise<Row[]> {
  const result = await db.execute(query);
  return result as unknown as Row[];
}

// Channel is inferred from the sessionId shape each site route stamps:
// webchat "tron_…", SMS "sms-<phone>", email "email-<addr>" / "email2-…".
export type Channel = "chat" | "sms" | "email";
const CHANNEL_PATTERNS: Record<Channel, string> = {
  chat: "tron\\_%", // tron_ prefix; \_ escapes LIKE's any-char underscore
  sms: "sms-%",
  email: "email%",
};

export function channelOfSession(sessionId: string): Channel | "other" {
  if (sessionId.startsWith("tron_")) return "chat";
  if (sessionId.startsWith("sms-")) return "sms";
  if (sessionId.startsWith("email")) return "email";
  return "other";
}

export interface SessionSummary {
  sessionId: string;
  requesterId: string | null;
  messageCount: number;
  firstAt: string;
  lastAt: string;
  preview: string;
}

export async function listBrainSessions(opts: {
  channel?: Channel;
  limit?: number;
  offset?: number;
}): Promise<SessionSummary[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;
  const where = opts.channel
    ? sql`WHERE m.session_id LIKE ${CHANNEL_PATTERNS[opts.channel]}`
    : sql``;
  return rows<SessionSummary>(sql`
    SELECT
      m.session_id AS "sessionId",
      MAX(m.requester_id) AS "requesterId",
      COUNT(*)::int AS "messageCount",
      MIN(m.created_at) AS "firstAt",
      MAX(m.created_at) AS "lastAt",
      LEFT(MIN(CASE WHEN m.role = 'user' THEN m.created_at || '|' || m.content END), 240) AS "preview"
    FROM ${T("messages")} m
    ${where}
    GROUP BY m.session_id
    ORDER BY MAX(m.created_at) DESC
    LIMIT ${limit} OFFSET ${offset}
  `).then((list) =>
    list.map((s) => ({
      ...s,
      // strip the "createdAt|" ordering key prepended above
      preview: (s.preview ?? "").split("|").slice(1).join("|"),
    }))
  );
}

export interface BrainMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  createdAt: string;
}

export async function getBrainSessionMessages(
  sessionId: string
): Promise<BrainMessage[]> {
  return rows<BrainMessage>(sql`
    SELECT id, session_id AS "sessionId", role, content, created_at AS "createdAt"
    FROM ${T("messages")}
    WHERE session_id = ${sessionId}
    ORDER BY created_at ASC
    LIMIT 500
  `);
}

export interface UsageTotals {
  events: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export async function getBrainUsageTotals(days: number): Promise<UsageTotals> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  // Token SUMs use ::float8 (returned as a JS number) not ::int — a 30-day
  // total can exceed int4's 2.15B and would throw "integer out of range".
  const [row] = await rows<UsageTotals>(sql`
    SELECT
      COUNT(*)::int AS "events",
      COALESCE(SUM(input_tokens), 0)::float8 AS "inputTokens",
      COALESCE(SUM(output_tokens), 0)::float8 AS "outputTokens",
      COALESCE(SUM(cost_usd), 0)::float8 AS "costUsd"
    FROM ${T("usage_events")}
    WHERE created_at >= ${since}
  `);
  return row ?? { events: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

export interface UsageByModel extends UsageTotals {
  model: string;
}

export async function getBrainUsageByModel(days: number): Promise<UsageByModel[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  return rows<UsageByModel>(sql`
    SELECT
      model,
      COUNT(*)::int AS "events",
      COALESCE(SUM(input_tokens), 0)::float8 AS "inputTokens",
      COALESCE(SUM(output_tokens), 0)::float8 AS "outputTokens",
      COALESCE(SUM(cost_usd), 0)::float8 AS "costUsd"
    FROM ${T("usage_events")}
    WHERE created_at >= ${since}
    GROUP BY model
    ORDER BY SUM(cost_usd) DESC NULLS LAST
    LIMIT 20
  `);
}

export interface PhoneCall {
  id: string;
  callSid: string;
  direction: string;
  fromNumber: string;
  toNumber: string;
  status: string;
  purpose: string | null;
  transcript: string | null; // JSON text: [{role, text, at?}, …]
  startedAt: string;
  endedAt: string | null;
  requesterId: string | null;
}

export async function listPhoneCalls(limit = 50): Promise<PhoneCall[]> {
  return rows<PhoneCall>(sql`
    SELECT
      id, call_sid AS "callSid", direction, from_number AS "fromNumber",
      to_number AS "toNumber", status, purpose, transcript,
      started_at AS "startedAt", ended_at AS "endedAt",
      requester_id AS "requesterId"
    FROM ${T("phone_calls")}
    ORDER BY started_at DESC
    LIMIT ${Math.min(limit, 200)}
  `);
}

export interface MemoryRow {
  id: string;
  scope: string | null;
  kind: string | null;
  key: string | null;
  sourceType: string | null;
  importance: number | null;
  bytes: number;
  updatedAt: string | null;
}

export async function listBrainMemories(limit = 200): Promise<MemoryRow[]> {
  return rows<MemoryRow>(sql`
    SELECT
      id, scope, kind, key, source_type AS "sourceType", importance,
      LENGTH(value)::int AS bytes, updated_at AS "updatedAt"
    FROM ${T("memories")}
    ORDER BY updated_at DESC NULLS LAST
    LIMIT ${Math.min(limit, 1000)}
  `);
}

export interface MemoryStat {
  sourceType: string;
  count: number;
  totalBytes: number;
}

export async function getBrainMemoryStats(): Promise<MemoryStat[]> {
  return rows<MemoryStat>(sql`
    SELECT
      COALESCE(source_type, '(none)') AS "sourceType",
      COUNT(*)::int AS count,
      COALESCE(SUM(LENGTH(value)), 0)::float8 AS "totalBytes"
    FROM ${T("memories")}
    GROUP BY source_type
    ORDER BY count DESC
  `);
}

export interface RequesterSummary {
  requesterId: string;
  messageCount: number;
  sessionCount: number;
  firstAt: string;
  lastAt: string;
}

// Distinct external people the brain has talked to, keyed by requesterId
// ("+1312…" for SMS, "email:addr" for email; webchat has none).
export async function listBrainRequesters(): Promise<RequesterSummary[]> {
  return rows<RequesterSummary>(sql`
    SELECT
      requester_id AS "requesterId",
      COUNT(*)::int AS "messageCount",
      COUNT(DISTINCT session_id)::int AS "sessionCount",
      MIN(created_at) AS "firstAt",
      MAX(created_at) AS "lastAt"
    FROM ${T("messages")}
    WHERE requester_id IS NOT NULL AND requester_id <> ''
    GROUP BY requester_id
    ORDER BY MAX(created_at) DESC
    LIMIT 500
  `);
}
