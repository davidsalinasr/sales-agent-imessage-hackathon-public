import { after } from "next/server";
import {
  isMessageReceived,
  isReactionAdded,
  messageText,
  react,
  sendBubbles,
  sendText,
  textOf,
  typing,
  verifyWebhook,
} from "@/lib/linq";
import { appendHistory, claimEvent, getHistory } from "@/lib/store";
import { runAgent, type AgentContext } from "@/lib/agent";
import { rememberExchange } from "@/lib/hydra";
import { OWNER } from "@/lib/persona";

export const maxDuration = 300;

// If the agent hasn't reacted or replied by now, acknowledge with a 👍 so the owner knows it's working.
const AUTO_ACK_MS = 4000;
// Linq's typing indicator expires after ~90s; refresh it during long runs.
const TYPING_REFRESH_MS = 60_000;

const TAPBACK_EMOJI: Record<string, string> = {
  like: "👍",
  love: "❤️",
  dislike: "👎",
  laugh: "😂",
  emphasize: "‼️",
  question: "❓",
};

function isOwner(handle: string | undefined) {
  // Comma-separated: iMessage may send from the Apple ID email or the phone number.
  const owners = (process.env.OWNER_HANDLE ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (!owners.length) return true;
  const ok = !!handle && owners.includes(handle.toLowerCase());
  if (!ok) console.log("[linq] ignored sender", handle);
  return ok;
}

export async function POST(req: Request) {
  const raw = await req.text();

  let event;
  try {
    event = verifyWebhook(raw, req.headers);
  } catch {
    return new Response("invalid signature", { status: 401 });
  }

  let chatId: string;
  let ctx: AgentContext;
  let text: string;

  if (isMessageReceived(event)) {
    const msg = event.data;
    if (msg.direction !== "inbound" || msg.reconciled_at) return new Response("ignored");
    if (!isOwner(msg.sender_handle.handle)) return new Response("ignored");
    text = textOf(event);
    if (!text) return new Response("ignored");
    chatId = msg.chat.id;
    ctx = { chatId, turnId: msg.id, reactTo: msg.id, ack: { reacted: false } };
  } else if (isReactionAdded(event)) {
    // A tapback from the owner on one of our messages, e.g. 👍 to approve a proposed action.
    const r = event.data;
    if (r.is_from_me || !r.chat_id || !r.message_id) return new Response("ignored");
    if (!isOwner(r.from_handle?.handle ?? r.from)) return new Response("ignored");
    const emoji = r.reaction_type === "custom" ? r.custom_emoji : TAPBACK_EMOJI[r.reaction_type];
    if (!emoji) return new Response("ignored");
    const target = await messageText(r.message_id);
    text = `[${OWNER} reacted ${emoji} to: "${target.slice(0, 300)}"]`;
    chatId = r.chat_id;
    ctx = { chatId, turnId: event.event_id, ack: { reacted: true } };
  } else {
    return new Response("ignored");
  }

  if (!(await claimEvent(event.event_id))) return new Response("duplicate");

  // Ack immediately so Linq doesn't retry; do the work after the response.
  after(async () => {
    await typing(chatId, true);
    const autoAck = setTimeout(() => {
      if (ctx.reactTo && !ctx.ack.reacted) {
        ctx.ack.reacted = true;
        void react(ctx.reactTo, "like");
      }
    }, AUTO_ACK_MS);
    const keepTyping = setInterval(() => void typing(chatId, true), TYPING_REFRESH_MS);

    try {
      const reply = await runAgent(await getHistory(chatId), text, ctx);
      clearTimeout(autoAck);
      clearInterval(keepTyping);
      // An empty reply is fine: sometimes a tapback is the whole answer.
      if (reply) await sendBubbles(chatId, reply);
      await appendHistory(chatId, { role: "user", content: text }, { role: "assistant", content: reply || "(reacted)" });
      // Long-term memory: every exchange goes to HydraDB (after the reply, so it never adds latency).
      await rememberExchange(text, reply || "(reacted)", { chatId, turnId: ctx.turnId }).catch((err) =>
        console.error("[hydra] failed to store exchange", err),
      );
    } catch (err) {
      console.error("[agent] failed", err);
      await sendText(chatId, "Something broke on my side, try again in a moment.");
    } finally {
      clearTimeout(autoAck);
      clearInterval(keepTyping);
      await typing(chatId, false);
    }
  });

  return new Response("ok");
}
