/**
 * One-shot: production Supabase Auth config via the Management API.
 * Idempotent - safe to re-run after edits.
 *
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/configure-supabase-auth.ts
 *
 * Sets:
 *  - site_url -> https://jobarms.com (default confirmation links pointed at
 *    localhost:3000 out of the box)
 *  - redirect allowlist: jobarms.com/** + www + localhost (dev)
 *  - custom SMTP via Resend so every auth email (confirm / magic link /
 *    reset) comes from hello@jobarms.com instead of
 *    noreply@mail.app.supabase.io
 *  - JobArms-branded subjects + HTML templates
 */
export {}; // module scope - import-less scripts otherwise collide globally

const PROJECT_REF = "fjzvlshxcgbuhrhxdsiu";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set (source .env first)`);
  return v;
}

const ACCESS_TOKEN = need("SUPABASE_ACCESS_TOKEN");
const RESEND_KEY = need("RESEND_API_KEY");

/** Shared dark JobArms shell around each email body. */
function shell(heading: string, body: string, cta: { href: string; label: string }): string {
  return `<div style="background:#070b14;padding:40px 16px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif">
  <div style="max-width:480px;margin:0 auto;background:#0c1322;border:1px solid #16203a;border-radius:16px;padding:36px">
    <p style="margin:0 0 24px;font-size:22px;font-weight:700;color:#ffffff">Job<span style="color:#2dd4bf">Arms</span></p>
    <h1 style="margin:0 0 12px;font-size:20px;color:#ffffff">${heading}</h1>
    <p style="margin:0 0 28px;font-size:15px;line-height:1.6;color:#94a3b8">${body}</p>
    <a href="${cta.href}" style="display:inline-block;background:#14b8a6;color:#070b14;font-weight:700;font-size:15px;text-decoration:none;padding:13px 28px;border-radius:999px">${cta.label}</a>
    <p style="margin:28px 0 0;font-size:12px;color:#475569">If you didn't request this, you can safely ignore this email.</p>
  </div>
  <p style="max-width:480px;margin:16px auto 0;font-size:11px;color:#475569;text-align:center">JobArms &middot; your AI applies, you interview &middot; <a href="https://jobarms.com" style="color:#2dd4bf;text-decoration:none">jobarms.com</a></p>
</div>`;
}

const config = {
  site_url: "https://jobarms.com",
  uri_allow_list:
    "https://jobarms.com/**,https://www.jobarms.com/**,http://localhost:3000/**",

  // Outbound auth email via Resend (same domain as the app's email)
  smtp_admin_email: "hello@jobarms.com",
  smtp_host: "smtp.resend.com",
  smtp_port: "587",
  smtp_user: "resend",
  smtp_pass: RESEND_KEY,
  smtp_sender_name: "JobArms",

  mailer_subjects_confirmation: "Confirm your JobArms account",
  mailer_templates_confirmation_content: shell(
    "One click and your arms are ready",
    "Confirm your email address to finish creating your JobArms account. Then upload your resume and send your first arm after a job.",
    { href: "{{ .ConfirmationURL }}", label: "Confirm my email" }
  ),

  mailer_subjects_magic_link: "Your JobArms sign-in link",
  mailer_templates_magic_link_content: shell(
    "Sign in to JobArms",
    "Click the button below to sign in. This link expires shortly and can be used once.",
    { href: "{{ .ConfirmationURL }}", label: "Sign in" }
  ),

  mailer_subjects_recovery: "Reset your JobArms password",
  mailer_templates_recovery_content: shell(
    "Reset your password",
    "Someone (hopefully you) asked to reset the password for this JobArms account.",
    { href: "{{ .ConfirmationURL }}", label: "Choose a new password" }
  ),

  mailer_subjects_email_change: "Confirm your new JobArms email",
  mailer_templates_email_change_content: shell(
    "Confirm your new email",
    "Confirm this address to finish changing the email on your JobArms account.",
    { href: "{{ .ConfirmationURL }}", label: "Confirm new email" }
  )
};

async function main() {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/config/auth`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(config)
    }
  );
  if (!res.ok) {
    throw new Error(`auth config PATCH failed: ${res.status} ${(await res.text()).slice(0, 400)}`);
  }
  const applied = (await res.json()) as Record<string, unknown>;
  console.log("site_url:", applied.site_url);
  console.log("uri_allow_list:", applied.uri_allow_list);
  console.log("smtp_host:", applied.smtp_host, "| sender:", applied.smtp_admin_email);
  console.log("confirmation subject:", applied.mailer_subjects_confirmation);
  console.log("\nAuth config applied.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
