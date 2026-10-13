import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { Webhook } from "standardwebhooks";

// Same verifier the Linq SDK's webhooks.unwrap() uses.
const secretBytes = randomBytes(24);
const secret = `whsec_${secretBytes.toString("base64")}`;

function sign(id: string, ts: number, body: string) {
  const sig = createHmac("sha256", secretBytes).update(`${id}.${ts}.${body}`).digest("base64");
  return { "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": `v1,${sig}` };
}

const body = JSON.stringify({ event_type: "message.received", event_id: "evt_1" });

test("accepts a correctly signed payload", () => {
  const headers = sign("msg_1", Math.floor(Date.now() / 1000), body);
  assert.deepEqual(new Webhook(secret).verify(body, headers), JSON.parse(body));
});

test("rejects a tampered body", () => {
  const headers = sign("msg_1", Math.floor(Date.now() / 1000), body);
  assert.throws(() => new Webhook(secret).verify(body.replace("evt_1", "evt_2"), headers));
});

test("rejects a stale timestamp", () => {
  const headers = sign("msg_1", Math.floor(Date.now() / 1000) - 600, body);
  assert.throws(() => new Webhook(secret).verify(body, headers));
});
