import { after } from "next/server";
import {
  getMessage,
  isMessageReceived,
  isReactionAdded,
  react,
  sendBubbles,
  sendText,
  textOf,
  typing,
  verifyWebhook,
} from "@/lib/linq";
import {
  addOwnerChat,
  appendHistory,
  claimEvent,
  clearPending,
  getHistory,
  isOwnerChat,
  lastProposalTurn,
  markProposalDelivered,
  proposalTurnOf,
  withinRateLimit,
} from "@/lib/store";
import { GATED_TOOLS, runAgent, type AgentContext } from "@/lib/agent";
import { isApproval, isOwner } from "@/lib/guard";
import { rememberExchange } from "@/lib/hydra";
import { OWNER } from "@/lib/persona";

export const maxDuration = 300;

// If the agent hasn't reacted or replied by now, acknowledge with a 👍 so the owner knows it's working.
const AUTO_ACK_MS = 4000;
// Linq's typing indicator expires after ~90s; refresh it during long runs.
const TYPING_REFRESH_MS = 60_000;
const MAX_INPUT_CHARS = 4000;

const TAPBACK_EMOJI: Record<string, string> = {
  like: "👍",
  love: "❤️",
  dislike: "👎",
  laugh: "😂",
  emphasize: "‼️",
  question: "❓",
};

const ignored = (why: string) => {
  console.log("[linq] ignored:", why);
  return new Response("ignored");
};

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
    // SMS sender ids can be spoofed, and group replies would reach everyone in the group.
    if (msg.service !== "iMessage") return ignored("not iMessage");
    if (msg.chat.is_group) return ignored("group chat");
    if (!isOwner(msg.sender_handle.handle)) return ignored("not the owner");
    text = textOf(event).slice(0, MAX_INPUT_CHARS);
    if (!text) return ignored("no text");
    chatId = msg.chat.id;
    ctx = {
      chatId,
      turnId: msg.id,
      reactTo: msg.id,
      ack: { reacted: false },
      approves: null,
      previews: {},
    };
    if (!(await claimEvent(event.event_id))) return new Response("duplicate");
    await addOwnerChat(chatId);
    // A plain "yes" approves the latest proposal the owner has seen; any other message cancels
    // pending proposals, so a stray "ok" later can't run something they moved on from.
    if (isApproval(text)) ctx.approves = await lastProposalTurn(chatId);
    else await clearPending(chatId, GATED_TOOLS);
  } else if (isReactionAdded(event)) {
    // A tapback from the owner on one of our messages, e.g. 👍 to approve a proposed action.
    const r = event.data;
    if (r.is_from_me || !r.chat_id || !r.message_id) return new Response("ignored");
    if (!isOwner(r.from_handle?.handle ?? r.from)) return ignored("not the owner");
    const emoji = r.reaction_type === "custom" ? r.custom_emoji : TAPBACK_EMOJI[r.reaction_type];
    if (!emoji) return new Response("ignored");
    if (!(await isOwnerChat(r.chat_id))) return ignored("reaction outside the owner's 1:1 chat");
    if (!(await claimEvent(event.event_id))) return new Response("duplicate");
    // Only tapbacks on the agent's own messages in this chat count.
    const target = await getMessage(r.message_id);
    if (!target || target.chatId !== r.chat_id || !target.fromMe) return ignored("reaction on a message we didn't send");
    chatId = r.chat_id;
    // 👍/❤️ on a proposal's message approves that proposal (and only that one); 👎 cancels.
    let approves: string | null = null;
    if (r.reaction_type === "like" || r.reaction_type === "love") approves = await proposalTurnOf(chatId, r.message_id);
    if (r.reaction_type === "dislike") await clearPending(chatId, GATED_TOOLS);
    text = `[${OWNER} reacted ${emoji} to your message: ${JSON.stringify(target.text.slice(0, 300))}]`;
    ctx = { chatId, turnId: event.event_id, ack: { reacted: true }, approves, previews: {} };
  } else {
    return new Response("ignored");
  }

  if (!(await withinRateLimit(chatId))) return ignored("rate limited");

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

      // Previews are rendered by code from the stored proposal, so what the owner approves is what runs.
      // A proposal becomes approvable only once its preview has actually been delivered.
      const previews = Object.values(ctx.previews);
      if (previews.length) {
        const previewIds: string[] = [];
        for (const preview of previews) previewIds.push(await sendText(chatId, preview));
        await markProposalDelivered(chatId, ctx.turnId, previewIds);
      }
      // An empty reply is fine: sometimes a tapback is the whole answer.
      const replyIds = reply ? await sendBubbles(chatId, reply) : [];
      if (previews.length) await markProposalDelivered(chatId, ctx.turnId, replyIds);

      const said = [...previews, reply].filter(Boolean).join("\n\n") || "(reacted)";
      await appendHistory(chatId, { role: "user", content: text }, { role: "assistant", content: said });
      // Long-term memory: every exchange goes to HydraDB (after the reply, so it never adds latency).
      await rememberExchange(text, said, { chatId, turnId: ctx.turnId }).catch((err) =>
        console.error("[hydra] failed to store exchange:", (err as Error).message),
      );
    } catch (err) {
      console.error("[agent] failed:", (err as Error).message);
      await sendText(chatId, "Something broke on my side, try again in a moment.").catch(() => {});
    } finally {
      clearTimeout(autoAck);
      clearInterval(keepTyping);
      await typing(chatId, false);
    }
  });

  return new Response("ok");
}
