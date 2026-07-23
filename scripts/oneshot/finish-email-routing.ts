/**
 * One-shot: finish Cloudflare Email Routing for jobarms.com AFTER the
 * destination address (jobarmsteam@gmail.com) has been verified (click the
 * link Cloudflare emailed it). Idempotent.
 *
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/finish-email-routing.ts
 *
 * Creates: hello@jobarms.com forward + catch-all, both -> jobarmsteam@gmail.com.
 */
export {}; // module scope - import-less scripts otherwise collide globally

const ZONE = "d62b0510c0f73b95215b1138eba9f023";
const DEST = "jobarmsteam@gmail.com";

const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) throw new Error("CLOUDFLARE_API_TOKEN not set (source .env first)");

async function cf(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  return (await res.json()) as Record<string, unknown>;
}

async function main() {
  // Preflight: destination must be verified.
  const addresses = (await cf(
    `/accounts/a5cf6e879c42087de72a0ea6fb2dc0af/email/routing/addresses`
  )) as { result?: Array<{ email: string; verified: string | null }> };
  const dest = addresses.result?.find((a) => a.email === DEST);
  if (!dest?.verified) {
    console.error(
      `Destination ${DEST} is NOT verified yet. Click the verification link Cloudflare sent to that inbox, then re-run.`
    );
    process.exit(1);
  }
  console.log(`Destination verified: ${DEST}`);

  // hello@ rule (skip if an identical matcher already exists)
  const rules = (await cf(`/zones/${ZONE}/email/routing/rules`)) as {
    result?: Array<{ matchers?: Array<{ value?: string }> }>;
  };
  const hasHello = rules.result?.some((r) =>
    r.matchers?.some((m) => m.value === "hello@jobarms.com")
  );
  if (hasHello) {
    console.log("hello@ rule already exists");
  } else {
    const created = await cf(`/zones/${ZONE}/email/routing/rules`, {
      method: "POST",
      body: JSON.stringify({
        name: "hello forward",
        enabled: true,
        matchers: [{ type: "literal", field: "to", value: "hello@jobarms.com" }],
        actions: [{ type: "forward", value: [DEST] }]
      })
    });
    console.log("hello@ rule:", created.success ? "created" : JSON.stringify(created.errors));
  }

  const catchAll = await cf(`/zones/${ZONE}/email/routing/rules/catch_all`, {
    method: "PUT",
    body: JSON.stringify({
      name: "catch-all",
      enabled: true,
      matchers: [{ type: "all" }],
      actions: [{ type: "forward", value: [DEST] }]
    })
  });
  console.log("catch-all:", catchAll.success ? "enabled" : JSON.stringify(catchAll.errors));

  console.log("\nDone. Inbound mail to anything@jobarms.com now lands in " + DEST);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
