import { Redis } from "@upstash/redis";

// Upstash in production; an in-memory fallback keeps local dev dependency-free.
const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
const redis = url && token ? new Redis({ url, token }) : null;
const mem = new Map<string, unknown>();

export type Turn = { role: "user" | "assistant"; content: string };
const HISTORY_LIMIT = 20;

/** Returns true the first time an event id is seen (Linq delivers at least once). */
export async function claimEvent(eventId: string): Promise<boolean> {
  const key = `event:${eventId}`;
  if (redis) return (await redis.set(key, 1, { nx: true, ex: 60 * 60 * 24 })) === "OK";
  if (mem.has(key)) return false;
  mem.set(key, 1);
  return true;
}

export async function getHistory(chatId: string): Promise<Turn[]> {
  const key = `history:${chatId}`;
  if (redis) return (await redis.get<Turn[]>(key)) ?? [];
  return (mem.get(key) as Turn[] | undefined) ?? [];
}

/** An action the agent proposed and is waiting for the owner to approve. */
export type PendingAction = { summary: string; messageId: string; at: number };
type PendingMap = Record<string, PendingAction>;

export async function getPending(chatId: string): Promise<PendingMap> {
  const key = `pending:${chatId}`;
  if (redis) return (await redis.get<PendingMap>(key)) ?? {};
  return (mem.get(key) as PendingMap | undefined) ?? {};
}

export async function setPending(chatId: string, tool: string, action: PendingAction | null) {
  const key = `pending:${chatId}`;
  const next = { ...(await getPending(chatId)) };
  if (action) next[tool] = action;
  else delete next[tool];
  if (redis) await redis.set(key, next, { ex: 60 * 60 * 24 });
  else mem.set(key, next);
}

export async function appendHistory(chatId: string, ...turns: Turn[]) {
  const key = `history:${chatId}`;
  const next = [...(await getHistory(chatId)), ...turns].slice(-HISTORY_LIMIT);
  if (redis) await redis.set(key, next, { ex: 60 * 60 * 24 * 7 });
  else mem.set(key, next);
}
