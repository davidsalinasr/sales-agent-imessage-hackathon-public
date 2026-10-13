# sales-agent-imessage

Text a sales agent over iMessage. It **remembers** everything in your
[HydraDB](https://hydradb.com) memory (Gmail, Granola call transcripts, Google Drive and
Calendly) and **acts** on it: it writes data requests, creates Google Docs and drafts emails.
Then it remembers what it did, so later you can ask whether the customer delivered.

> "Prepare a data request for Acme using their latest discovery call and relevant Drive documents."
> "Create the Google Doc and draft an email with my Calendly link."
> "Check whether Acme has provided what we need for the next call."

Built for the HydraDB hackathon.

## How it works

```
iMessage ──► Linq ──webhook──► /api/linq  (Next.js on Vercel)
                                 │ verify signature · owner-only · dedupe · 200 immediately
                                 ▼ after()
                         Claude agent loop (Anthropic tool runner)
            ┌──────────────────────┼─────────────────────────┐
     HydraDB memory          Composio actions               Linq reply
  recall · remember     Google Doc · Gmail draft ·      typing indicator +
                        live inbox search                 iMessage answer
```

- **Memory is the backbone.** `recall` runs HydraDB hybrid (vector + BM25 + graph) search
  across connector data and the agent's own notes. `remember` writes every action back as a memory
  (`infer: true`): the account, the requested items, the Doc URL and the draft id.
- **Gets smarter the more you text it.** Every iMessage exchange is stored in HydraDB as a
  memory (`user_assistant_pairs` with `infer: true`). HydraDB extracts the durable facts and
  preferences (people, deal status, commitments, how you like things done) and reconciles them
  with what it already knows, so the next `recall` knows what you only ever said in chat.
- **The memory loop.** When the agent creates a data request, it stores the item list. When you
  later ask "has Acme sent it?", it recalls that list and checks each item against new emails
  and docs, using memory plus a live Gmail search.
- **Safe by design.** Email is draft-only, because no send tool is exposed. Only your handles (`OWNER_HANDLE`) get
  replies. Docs and drafts need your explicit yes in a later message, enforced in code. Webhooks are verified (Standard Webhooks HMAC) and de-duplicated.

## Stack

- **[Linq](https://linqapp.com)** for the iMessage connection: inbound webhooks, replies, typing
  indicator and tapbacks.
- **[HydraDB](https://hydradb.com)** as memory: hybrid recall over connector data plus the agent's
  own notes and every chat exchange.
- **Granola, Gmail, Google Drive and Calendly** as context for HydraDB, synced through its
  connectors (call transcripts, email, docs, booking link).
- **[Composio](https://composio.dev)** for taking action: Google Docs, Gmail drafts and live inbox search.
- **Claude Opus 5.5** via the `@anthropic-ai/sdk` tool runner, on Next.js 16 / Vercel, with Upstash
  Redis for chat history, pending approvals and webhook dedupe.

| File | Role |
|---|---|
| `app/api/linq/route.ts` | Webhook: verify, filter, dedupe, run the agent in `after()` |
| `lib/agent.ts` | System prompt, tools, approval gate, tool runner |
| `lib/persona.ts` | Who the agent works for: name, context, voice |
| `lib/hydra.ts` | `recall` / `remember` |
| `lib/composio.ts` | Google Doc, Gmail draft, inbox search |
| `lib/linq.ts` | Send, typing indicator, signature check |
| `lib/store.ts` | Event dedupe and per-chat history |

## Setup

1. `pnpm install` and `cp .env.example .env.local`, then fill in the keys. Edit `lib/persona.ts`
   with your name, what you do and how you write.
2. HydraDB: connect Gmail, Granola, Drive and Calendly in the dashboard. Then run
   `pnpm hydra:inspect "Acme discovery call"` to confirm `HYDRA_DB_DATABASE` returns results.
   List every connector collection in `HYDRA_DB_SEARCH_COLLECTIONS` (queries only search the
   collections they name).
3. Composio: connect Gmail and Google Docs, and set `COMPOSIO_USER_ID` to the user that owns them.
4. Deploy (`vercel`) or tunnel locally (`pnpm dev` + `ngrok http 3000`).
5. `pnpm subscribe-webhook https://<public-url>`, then put the printed secret in
   `LINQ_WEBHOOK_SECRET`. On Vercel, add it and redeploy.
6. Text your Linq number from `OWNER_HANDLE`.

`pnpm ask` chats with the agent from the terminal (multi-turn; or `pnpm ask "<message>"` for one shot), without iMessage. `pnpm test` runs the webhook signature tests. `pnpm typecheck` runs the type checker.

## License

MIT
