# jobarms-email-inbound (Cloudflare Email Worker)

Catch-all for `jobarms.com`. Mail addressed to a managed applicant alias
(`a-<10 chars>@jobarms.com`) is parsed and POSTed to the app's
`/api/email/inbound` webhook; everything else is forwarded to
`FALLBACK_FORWARD_TO`, exactly as the plain catch-all did before.

## How it fits together

```
sender -> Cloudflare Email Routing (MX on jobarms.com)
       -> explicit rules (hello@ -> Gmail) match FIRST, untouched
       -> catch-all "Send to a Worker" (this worker)
          |- managed alias  -> POST /api/email/inbound (Bearer EMAIL_INBOUND_SECRET)
          |                    -> log, extract ATS verification, forward to the user
          `- anything else  -> forward to FALLBACK_FORWARD_TO
```

Why the app forwards instead of Email Routing: Routing can only deliver to
**verified** destination addresses, and an arbitrary user's inbox is not one.
The webhook re-sends through Resend (jobarms.com is a verified sender) with
`Reply-To` set to the original sender, so replies reach the recruiter directly.

## Deploy

```bash
cd workers/email-inbound
npm install
npx wrangler secret put EMAIL_INBOUND_SECRET   # MUST match the app's value
npx wrangler deploy
```

Then in the Cloudflare dashboard: **Email Routing -> Routing rules ->
Catch-all -> Action: Send to a Worker -> jobarms-email-inbound -> Save**, and
confirm the catch-all toggle is enabled. Existing explicit rules (hello@ and
any other named address) keep taking precedence.

## Config (`wrangler.jsonc` `[vars]`)

- `APP_INBOUND_URL` - the app webhook (`https://jobarms.com/api/email/inbound`).
- `PLATFORM_EMAIL_DOMAIN` - the zone; mail FROM this domain is dropped (loop guard).
- `FALLBACK_FORWARD_TO` - destination for non-alias catch-all mail.

## Secret

- `EMAIL_INBOUND_SECRET` - shared bearer, `wrangler secret put`, never committed.
