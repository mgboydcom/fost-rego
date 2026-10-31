# Design

## Context

See proposal.md for why. The app is Next.js 15 with server actions over PostgreSQL (`pg`, plain SQL migrations applied at start-up). Business rules live in `src/lib`, independent of Next.js. Today some writes run inside `transaction()` (proposal submission, edits, decisions) and some do not (registration, profile saves). The app will run as a long-lived server on OVHcloud or Scaleway, not on a serverless platform. n8n is the only planned consumer at first, but organisers may register more than one endpoint (for example, production and test n8n workflows).

## Goals / Non-Goals

**Goals:**
- No lost or phantom events: an event exists if and only if its change was saved.
- One payload shape shared by webhooks and API reads.
- Safe to run more than one worker or web instance later without double sending beyond the at-least-once contract.

**Non-Goals:**
- Write endpoints. Only their conventions are set here; consent, attendance and other writes arrive with their own changes.
- Events for decisions. The "speakers informed" events arrive with the staged-decisions change; today's internal decision recording emits nothing.
- Exactly-once delivery or guaranteed ordering.
- Replaying history to endpoints added later. A new endpoint receives events recorded after it was created.

## Decisions

### 1. Transactional outbox in PostgreSQL
Events are inserted into an `events` table inside the same transaction as the change. Delivery rows (`webhook_deliveries`, one per event and subscribed endpoint) are created in that same transaction.
- *Why:* guarantees the "recorded with the change" requirement without a message broker.
- *Alternative:* sending the HTTP request straight from the server action. Rejected: a slow or failing n8n would slow or fail the speaker's submission, and a crash between saving and sending would lose the event.
- Registration and profile saves move inside `transaction()` so they can record events atomically. Library functions that record events take the transaction client.

### 2. Delivery rows created at record time, including for paused endpoints
Creating deliveries up front, even for paused endpoints, means pausing an endpoint queues its events instead of dropping them, as the spec requires. The worker skips deliveries whose endpoint is paused. Deleting an endpoint deletes its pending deliveries.

### 3. A separate worker process
`npm run worker` runs `scripts/worker.ts`, a loop that claims due deliveries with `SELECT … FOR UPDATE SKIP LOCKED`, sends them, and records the outcome. It wakes on PostgreSQL `LISTEN/NOTIFY` when a new event is recorded, and otherwise polls every few seconds as a fallback.
- *Why:* the web server stays fast and stateless, several workers can run safely, and it suits a VPS or container host.
- *Alternative:* a timer inside the Next.js server via `instrumentation.ts`. Rejected: every web instance and every dev hot reload would start its own loop, and work would stop whenever the web server restarts.
- `docker-compose.yml` gains a `worker` service; the README documents running both processes (for example, with systemd or two containers).

### 4. Retry schedule
Attempts happen at about 0, 1 min, 5 min, 15 min, 1 h, 3 h, 6 h, 12 h and 24 h after the first try, roughly 46 hours in total, which meets "at least 24 hours". Each attempt has a 10-second timeout and does not follow redirects. 2xx counts as success; anything else, including timeouts and 3xx, is a failure. A manual resend creates a fresh attempt for the same event without changing its `id`.

### 5. Signing and secret storage
Signature: `sha256=` + hex HMAC-SHA256 of `<unix seconds>.<raw body>`, sent with the headers named in the spec. Including the timestamp lets receivers reject old replays.
- The signing secret must be readable to sign, so it is stored in the database, not hashed. Anyone who can read the database can already read every speaker's personal data, so encrypting the secret alone adds little.
- *Alternative:* encrypting secrets with a key from an environment variable. Rejected for now because it adds a setting non-technical hosts must manage; it can be added later without changing the spec.
- n8n checks signatures with a short Code node; the README includes a ready-made snippet. Endpoints can also add a custom header, such as n8n's Header Auth, as a simpler alternative.

### 6. Protecting the server from outbound abuse (SSRF)
Webhook URLs are entered by organisers, so the server could be pointed at internal addresses (for example, a cloud metadata service). In production the worker resolves the hostname and refuses private, loopback and link-local addresses. In development, `localhost` is allowed so a local n8n can be used.

### 7. API keys
Keys look like `fost_live_<prefix>_<secret>`. Only a SHA-256 hash is stored; the prefix is stored in plain text so organisers can tell keys apart. Revocation sets `revoked_at`. Last-used time is updated at most once a minute per key, to avoid a database write on every request.

### 8. Rate limiting in memory
A fixed one-minute window per key, counted in the web process.
- *Why:* the app runs as a single web process for now, and this needs no extra infrastructure.
- *Trade-off:* with several web processes, each counts separately. If the app scales out, the counter can move to PostgreSQL without changing the spec.

### 9. One payload builder
`src/lib/payloads.ts` builds the speaker, proposal and conference objects used in event `data` and API responses. It uses `publicStatus()` for the status, so the "no organiser-only information" rule lives in one place and is tested once. Conference dates come with `date_precision: "day"`. When a conference has no dates, the dates are `null` and the precision is `null`. Month-only precision arrives with the change that adds month-only dates.

### 10. Data retention
A daily step in the worker deletes payloads from the delivery log and event bodies older than 30 days once no delivery for them is still pending. It keeps a slim row (type, time, status) so the log still shows history.

## Risks / Trade-offs

- [The worker isn't running in production, so nothing reaches n8n] → The Integrations page shows when the worker last checked in, and warns if it is more than a few minutes ago.
- [Duplicate deliveries after a worker crash mid-send] → The at-least-once contract and the stable event `id`; the README shows how to de-duplicate in n8n.
- [Personal data sent to a mistyped or hostile URL] → Admin-only management, HTTPS required, the SSRF guard, the signing secret, and a "Send test event" button to check an endpoint before real data flows.
- [A slow endpoint holds up others] → The 10-second timeout and claiming deliveries per endpoint in parallel, a few at a time.
- [Event volume grows with every edit] → One small row per event and 30-day retention of bodies; edits that change nothing record nothing.

## Migration Plan

1. Migration `002_integration_events.sql` adds `events`, `webhook_endpoints`, `webhook_deliveries` and `api_keys`. It only adds tables, so it is safe to apply to a live database.
2. Deploy the web app, then start the worker. Until an organiser adds an endpoint, events are recorded with no deliveries.
3. Rollback: stop the worker and deploy the previous web version. The extra tables are ignored by older code and can be dropped later.

## Open Questions

- Fine-tuning the retry schedule once real n8n failure patterns are known. This doesn't affect the spec, which only requires at least 24 hours.
