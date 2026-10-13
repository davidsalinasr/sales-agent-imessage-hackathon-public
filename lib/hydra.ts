import { HydraDBClient } from "@hydradb/sdk";
import { OWNER } from "./persona";

let client: HydraDBClient | undefined;
const hydra = () => (client ??= new HydraDBClient({ token: process.env.HYDRA_DB_API_KEY! }));

const database = () => process.env.HYDRA_DB_DATABASE!;
const collection = () => process.env.HYDRA_DB_COLLECTION || "agent_memory";

// Queries without `collections` only hit the default collection, which connectors don't
// write to — so name the connector collections explicitly, plus the agent's own memory.
const searchCollections = () => [
  ...(process.env.HYDRA_DB_SEARCH_COLLECTIONS ?? "gmail,google_drive")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean),
  collection(),
];

/**
 * Searches connector knowledge (e.g. Gmail, Drive) plus the agent's own memories.
 * Returns HydraDB's model-ready Markdown rendering of the results.
 */
export async function recall(query: string, type: "knowledge" | "memory" | "all" = "all") {
  const wanted = type === "memory" ? [collection()] : searchCollections();
  // A collection only exists after its first write (agent_memory before the first `remember`).
  const existing = new Set((await hydra().databases.collections({ database: database() })).data?.collections ?? []);
  const collections = wanted.filter((c) => existing.has(c));
  if (collections.length === 0) return "No results (nothing stored yet).";

  const res = await hydra().query({
    query,
    database: database(),
    collections,
    type,
    queryBy: "hybrid",
    mode: "auto",
    maxResults: 10,
    graphContext: true,
    recencyBias: 0.3,
  });
  return renderResults(res.data);
}

// `metadata` on a memory item only takes fields declared in the database schema;
// free-form fields go in `additional_metadata`.
async function ingestMemory(item: Record<string, unknown>) {
  const res = await hydra().context.ingest({
    database: database(),
    collection: collection(),
    type: "memory",
    memories: JSON.stringify([{ infer: true, user_name: OWNER, ...item }]),
  });
  return res.data;
}

/** Writes a memory (e.g. an action the agent took) so it can be recalled later. */
export async function remember(text: string, details: Record<string, unknown> = {}) {
  return ingestMemory({
    text,
    additional_metadata: { source: "sales-agent-imessage", created_at: new Date().toISOString(), ...details },
  });
}

/**
 * Stores one iMessage exchange as memory. With `infer`, HydraDB extracts the durable
 * facts and preferences from it and reconciles them with what it already knows, which
 * is how the agent gets smarter the more its owner texts it.
 */
export async function rememberExchange(user: string, assistant: string, details: { chatId: string; turnId: string }) {
  return ingestMemory({
    id: `imessage_${details.turnId}`,
    title: `iMessage: ${user.slice(0, 80)}`,
    user_assistant_pairs: [{ user, assistant }],
    custom_instructions:
      `This is ${OWNER} texting their assistant. Extract durable facts and preferences: people and their roles, companies and deal status, commitments and deadlines, what they like or dislike in how things are done (tone, length, language, tools), and decisions they made. Ignore greetings, small talk and one-off phrasing.`,
    additional_metadata: {
      source: "imessage",
      chat_id: details.chatId,
      turn_id: details.turnId,
      created_at: new Date().toISOString(),
    },
  });
}

export function renderResults(data: unknown): string {
  if (typeof data === "string") return data;
  if (data && typeof data === "object" && "llmPrompt" in data && typeof data.llmPrompt === "string") return data.llmPrompt;
  return "No results.";
}

