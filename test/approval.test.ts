import { test } from "node:test";
import assert from "node:assert/strict";
import { executeApproved, GATED_TOOLS, previewDoc, propose, type AgentContext, type GatedTool } from "../lib/agent";
import { clearPending, lastProposalTurn, markProposalDelivered, proposalTurnOf } from "../lib/store";

// `approves` is the proposing turn the owner approved; the webhook sets it, never the model.
const ctx = (chatId: string, turnId: string, approves: string | null = null): AgentContext => ({
  chatId,
  turnId,
  ack: { reacted: false },
  approves,
  previews: {},
});

const email = { to: "ana@acme.com", subject: "Data request", body: "Hi Ana" };

function recorder() {
  const ran: { tool: GatedTool; input: unknown }[] = [];
  const actions = {
    create_google_doc: async (input: never) => ran.push({ tool: "create_google_doc", input }),
    draft_email: async (input: never) => ran.push({ tool: "draft_email", input }),
  };
  return { ran, actions };
}

const run = async (c: AgentContext, tool: GatedTool, actions: ReturnType<typeof recorder>["actions"]) =>
  JSON.parse(await executeApproved(c, tool, actions)).status;

test("proposing never runs anything and queues a code-rendered preview", async () => {
  const c = ctx("c1", "t1");
  const out = JSON.parse(await propose(c, "draft_email", email, "PREVIEW"));
  assert.equal(out.status, "proposed");
  assert.equal(c.previews.draft_email, "PREVIEW");
});

test("a proposal from this turn can't be run, even if something claims approval", async () => {
  const { ran, actions } = recorder();
  await propose(ctx("c2", "t1"), "draft_email", email, "p");
  assert.equal(await run(ctx("c2", "t1", "t0"), "draft_email", actions), "nothing_pending");
  assert.equal(ran.length, 0);
});

test("without an approval detected by code, the model can't run it", async () => {
  const { ran, actions } = recorder();
  await propose(ctx("c3", "t1"), "draft_email", email, "p");
  assert.equal(await run(ctx("c3", "t2"), "draft_email", actions), "not_approved");
  assert.equal(ran.length, 0);
});

test("approval runs exactly the stored proposal, once", async () => {
  const { ran, actions } = recorder();
  await propose(ctx("c4", "t1"), "draft_email", email, "p");
  assert.equal(await run(ctx("c4", "t2", "t1"), "draft_email", actions), "done");
  assert.deepEqual(ran, [{ tool: "draft_email", input: email }]);
  assert.equal(await run(ctx("c4", "t3", "t1"), "draft_email", actions), "nothing_pending");
  assert.equal(ran.length, 1);
});

test("approving an older proposal doesn't run a newer one, and leaves it pending", async () => {
  const { ran, actions } = recorder();
  await propose(ctx("c5", "t1"), "draft_email", email, "p1");
  const revised = { ...email, cc: ["bob@acme.com"] };
  await propose(ctx("c5", "t2"), "draft_email", revised, "p2");
  assert.equal(await run(ctx("c5", "t3", "t1"), "draft_email", actions), "nothing_pending");
  assert.equal(ran.length, 0);
  assert.equal(await run(ctx("c5", "t4", "t2"), "draft_email", actions), "done");
  assert.deepEqual(ran, [{ tool: "draft_email", input: revised }]);
});

test("a proposal for one tool doesn't approve another", async () => {
  const { ran, actions } = recorder();
  await propose(ctx("c6", "t1"), "create_google_doc", { title: "x", markdown: "y" }, "p");
  assert.equal(await run(ctx("c6", "t2", "t1"), "draft_email", actions), "nothing_pending");
  assert.equal(ran.length, 0);
});

test("proposals are per chat", async () => {
  const { ran, actions } = recorder();
  await propose(ctx("c7", "t1"), "draft_email", email, "p");
  assert.equal(await run(ctx("c8", "t2", "t1"), "draft_email", actions), "nothing_pending");
  assert.equal(ran.length, 0);
});

test("any other message cancels pending proposals", async () => {
  const { ran, actions } = recorder();
  await propose(ctx("c9", "t1"), "draft_email", email, "p");
  await markProposalDelivered("c9", "t1", ["m1"]);
  await clearPending("c9", GATED_TOOLS);
  assert.equal(await lastProposalTurn("c9"), null);
  assert.equal(await run(ctx("c9", "t2", "t1"), "draft_email", actions), "nothing_pending");
  assert.equal(ran.length, 0);
});

test("delivered proposals map their messages to the proposing turn", async () => {
  assert.equal(await lastProposalTurn("c10"), null);
  await markProposalDelivered("c10", "t1", ["m1", "m2"]);
  await markProposalDelivered("c10", "t2", ["m3"]);
  assert.equal(await lastProposalTurn("c10"), "t2");
  assert.equal(await proposalTurnOf("c10", "m1"), "t1");
  assert.equal(await proposalTurnOf("c10", "m3"), "t2");
  assert.equal(await proposalTurnOf("c10", "unrelated"), null);
});

test("doc previews list every link, even past the clip", () => {
  const preview = previewDoc({ title: "T", markdown: `${"x".repeat(3000)}\nhttps://evil.example/?d=1` });
  assert.ok(preview.includes("Links in this doc:\nhttps://evil.example/?d=1"));
});
