// Chat with the agent from the terminal, without iMessage. Keeps history, so you can
// test multi-turn flows like propose → "yes" → done.
// Usage: pnpm ask                 (interactive)
//        pnpm ask "<message>"     (one shot)
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { GATED_TOOLS, runAgent, type AgentContext } from "../lib/agent";
import { isApproval } from "../lib/guard";
import { clearPending, lastProposalTurn, markProposalDelivered } from "../lib/store";
import { toBubbles } from "../lib/linq";
import type { Turn } from "../lib/store";

const chatId = `terminal-${randomUUID()}`;
const history: Turn[] = [];

async function turn(text: string) {
  const ctx: AgentContext = {
    chatId,
    turnId: randomUUID(),
    ack: { reacted: false },
    approves: null,
    previews: {},
  };
  // Same approval rules as the webhook: a plain "yes" approves the latest proposal, anything else cancels.
  if (isApproval(text)) ctx.approves = await lastProposalTurn(chatId);
  else await clearPending(chatId, GATED_TOOLS);
  const reply = await runAgent(history, text, ctx);
  const previews = Object.values(ctx.previews);
  if (previews.length) await markProposalDelivered(chatId, ctx.turnId, []);
  for (const bubble of [...previews, ...toBubbles(reply)]) console.log(`\n💬 ${bubble.replace(/\n/g, "\n   ")}`);
  const said = [...previews, reply].filter(Boolean).join("\n\n") || "(reacted)";
  history.push({ role: "user", content: text }, { role: "assistant", content: said });
}

const oneShot = process.argv.slice(2).join(" ");
if (oneShot) {
  await turn(oneShot);
} else {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for (;;) {
    const text = (await rl.question("\nyou › ")).trim();
    if (!text || text === "exit") break;
    await turn(text);
  }
  rl.close();
}
