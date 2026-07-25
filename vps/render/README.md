# jobarms-render (browser sidecar)

The arm's browser. A long-lived Express + Playwright service that **holds
sessions**, which is the capability Cloudflare Browser Rendering could not
provide and the reason JobArms was stuck on Greenhouse and Lever.

## Why it exists

Applying on Workday means creating a candidate account on the employer's own
tenant, verifying an email, and then walking a multi-page wizard, all inside one
logged-in session. Browser Rendering opened a throwaway browser per phase, so
cookies never survived. It also capped us at roughly 10 browser-minutes/day on
free and ran from datacenter IPs that invisible captchas score as bot-like.

This service fixes all three at once, so it became the browser for **every** ATS,
not just the account-gated ones.

## How it fits together

```
apply-arm Worker (orchestration: review gate, verification wait, retries)
    |  HTTPS + bearer, one request per phase
    v
Cloudflare Tunnel  ->  127.0.0.1:8085 (this service)
    |
    +-- per-user-per-tenant Chromium contexts, cookies persisted to disk
```

The Worker keeps owning durable state; this box only drives a browser. It holds
no Supabase or Gemini credentials: the playbook to try, the vision diagnosis, and
the resume BYTES all arrive in the request, and the winning strategy goes back in
the response for the Worker to record.

## Captcha solving

Solving a grid challenge needs two things that live in different places on
purpose: the LIVE PAGE (only this service has it) and a VISION MODEL (only the
worker has the credentials). So the model stays on the edge and this service
calls out to it:

```
submit blocked by a grid challenge
  -> screenshot the grid + read the instruction   (here)
  -> POST /internal/solve-captcha                 (worker: runs Gemini)
  -> click the returned tiles, verify, resubmit   (here)
```

Bounded by `RENDER_CHALLENGE_BUDGET_MS`, three grids for reCAPTCHA and two for
hCaptcha. When it cannot be cleared the outcome is `captcha_blocked`, which is
the honest answer: everything is filled and the employer's bot check stopped the
send. Leave `RENDER_SOLVER_URL` unset to disable solving entirely.

This only applies to VISIBLE grid challenges. Invisible reCAPTCHA v3/Enterprise
has no image to look at; it scores the session by IP reputation and fingerprint,
which is what owning this browser is for.

## Endpoints

All require `Authorization: Bearer $RENDER_TOKEN` except `/health`.

| Route | Purpose |
|---|---|
| `GET /health` | liveness + live session count |
| `POST /session/ensure` | sign in or create the candidate account on this tenant |
| `POST /verify` | finish an email verification inside the held session |
| `POST /extract` | reach the form and read its fields (walks wizard pages) |
| `POST /fill` | fill approved answers, optionally submit |

**Application errors return HTTP 200** with `{ error, detail }`. This is not
sloppiness: Cloudflare replaces the body of any origin 5xx with its own error
page, which would erase the structured code and make the Worker retry a
permanent failure. Client errors (400/401) keep their status, since 4xx passes
through. Error codes: `invalid_or_unsafe_url`, `invalid_body`, `form_not_found`,
`needs_email_verification`, `login_failed`, `render_failed`.

## Session model

Contexts are keyed `userId:tenantHost` and their cookies are written to disk as
Playwright `storageState`, so a login survives a process restart and the
seven-day review gate. Concurrency safety is deliberate and load-bearing:

- The map slot is reserved **synchronously**, before the browser launch is
  awaited, so two concurrent first-callers share one context instead of leaking a
  duplicate (and a duplicate candidate account).
- Entries carry an `inUse` refcount. Only idle entries are evicted, so a context
  is never closed out from under an in-flight request.
- A poisoned session (failed login, render error) is dropped from the map at once
  so nothing NEW reuses it, but stays open until the last holder releases it.

## Security posture

- Binds `127.0.0.1` only. The tunnel connects outward, so the box exposes no
  listener. Deliberate, since it starts life on a **shared** VPS.
- Bearer auth on every route but `/health`, rate-limited **before** auth so a
  guessed token cannot be brute-forced and one caller cannot exhaust the pool.
- SSRF guard on every navigation URL: http(s) only, no localhost, private,
  link-local, or CGNAT IPv4, no IPv6 literals, no metadata or `*.internal` hosts.
- **The service never fetches a caller-supplied URL.** The resume arrives as
  bytes in the request rather than a URL to fetch, so there is no code path that
  can be pointed at an attacker-chosen address. The caller already holds the
  signed Storage URL and the credentials to read it. The one outbound call, the
  captcha solve callback, goes to a FIXED endpoint from config, never to
  anything in a request.
- The solve callback carries **its own bearer**, not the app-to-worker shared
  secret, so a compromise of this box can ask for captcha tile picks and nothing
  else. It cannot start, approve, or cancel a run.
- The state directory path is a **hash** of the session key, so a hostile tenant
  hostname cannot traverse out of it.
- systemd runs it with `NoNewPrivileges`, `ProtectSystem=full`, `PrivateTmp`, a
  2G memory cap, and write access to nothing but its own state directory.

## Development

```bash
npm install          # add --ignore-scripts to skip the Chromium download
npm run check        # tsc --noEmit
npm test             # vitest, 100% coverage gate
npm run dev          # tsx watch (needs a real Chromium)
```

Tests are hermetic: Playwright is mocked and the in-page callbacks
(`collectFieldsInPage`, `comboboxValueInPage`, and friends) are exported and run
against crafted fake DOM nodes, the same approach the apply-arm worker uses. Real
browser behavior is still validated end to end by `debug/smoke-arm-run.ts`.

## Deploy

```bash
RENDER_TOKEN=$(openssl rand -hex 32) ./scripts/deploy.sh root@<host>
```

Idempotent, so re-run it to upgrade. Then, once: point a Cloudflare Tunnel
hostname (`browser.jobarms.com`) at `http://127.0.0.1:8085` on the box, and set
`RENDER_URL` + `RENDER_TOKEN` in the app and worker environments.

### Hosting

Starts on the existing internal Hostinger **KVM1** (1 vCPU / 4GB), which is
already proven to run a Chromium sidecar. It is namespaced end to end (own port,
unit, state dir, tunnel hostname, and token) so it shares nothing with the other
services there. Concurrency is capped at 2 contexts to suit that hardware; move
to a dedicated box and raise the caps when arm volume justifies it.

## Config

| Env | Default | Notes |
|---|---|---|
| `PORT` | 8080 | deploy script sets 8085 |
| `RENDER_TOKEN` | "" | required in production; empty disables auth for local dev |
| `RENDER_STATE_DIR` | `/var/lib/jobarms-render/state` | persisted cookies |
| `RENDER_NAV_TIMEOUT_MS` | 30000 | per navigation |
| `RENDER_ACTION_TIMEOUT_MS` | 20000 | per Playwright action |
| `RENDER_SESSION_TTL_MS` | 1800000 | idle session eviction |
| `RENDER_MAX_SESSIONS` | 8 | cached contexts |
| `RENDER_MAX_CONCURRENCY` | 2 | in-flight browser phases; the rest queue |
| `RENDER_MAX_WIZARD_PAGES` | 12 | bound on wizard pages per request |
| `RENDER_SOLVER_URL` | "" | the worker's `/internal/solve-captcha`; unset disables solving |
| `RENDER_SOLVER_TOKEN` | "" | bearer for it, scoped to that endpoint only |
| `RENDER_SOLVER_TIMEOUT_MS` | 30000 | per solve request |
| `RENDER_CHALLENGE_BUDGET_MS` | 90000 | wall clock to clear one challenge |
| `RENDER_RATE_WINDOW_MS` / `RENDER_RATE_MAX` | 60000 / 60 | rate limit |
