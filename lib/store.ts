import { Redis } from "@upstash/redis";

// Upstash in production; an in-memory fallback keeps local dev dependency-free.
const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
const redis = url && token ? new Redis({ url, token }) : null;
const mem = new Map<string, { value: unknown; expires: number }>();

// Serverless instances don't share memory, so dedupe and approvals need Redis in production.
function kv() {
  if (!redis && process.env.VERCEL_ENV === "production") {
    throw new Error("Upstash Redis is required in production (set KV_REST_API_URL and KV_REST_API_TOKEN)");
  }
  return redis;
}

function memGet<T>(key: string): T | undefined {
  const hit = mem.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) {
    mem.delete(key);
    return undefined;
  }
  return hit.value as T;
}

function memSet(key: string, value: unknown, ttlSeconds: number) {
  mem.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
}

export type Turn = { role: "user" | "assistant"; content: string };
const HISTORY_LIMIT = 20;
const DAY = 60 * 60 * 24;

/** Returns true the first time an event id is seen (Linq delivers at least once). */
export async function claimEvent(eventId: string): Promise<boolean> {
  const key = `event:${eventId}`;
  const r = kv();
  if (r) return (await r.set(key, 1, { nx: true, ex: DAY })) === "OK";
  if (memGet(key)) return false;
  memSet(key, 1, DAY);
  return true;
}

/** Counts a turn against the chat's hourly budget; false once it's spent. */
export async function withinRateLimit(chatId: string, perHour = 30): Promise<boolean> {
  const key = `rate:${chatId}:${Math.floor(Date.now() / 3_600_000)}`;
  const r = kv();
  if (r) {
    const n = await r.incr(key);
    if (n === 1) await r.expire(key, 60 * 60);
    return n <= perHour;
  }
  const n = (memGet<number>(key) ?? 0) + 1;
  memSet(key, n, 60 * 60);
  return n <= perHour;
}

export async function getHistory(chatId: string): Promise<Turn[]> {
  const key = `history:${chatId}`;
  const r = kv();
  if (r) return (await r.get<Turn[]>(key)) ?? [];
  return memGet<Turn[]>(key) ?? [];
}

export async function appendHistory(chatId: string, ...turns: Turn[]) {
  const key = `history:${chatId}`;
  const next = [...(await getHistory(chatId)), ...turns].slice(-HISTORY_LIMIT);
  const r = kv();
  if (r) await r.set(key, next, { ex: DAY * 7 });
  else memSet(key, next, DAY * 7);
}

/** The owner's 1:1 chats with the agent; reactions anywhere else are ignored. */
export async function addOwnerChat(chatId: string) {
  const r = kv();
  if (r) await r.sadd("owner_chats", chatId);
  else memSet(`owner_chat:${chatId}`, 1, DAY * 365);
}

export async function isOwnerChat(chatId: string): Promise<boolean> {
  const r = kv();
  if (r) return (await r.sismember("owner_chats", chatId)) === 1;
  return !!memGet(`owner_chat:${chatId}`);
}

/**
 * An action the agent proposed and is waiting for the owner to approve. `input` is exactly
 * what will run: approval executes the stored proposal, never fresh model output.
 */
export type PendingAction = { input: unknown; preview: string; turnId: string; at: number };

const pendingKey = (chatId: string, tool: string) => `pending:${chatId}:${tool}`;
const APPROVAL_TTL = 60 * 60;

export async function setPending(chatId: string, tool: string, action: PendingAction) {
  const r = kv();
  if (r) await r.set(pendingKey(chatId, tool), action, { ex: APPROVAL_TTL });
  else memSet(pendingKey(chatId, tool), action, APPROVAL_TTL);
}

/** Atomically removes and returns a pending action, so it can run at most once. */
export async function takePending(chatId: string, tool: string): Promise<PendingAction | null> {
  const r = kv();
  if (r) return (await r.getdel<PendingAction>(pendingKey(chatId, tool))) ?? null;
  const action = memGet<PendingAction>(pendingKey(chatId, tool)) ?? null;
  mem.delete(pendingKey(chatId, tool));
  return action;
}

/** Drops every pending proposal in a chat: anything but a plain approval cancels them. */
export async function clearPending(chatId: string, tools: readonly string[]) {
  const r = kv();
  if (r) await r.del(...tools.map((t) => pendingKey(chatId, t)), `last_proposal:${chatId}`);
  else for (const key of [...tools.map((t) => pendingKey(chatId, t)), `last_proposal:${chatId}`]) mem.delete(key);
}

/**
 * Records a proposal once its preview has reached the owner: the turn that proposed it (what a
 * plain "yes" approves) and the ids of the messages sent (what a 👍 on one of them approves).
 */
export async function markProposalDelivered(chatId: string, turnId: string, messageIds: string[]) {
  const r = kv();
  if (r) {
    await r.set(`last_proposal:${chatId}`, turnId, { ex: APPROVAL_TTL });
    if (messageIds.length) {
      await r.hset(`proposal_msgs:${chatId}`, Object.fromEntries(messageIds.map((id) => [id, turnId])));
      await r.expire(`proposal_msgs:${chatId}`, APPROVAL_TTL);
    }
  } else {
    memSet(`last_proposal:${chatId}`, turnId, APPROVAL_TTL);
    for (const id of messageIds) memSet(`proposal_msg:${chatId}:${id}`, turnId, APPROVAL_TTL);
  }
}

/** The turn of the latest proposal the owner has seen, if any. */
export async function lastProposalTurn(chatId: string): Promise<string | null> {
  const r = kv();
  if (r) return (await r.get<string>(`last_proposal:${chatId}`)) ?? null;
  return memGet<string>(`last_proposal:${chatId}`) ?? null;
}

/** The turn that proposed the action a given agent message belongs to, if it was a proposal message. */
export async function proposalTurnOf(chatId: string, messageId: string): Promise<string | null> {
  const r = kv();
  if (r) return (await r.hget<string>(`proposal_msgs:${chatId}`, messageId)) ?? null;
  return memGet<string>(`proposal_msg:${chatId}:${messageId}`) ?? null;
}
