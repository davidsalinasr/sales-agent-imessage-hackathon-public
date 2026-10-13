import LinqAPIV3 from "@linqapp/sdk";
import type { MessageReceivedWebhookEvent, ReactionAddedWebhookEvent } from "@linqapp/sdk/resources/webhooks";
import type { ReactionType } from "@linqapp/sdk/resources/shared";

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
    console.warn("[linq] reaction failed", err);
  }
}

/** Text of one of our own earlier messages, so a tapback on it can be given context. */
export async function messageText(messageId: string): Promise<string> {
  try {
    const m = await linq().messages.retrieve(messageId);
    return (m.parts ?? []).flatMap((p) => (p.type === "text" ? [p.value] : [])).join("\n");
  } catch {
    return "";
  }
}

export function textOf(event: MessageReceivedWebhookEvent): string {
  return event.data.parts
    .flatMap((p) => (p.type === "text" ? [p.value] : []))
    .join("\n")
    .trim();
}

export async function sendText(chatId: string, text: string) {
  await linq().chats.messages.send(chatId, {
    message: { parts: [{ type: "text", value: text }] },
  });
}

const MAX_BUBBLES = 5;

const URL_LINE = /^https?:\/\/\S+$/;

/**
 * Splits a reply into iMessage bubbles on blank lines; extra paragraphs fold into the last
 * bubble. A line that is only a URL becomes its own bubble so iMessage renders a link preview.
 */
export function toBubbles(text: string): string[] {
  const parts = text
    .split(/\n\s*\n/)
    .flatMap((para) => {
      const out: string[] = [];
      let buf: string[] = [];
      for (const line of para.split("\n")) {
        if (URL_LINE.test(line.trim())) {
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

/** Sends a reply as separate bubbles with a short, length-based typing pause between them. */
export async function sendBubbles(chatId: string, text: string) {
  const bubbles = toBubbles(text);
  for (const [i, bubble] of bubbles.entries()) {
    if (i > 0) {
      await typing(chatId, true);
      await new Promise((r) => setTimeout(r, Math.min(500 + bubble.length * 12, 2000)));
    }
    await sendText(chatId, bubble);
  }
}

// Typing indicators are best-effort; never let them break a reply.
export async function typing(chatId: string, on: boolean) {
  try {
    await (on ? linq().chats.typing.start(chatId) : linq().chats.typing.stop(chatId));
  } catch (err) {
    console.warn("[linq] typing indicator failed", err);
  }
}
