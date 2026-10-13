// Chat with the agent from the terminal, without iMessage. Keeps history, so you can
// test multi-turn flows like propose → "yes" → done.
// Usage: pnpm ask                 (interactive)
//        pnpm ask "<message>"     (one shot)
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { runAgent } from "../lib/agent";
import { toBubbles } from "../lib/linq";
import type { Turn } from "../lib/store";

const chatId = `terminal-${randomUUID()}`;
const history: Turn[] = [];

async function turn(text: string) {
  const ctx = { chatId, turnId: randomUUID(), reactTo: undefined, ack: { reacted: false } };
  const reply = await runAgent(history, text, ctx);
  for (const bubble of toBubbles(reply)) console.log(`\n💬 ${bubble.replace(/\n/g, "\n   ")}`);
  history.push({ role: "user", content: text }, { role: "assistant", content: reply || "(reacted)" });
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
