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
- **Guardrails, in code.**
  - Email is draft-only: no send tool is exposed.
  - Only your handles (`OWNER_HANDLE`) get replies, in a 1:1 iMessage chat. An unset
    `OWNER_HANDLE` means nobody, never everybody. Group chats and SMS are ignored.
  - Docs and drafts are proposals until you approve them. The webhook, not the model, decides
    what counts as approval: a plain "yes" / "ok" / "dale" to the latest proposal you've seen, or a
    👍 / ❤️ on the proposal's preview. Approval runs that stored proposal exactly as previewed. Any
    other message (or a 👎) cancels pending proposals, and any change means a new proposal and a
    new preview.
  - Webhooks are verified (Standard Webhooks HMAC), de-duplicated and rate-limited per chat.
- **Prompt injection.** Emails, docs and transcripts are written by other people. The agent
  receives them wrapped as untrusted data and is told never to follow instructions in them; only
  links to Google and Calendly get link previews, and Markdown images are stripped from Docs.
  That lowers the risk without removing it, which is why every action needs your approval and
  email is never sent. Read each preview before you say yes.

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
5. `pnpm subscribe-webhook https://<public-url>`. It saves the signing secret to
   `LINQ_WEBHOOK_SECRET` in `.env.local`. On Vercel, add it and redeploy.
6. Text your Linq number from `OWNER_HANDLE`, in a 1:1 chat.

In production, Upstash Redis is required (dedupe, rate limits and pending approvals have to be
shared across serverless instances); the agent refuses to run on Vercel production without it.

`pnpm ask` chats with the agent from the terminal (multi-turn; or `pnpm ask "<message>"` for one shot), without iMessage. `pnpm test` runs the tests (webhook signatures, owner and approval checks, the approval gate, bubbles). `pnpm typecheck` runs the type checker.

## License

MIT
