// Usage: pnpm subscribe-webhook https://your-app.vercel.app
// Prints the signing secret; put it in LINQ_WEBHOOK_SECRET.
import LinqAPIV3 from "@linqapp/sdk";

const base = process.argv[2];
if (!base?.startsWith("https://")) {
  console.error("Usage: pnpm subscribe-webhook https://<public-url>");
  process.exit(1);
}

const linq = new LinqAPIV3();
const sub = await linq.webhookSubscriptions.create({
  target_url: `${base.replace(/\/$/, "")}/api/linq?version=2026-02-03`,
  subscribed_events: ["message.received", "reaction.added"],
});
console.log(JSON.stringify(sub, null, 2));
