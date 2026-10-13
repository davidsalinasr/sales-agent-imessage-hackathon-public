// Usage: pnpm subscribe-webhook https://your-app.vercel.app
// Saves the signing secret to LINQ_WEBHOOK_SECRET in .env.local (backing up the old file)
// instead of printing it.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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
const { signing_secret: secret, ...rest } = sub;
console.log(JSON.stringify(rest, null, 2));

if (secret) {
  const file = ".env.local";
  const line = `LINQ_WEBHOOK_SECRET=${secret}`;
  if (existsSync(file)) {
    copyFileSync(file, `${file}.bak`);
    const env = readFileSync(file, "utf8");
    const next = /^LINQ_WEBHOOK_SECRET=.*$/m.test(env)
      ? env.replace(/^LINQ_WEBHOOK_SECRET=.*$/m, line)
      : `${env.trimEnd()}\n${line}\n`;
    writeFileSync(file, next, { mode: 0o600 });
  } else {
    writeFileSync(file, `${line}\n`, { mode: 0o600 });
  }
  console.log(`Saved LINQ_WEBHOOK_SECRET (${secret.slice(0, 10)}…) to ${file}. On Vercel, add it and redeploy.`);
}
