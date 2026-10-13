import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { recall, remember } from "./hydra";
import { createGoogleDoc, draftEmail, searchInbox } from "./composio";
import { react, type Reaction } from "./linq";
import { getPending, setPending, type Turn } from "./store";
import { ABOUT, EXAMPLE, OWNER, PERSONAL_MAIL, VOICE } from "./persona";

let client: Anthropic | undefined;
const MODEL = process.env.AGENT_MODEL || "claude-opus-5-5";
const APPROVAL_TTL_MS = 60 * 60 * 1000;

// Frozen so it caches; today's date goes in the user turn, not here.
const SYSTEM = `You are ${OWNER}'s assistant over iMessage. ${ABOUT} Think sharp chief of staff who has known ${OWNER} for years: you get things done, you don't waste their time, and you sound like them.

## What you can see and do
Your memory (HydraDB) holds ${OWNER}'s Gmail, Google Drive, call notes and Calendly, plus notes on every action you've taken. Ground every answer in it: call \`recall\` before saying anything about a customer, a call, a doc or a past request. Run a few focused recalls rather than one vague one ("Acme discovery call", "Acme data requirements"). \`search_inbox\` is the live inbox for anything newer than a few minutes.

Actions: \`create_google_doc\`, \`draft_email\` (drafts only, you can never send). \`remember\` saves notes to your own memory.

## Acknowledge like a person
${OWNER} sees a typing indicator while you work, and if you take more than a few seconds they automatically get a 👍 on their message, so you never need to say "on it" / "got it" / "let me check".
Use \`react\` only when a tapback carries meaning, as your first tool call:
- love ❤️: they thank you, share good news or a win
- laugh 😂: they're joking
- emphasize ‼️: something urgent or a big deal
- like 👍: an instruction you'll just do, with nothing to say beyond the result
Most messages need no reaction. Never react to their reactions, and don't answer a tapback with a tapback.

## Ask when it matters, assume when it doesn't
If the request is ambiguous in a way that changes the result (which account, which call, who the email goes to, which of two docs) and your memory can't settle it, ask ONE short question before doing anything, and offer your best guess so they can just say yes: "The Oct 3 call with Ana, or the one with their CFO last week?" If a wrong guess would be cheap and easy to fix, just pick the obvious option and mention it in a few words.

## Confirm before acting, then say it's done
\`create_google_doc\` and \`draft_email\` are gated: they only run after ${OWNER} approves.
1. Call the tool with your final inputs and approved=false. Nothing happens yet; the proposal is saved.
2. In the same reply, show the essentials in one or two bubbles and ask. For an email: recipient, subject, and the body itself (it's short). For a Doc: title plus the checklist items. End with a short yes/no question ("Send it to drafts?" / "Want me to create it?").
3. Approval is a clear yes: "yes", "ok", "dale", "sí", "go", or a 👍 / ❤️ tapback on your proposal (you'll see it as "[${OWNER} reacted 👍 to: …]"). A 👎 or "no" means don't. Then call the tool again with approved=true and the final inputs.
   "Yes but change X": for a trivial edit (a typo, one word, adding a cc) apply it and run with approved=true. For anything bigger (new recipient, different content), call it with approved=false and the revised inputs, show what changed, and ask once more.
4. Once it runs, answer with the result: "Listo ✅" or "Done ✅" plus the link. Then call \`remember\` with the account, what was requested (every item), Doc URL and draft id. You don't need to ask before \`remember\`.
Never say you did something you haven't, and never claim an action ran if the tool said it's waiting for approval.

## Sound like ${OWNER}
${VOICE}

## How to text
- Each blank line in your reply becomes its own iMessage bubble. Usually 1–3 short bubbles; one is often enough.
- A bubble is 1–2 sentences. Lists only for real lists (items, ✅/❌ status), max ~6 short lines.
- Lead with the answer, then stop. Don't restate the question, narrate your searches, or recap.
- One next step as a quick question when it helps, never a menu of options.
- No filler, preambles or sign-offs: never "I'd be happy to", "Great question", "How can I help?", "Let me know if you need anything else", "I apologize for the confusion", "anything else?".
- No Markdown: no headers, bold, tables or [text](url) links. Bare URLs on their own line.

Example. ${EXAMPLE}

## Work and personal
${PERSONAL_MAIL}

## Data requests (core workflow)
From the latest discovery call and relevant docs, work out exactly what the customer must provide (data, access, documents, people). In chat, give ${OWNER} the short version and offer the Doc. Detail goes in the Doc: Markdown with a title, context, numbered checklist (why each item matters, owner), and timeline. The email links the Doc and includes ${OWNER}'s Calendly link (recall "Calendly link"; fall back to get_calendly_link).
Checking progress: recall the saved request for that account, then check memory and the inbox for what arrived since. Reply with ✅ / ❌ / ⚠️ per item and a few words of evidence ("sent Tuesday by Ana").`;

export type AgentContext = {
  chatId: string;
  /** Unique per inbound turn (message or tapback); approvals must come from a later turn. */
  turnId: string;
  /** The owner's message to react to, if this turn is a text message. */
  reactTo?: string;
  /** Shared with the webhook's auto-acknowledgement so we never double-react. */
  ack: { reacted: boolean };
};

/**
 * Approval gate enforced in code, not just the prompt: an action only runs when the
 * model says the owner approved AND it was proposed in an earlier message of this chat.
 */
export async function gated(ctx: AgentContext, tool: string, approved: boolean, summary: string, run: () => Promise<unknown>) {
  const pending = (await getPending(ctx.chatId))[tool];
  const proposedEarlier = pending && pending.messageId !== ctx.turnId && Date.now() - pending.at < APPROVAL_TTL_MS;

  if (approved && proposedEarlier) {
    await setPending(ctx.chatId, tool, null);
    return JSON.stringify({ status: "done", result: await run() });
  }
  await setPending(ctx.chatId, tool, { summary, messageId: ctx.turnId, at: Date.now() });
  return JSON.stringify({
    status: "awaiting_approval",
    note:
      `NOT executed. Show ${OWNER} the essentials and ask them to confirm. Call this tool again with approved=true only after they say yes in a later message.`,
  });
}

const approvedField = z
  .boolean()
  .describe(`true only if ${OWNER} explicitly approved this action in their latest message; false to propose it`);

function buildTools(ctx: AgentContext) {
  return [
    betaZodTool({
      name: "react",
      description: `Add an iMessage tapback to ${OWNER}'s latest message to acknowledge it, like a person would.`,
      inputSchema: z.object({
        type: z.enum(["like", "love", "laugh", "emphasize"]),
      }),
      run: async ({ type }) => {
        if (!ctx.reactTo || ctx.ack.reacted) return "Already acknowledged; no reaction added.";
        ctx.ack.reacted = true;
        await react(ctx.reactTo, type as Reaction);
        return "Reacted.";
      },
    }),
    betaZodTool({
      name: "recall",
      description:
        `Search ${OWNER}'s long-term memory (HydraDB): emails, Drive docs, call notes, Calendly, and notes about past agent actions. Returns ranked excerpts with sources.`,
      inputSchema: z.object({
        query: z.string().describe("Focused natural-language query, e.g. 'Acme latest discovery call next steps'"),
        type: z
          .enum(["all", "knowledge", "memory"])
          .optional()
          .describe("'knowledge' = synced sources, 'memory' = notes about past actions, 'all' = both (default)"),
      }),
      run: async ({ query, type }) => recall(query, type ?? "all"),
    }),
    betaZodTool({
      name: "remember",
      description:
        "Save a durable note to memory about an action taken or a fact learned (e.g. a data request sent to a customer, with every requested item).",
      inputSchema: z.object({
        text: z.string().describe("Self-contained note, readable months from now without other context"),
        account: z.string().describe("Customer/account name, e.g. 'Acme'"),
        kind: z.enum(["data_request", "email_draft", "doc_created", "note"]),
        doc_url: z.string().optional(),
        draft_id: z.string().optional(),
        items: z.array(z.string()).optional().describe("Requested items, one per entry"),
      }),
      run: async ({ text, ...metadata }) => {
        await remember(text, { ...metadata, account: metadata.account.toLowerCase() });
        return "Saved to memory.";
      },
    }),
    betaZodTool({
      name: "create_google_doc",
      description:
        `Create a Google Doc in ${OWNER}'s Drive from Markdown. Gated: propose with approved=false, run with approved=true after they confirm.`,
      inputSchema: z.object({
        title: z.string(),
        markdown: z.string().describe("Full document content in Markdown"),
        approved: approvedField,
      }),
      run: async ({ title, markdown, approved }) =>
        gated(ctx, "create_google_doc", approved, `Doc "${title}"`, () => createGoogleDoc(title, markdown)),
    }),
    betaZodTool({
      name: "draft_email",
      description:
        `Create a Gmail DRAFT in ${OWNER}'s account (never sends). Gated: propose with approved=false, run with approved=true after they confirm.`,
      inputSchema: z.object({
        to: z.string().describe("Recipient email address"),
        subject: z.string(),
        body: z.string().describe(`Plain-text body, in ${OWNER}'s voice`),
        cc: z.array(z.string()).optional(),
        approved: approvedField,
      }),
      run: async ({ approved, ...email }) =>
        gated(ctx, "draft_email", approved, `Draft to ${email.to}: "${email.subject}"`, () => draftEmail(email)),
    }),
    betaZodTool({
      name: "search_inbox",
      description:
        "Live Gmail search for the newest messages (memory may lag a few minutes behind the inbox). Use Gmail operators, e.g. 'from:acme.com after:2026/10/01 has:attachment'.",
      inputSchema: z.object({
        query: z.string(),
        max_results: z.number().int().min(1).max(25).optional(),
      }),
      run: async ({ query, max_results }) => JSON.stringify(await searchInbox(query, max_results ?? 10)),
    }),
    betaZodTool({
      name: "get_calendly_link",
      description: `${OWNER}'s Calendly booking link. Use only if recall did not find it.`,
      inputSchema: z.object({}),
      run: async () => process.env.CALENDLY_URL || "No Calendly link configured.",
    }),
  ];
}

export async function runAgent(history: Turn[], userText: string, ctx: AgentContext): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...history.map((t) => ({ role: t.role, content: t.content })),
    { role: "user", content: `[${today}] ${userText}` },
  ];

  const runner = (client ??= new Anthropic()).beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "medium" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    cache_control: { type: "ephemeral" },
    system: SYSTEM,
    tools: buildTools(ctx),
    messages,
    max_iterations: 15,
  });

  for await (const message of runner) {
    for (const block of message.content) {
      if (block.type === "tool_use") console.log("[agent] tool", block.name, JSON.stringify(block.input).slice(0, 200));
    }
  }
  const final = await runner.done();

  if (final.stop_reason === "refusal") return "I can't help with that one.";
  const text = final.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("\n")
    .trim();
  return text;
}
