# Daisy Protocol — Netlify deployment guide

This is the complete Netlify version of your existing website: Daisy Protocol branding, the same Utah AI services, ROI calculator, Google Calendar booking links, and the floating scheduling chat. It uses React/Vite for the page and Netlify Functions for `/api/chat`. Your existing Sites website has also received the branding and booking-recovery update.

**Netlify and daisyprotocol.com are not deployed/configured yet.** Follow the steps below to activate them. No n8n workflow or Google Calendar settings were changed.

## 1. Put this folder in a GitHub repository

Unzip `daisy-protocol-netlify.zip`. Create a GitHub repository and upload the **contents of the daisy-protocol-netlify folder**, including `package.json`, `package-lock.json`, `netlify.toml`, `index.html`, `src`, `public`, `server`, and `netlify`.

The repository root should contain `netlify.toml` and `package.json`. Do not upload `node_modules`, `.env`, `.netlify`, or any API keys. The archive includes source and a lockfile, not installed dependencies.

## 2. Import into Netlify

In Netlify, choose **Add new project → Import an existing project**, connect GitHub, and select that repository. Use these settings (also included in `netlify.toml`):

| Setting | Value |
|---|---|
| Base directory | Leave blank when this package is at the repository root |
| Build command | `npm run build` |
| Publish directory | `dist` |
| Functions directory | `netlify/functions` |
| Node version | `24` |

If you keep the package inside a larger repository, set the base directory to that package's folder instead. Deploy using the Git integration so the backend functions are included. Uploading only `dist` through drag-and-drop would omit the chat backend. [Netlify's Vite guide](https://docs.netlify.com/build/frameworks/framework-setup-guides/vite/).

## 3. Add the server environment variables

Under your Netlify project's **Environment variables**, add these for the Production context and Functions scope (or all scopes if your plan does not offer scope selection). Then trigger a new production deploy.

| Variable | Value |
|---|---|
| `OPENAI_API_KEY` | Your approved OpenAI API key; enter it privately in Netlify |
| `OPENAI_MODEL` | `gpt-4.1-mini` |
| `N8N_WEBHOOK_URL` | Your existing public HTTPS production webhook URL |

Your webhook supplied for this project is:

```text
https://freeness-unturned-stopper.ngrok-free.dev/webhook/64dfb1e2-9f61-45b3-8230-3ad23989f414
```

The key currently used by the existing Site is stored locally in `site/.env.local` in the original workspace; it is intentionally excluded from this package. It was provisioned with a 30-day lifetime, so check its expiration when moving to Netlify. Never use a `VITE_` prefix for these secrets: those variables are intended for browser builds.

Keep n8n and its ngrok tunnel running. Netlify cannot reach `localhost:5678` on your computer. If the public tunnel URL changes, update `N8N_WEBHOOK_URL` in Netlify and redeploy. No separate Ollama connection is needed by this frontend/backend: it uses OpenAI to collect information and sends the final request to your existing n8n agent. Your n8n agent can continue using its own model and calendar tools.

## 4. Verify the Netlify address first

Open the `https://YOUR-PROJECT.netlify.app` URL that Netlify provides.

- Confirm the page says Daisy Protocol and the consultation buttons open your existing Google booking page.
- Open `/api/health`: it should show `{"ok":true}`. This checks routing only, not OpenAI or calendar connectivity.
- Open the chat and say “Hi, I would like to schedule a consultation.” It should ask for missing information. This alone does not create a booking.
- Complete a real booking only when you intend to create one. Check the n8n execution and Google Calendar before treating an ambiguous result as confirmed.

A Netlify 404 on `/api/chat` means the functions were omitted or the wrong base directory was selected. A chat 503 usually means missing/expired credentials, a provider error, or storage configuration trouble; inspect the `chat` Function logs. A submission warning can mean the tunnel was unavailable or the workflow returned an unexpected result. Do not submit the same appointment again until its calendar outcome is checked.

## 5. Connect daisyprotocol.com

In Netlify's **Domain management**, add `daisyprotocol.com` to this project. Verify that `www.daisyprotocol.com` is also attached, and choose `daisyprotocol.com` as the primary domain.

At the company where you bought the domain, open DNS management. In Netlify, open the domain's **Pending DNS verification** instructions and copy the exact records it provides:

- For `www`, use the CNAME target Netlify supplies for your project.
- For the root domain (`@`), use the ALIAS/ANAME/flattened CNAME or A record Netlify specifies for your DNS provider.

Replace only conflicting web records. Preserve existing email MX/TXT records. Wait for DNS verification, then confirm Netlify has issued the HTTPS certificate. Test both domain variants and the chat on the primary domain. Exact DNS targets depend on your project and DNS provider; follow Netlify's displayed values. [Official external DNS instructions](https://docs.netlify.com/manage/domains/configure-domains/configure-external-dns/).

## What was fixed in scheduling

Your existing n8n webhook responds immediately with `{"message":"Workflow was started"}`. The chat now correctly reports **request submitted** instead of treating that acknowledgment as a failure. It does not claim the appointment is confirmed on that response. Follow-up messages such as thanks, status questions, and requests to make changes now receive useful replies instead of repeating the same warning.

The existing Site can also recover the two earlier booking payloads whose calendar success was independently verified in n8n execution records. Refresh the existing Site and send another message in the same chat to recover its status; no duplicate request is sent.

For new requests, final confirmation can only be shown immediately if the webhook returns a completed successful result, such as `{"success":true,"message":"Your appointment is confirmed."}`. Your current workflow is unchanged and acknowledges receipt before that result exists. This package does not poll n8n or directly query Google Calendar. Rescheduling and cancellation remain manual.

## Storage and migration behavior

The Netlify backend uses Netlify Blobs with strong reads and conditional writes, not a temporary local SQLite file. Per-session locks and a persisted submission marker prevent concurrent requests and transport retries from submitting the same booking twice. Ambiguous network failures are never automatically resubmitted. Rate limits apply to sessions, IP hashes, and the site overall. [Netlify Blobs documentation](https://docs.netlify.com/build/data-and-storage/netlify-blobs/).

Chat state expires after seven days of inactivity. A daily scheduled cleanup erases expired session content using conditional tombstones; empty tombstones and hashed rate-limit counters may remain. Browser history expires after six days. This protects against duplicate submission within a retained session, not across unrelated browsers, cleared storage, or deliberately started new appointments.

The new domain starts new browser sessions and a new Netlify data store. Existing chat history and submitted-request records in the Sites database are **not migrated**. Check existing appointments on the old site/calendar before initiating the same booking on the new domain. Keep the old site available during transition.

## Local development and tests

Use Node 24. From this package folder:

```sh
npm ci
npm test
npm run build
npm run dev
```

`npm run dev` previews the page only. For local Netlify Functions and Blobs emulation, use Netlify CLI (`npx netlify-cli dev`) with an ignored `.env` file based on `.env.example`. Use your own test webhook when intentionally exercising bookings.

The automated tests use mocked providers and never create appointments. They cover concurrent functions, durable submission markers, rate limiting, retention, and follow-up behavior. The shared scheduling engine also passed the existing 23 regression tests before packaging. A full live Netlify booking remains to be verified after account/environment setup.

## Files to edit later

- `src/App.tsx`: landing page text, sections, booking links.
- `src/style.css`: responsive design.
- `public/scheduling/widget.js` and `widget.css`: floating chat interface.
- `server/agent.js`: validation and booking state machine.
- `server/openai.js`: server-side model extraction.
- `server/store.js`: durable Netlify storage and locking.
- `netlify/functions/chat.mjs`: same-origin `/api/chat` endpoint.

Changes pushed to the connected GitHub branch will create a new Netlify deployment. Keep all credentials in Netlify's environment settings.
