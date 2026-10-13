import { test } from "node:test";
import assert from "node:assert/strict";
import { gated, type AgentContext } from "../lib/agent";

const ctx = (chatId: string, turnId: string): AgentContext => ({ chatId, turnId, ack: { reacted: false } });

test("never runs an action in the same turn it was proposed, even if the model claims approval", async () => {
  let ran = 0;
  const out = JSON.parse(await gated(ctx("c1", "t1"), "draft_email", true, "draft", async () => ran++));
  assert.equal(out.status, "awaiting_approval");
  assert.equal(ran, 0);
});

test("runs once approved in a later turn, then needs a fresh proposal", async () => {
  let ran = 0;
  const exec = async () => ++ran;
  await gated(ctx("c2", "t1"), "draft_email", false, "draft", exec);
  assert.equal(JSON.parse(await gated(ctx("c2", "t2"), "draft_email", true, "draft", exec)).status, "done");
  assert.equal(ran, 1);
  assert.equal(JSON.parse(await gated(ctx("c2", "t3"), "draft_email", true, "draft", exec)).status, "awaiting_approval");
  assert.equal(ran, 1);
});

test("a proposal for one tool doesn't approve another", async () => {
  let ran = 0;
  await gated(ctx("c3", "t1"), "create_google_doc", false, "doc", async () => ran++);
  const out = JSON.parse(await gated(ctx("c3", "t2"), "draft_email", true, "draft", async () => ran++));
  assert.equal(out.status, "awaiting_approval");
  assert.equal(ran, 0);
});

test("without approval it only (re)proposes", async () => {
  let ran = 0;
  await gated(ctx("c4", "t1"), "draft_email", false, "draft", async () => ran++);
  const out = JSON.parse(await gated(ctx("c4", "t2"), "draft_email", false, "draft v2", async () => ran++));
  assert.equal(out.status, "awaiting_approval");
  assert.equal(ran, 0);
});
