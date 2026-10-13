import { Composio } from "@composio/core";

let client: Composio | undefined;
const composio = () => (client ??= new Composio({ apiKey: process.env.COMPOSIO_API_KEY }));

// Only these slugs are reachable from the agent. Notably there is no send tool:
// the agent can draft email but never send it.
async function run(slug: string, args: Record<string, unknown>) {
  const res = await composio().tools.execute(slug, {
    userId: process.env.COMPOSIO_USER_ID!,
    arguments: args,
    dangerouslySkipVersionCheck: true,
  });
  if (!res.successful) throw new Error(`${slug} failed: ${res.error}`);
  return res.data;
}

export async function createGoogleDoc(title: string, markdown: string) {
  const data = await run("GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN", { title, markdown_text: markdown });
  const id = findString(data, ["documentId", "document_id", "id"]);
  return { id, url: id ? `https://docs.google.com/document/d/${id}/edit` : undefined, raw: id ? undefined : data };
}

export async function draftEmail(input: { to: string; subject: string; body: string; cc?: string[] }) {
  const data = await run("GMAIL_CREATE_EMAIL_DRAFT", {
    recipient_email: input.to,
    subject: input.subject,
    body: input.body,
    cc: input.cc ?? [],
  });
  const id = findString(data, ["draft_id", "id"]);
  return { draftId: id, url: "https://mail.google.com/mail/u/0/#drafts" };
}

export async function searchInbox(query: string, maxResults = 10) {
  const data = await run("GMAIL_FETCH_EMAILS", {
    query,
    max_results: maxResults,
    verbose: false,
    include_payload: false,
  });
  const messages = (data.messages as Array<Record<string, unknown>> | undefined) ?? [];
  return messages.map((m) => ({
    from: m.sender,
    subject: m.subject,
    date: m.messageTimestamp ?? m.internalDate,
    preview: m.preview ?? m.snippet,
    attachments: m.attachmentList,
  }));
}

// Composio wraps provider responses differently per tool; dig for the first matching key.
function findString(obj: unknown, keys: string[]): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    const v = (obj as Record<string, unknown>)[k];
    if (typeof v === "string" && v) return v;
  }
  for (const v of Object.values(obj)) {
    const found = findString(v, keys);
    if (found) return found;
  }
  return undefined;
}
