import LinqAPIV3 from "@linqapp/sdk";
import type { MessageReceivedWebhookEvent, ReactionAddedWebhookEvent } from "@linqapp/sdk/resources/webhooks";
import type { ReactionType } from "@linqapp/sdk/resources/shared";
import { isPreviewableUrl } from "./guard";

// Reads LINQ_API_V3_API_KEY and LINQ_WEBHOOK_SECRET from the environment.
// Created lazily so builds don't need credentials.
let client: LinqAPIV3 | undefined;
const linq = () => (client ??= new LinqAPIV3());

/** Verifies the Standard Webhooks signature and parses the payload. Throws on a bad signature. */
export function verifyWebhook(rawBody: string, headers: Headers) {
  return linq().webhooks.unwrap(rawBody, { headers: Object.fromEntries(headers) });
}

export function isMessageReceived(event: { event_type: string }): event is MessageReceivedWebhookEvent {
  return event.event_type === "message.received";
}

export function isReactionAdded(event: { event_type: string }): event is ReactionAddedWebhookEvent {
  return event.event_type === "reaction.added";
}

export type Reaction = Extract<ReactionType, "like" | "love" | "laugh" | "emphasize">;

/** Adds a tapback to a message. Best-effort, like typing indicators. */
export async function react(messageId: string, type: Reaction) {
  try {
    await linq().messages.addReaction(messageId, { operation: "add", type });
  } catch (err) {
    console.warn("[linq] reaction failed", (err as Error).message);
  }
}

/** A message a tapback points at: its text plus where it lives and who sent it, so callers can check both. */
export async function getMessage(messageId: string): Promise<{ text: string; chatId: string; fromMe: boolean } | null> {
  try {
    const m = await linq().messages.retrieve(messageId);
    const text = (m.parts ?? []).flatMap((p) => (p.type === "text" ? [p.value] : [])).join("\n");
    return { text, chatId: m.chat_id, fromMe: m.is_from_me };
  } catch {
    return null;
  }
}

export function textOf(event: MessageReceivedWebhookEvent): string {
  return event.data.parts
    .flatMap((p) => (p.type === "text" ? [p.value] : []))
    .join("\n")
    .trim();
}

/** Sends one bubble and returns its message id. */
export async function sendText(chatId: string, text: string): Promise<string> {
  const res = await linq().chats.messages.send(chatId, {
    message: { parts: [{ type: "text", value: text }] },
  });
  return res.message.id;
}

const MAX_BUBBLES = 5;

const URL_LINE = /^https?:\/\/\S+$/;

/**
 * Splits a reply into iMessage bubbles on blank lines; extra paragraphs fold into the last
 * bubble. A line that is only a link to a trusted host (Docs, Drive, Gmail, Calendly) becomes
 * its own bubble so iMessage renders a preview; other links stay inline and are never fetched.
 */
export function toBubbles(text: string): string[] {
  const parts = text
    .split(/\n\s*\n/)
    .flatMap((para) => {
      const out: string[] = [];
      let buf: string[] = [];
      for (const line of para.split("\n")) {
        if (URL_LINE.test(line.trim()) && isPreviewableUrl(line.trim())) {
          if (buf.length) out.push(buf.join("\n"));
          out.push(line.trim());
          buf = [];
        } else buf.push(line);
      }
      if (buf.length) out.push(buf.join("\n"));
      return out;
    })
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length <= MAX_BUBBLES) return parts;
  return [...parts.slice(0, MAX_BUBBLES - 1), parts.slice(MAX_BUBBLES - 1).join("\n\n")];
}

/** Sends a reply as separate bubbles with a short, length-based typing pause between them. Returns their ids. */
export async function sendBubbles(chatId: string, text: string): Promise<string[]> {
  const ids: string[] = [];
  for (const [i, bubble] of toBubbles(text).entries()) {
    if (i > 0) {
      await typing(chatId, true);
      await new Promise((r) => setTimeout(r, Math.min(500 + bubble.length * 12, 2000)));
    }
    ids.push(await sendText(chatId, bubble));
  }
  return ids;
}

// Typing indicators are best-effort; never let them break a reply.
export async function typing(chatId: string, on: boolean) {
  try {
    await (on ? linq().chats.typing.start(chatId) : linq().chats.typing.stop(chatId));
  } catch (err) {
    console.warn("[linq] typing indicator failed", (err as Error).message);
  }
}
