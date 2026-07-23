import { Resend } from "resend";

/**
 * Transactional email via Resend. Gracefully no-ops when RESEND_API_KEY is
 * unset (the account + domain verification are a Phase 1 manual checklist
 * item), so nothing upstream ever breaks on email.
 */
export async function sendWelcomeEmail(to: string, firstName: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key || !to) return false;

  try {
    const resend = new Resend(key);
    await resend.emails.send({
      from: "JobArms <hello@jobarms.com>",
      to,
      subject: "Your arms are ready 🦾",
      text: [
        `Hi${firstName ? ` ${firstName}` : ""},`,
        "",
        "Welcome to JobArms. Your profile is set up, which means your arms are ready to work.",
        "",
        "Paste any Greenhouse or Lever job link into the dashboard and an arm will fill out the entire application from your profile - you review every answer before it submits.",
        "",
        "Apply to something: https://jobarms.com/dashboard/applications/new",
        "",
        "- JobArms"
      ].join("\n")
    });
    return true;
  } catch {
    return false;
  }
}
