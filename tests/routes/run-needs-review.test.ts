import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, fakeFrom } from "../helpers/supabase";

const holder = vi.hoisted(() => ({ service: null as unknown }));
const sendReviewNeededEmail = vi.hoisted(() =>
  vi.fn(
    async (_args: {
      to: string;
      firstName: string;
      company: string;
      jobTitle: string;
      applicationId: string;
      fields: string[];
    }) => ({ ok: true }) as { ok: true } | { ok: false; reason: string }
  )
);

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceClient: vi.fn(() => holder.service)
}));
vi.mock("@/lib/email", () => ({ sendReviewNeededEmail }));

import { POST } from "@/app/api/internal/run-needs-review/route";

const SECRET = "arm-secret";
const RUN = "11111111-1111-4111-8111-111111111111";
const APP = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

function post(body: unknown, auth: string | null = `Bearer ${SECRET}`) {
  return new Request("http://x/api/internal/run-needs-review", {
    method: "POST",
    headers: auth ? { authorization: auth } : {},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

const payload = (over: Record<string, unknown> = {}) => ({
  runId: RUN,
  applicationId: APP,
  userId: USER,
  fields: ["Sanctions and export controls"],
  ...over
});

/** A service client that finds the user and the job behind the application. */
function serviceWith(
  over: { profile?: unknown; application?: unknown } = {}
): ReturnType<typeof fakeClient> {
  const profile =
    "profile" in over ? over.profile : { email: "user@example.com", full_name: "Brian Lane" };
  const application =
    "application" in over
      ? over.application
      : { jobs: { company: "Databricks", title: "Staff Engineer" } };
  return fakeClient({
    from: fakeFrom({
      profiles: [{ data: profile, error: null }],
      applications: [{ data: application, error: null }]
    })
  });
}

beforeEach(() => {
  process.env.ARM_WORKER_SHARED_SECRET = SECRET;
  sendReviewNeededEmail.mockClear();
  sendReviewNeededEmail.mockResolvedValue({ ok: true });
  holder.service = serviceWith();
});

describe("POST /api/internal/run-needs-review", () => {
  it("emails the run's owner about the job by name", async () => {
    const res = await POST(post(payload()));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sent: true });
    expect(sendReviewNeededEmail).toHaveBeenCalledWith({
      to: "user@example.com",
      firstName: "Brian",
      company: "Databricks",
      jobTitle: "Staff Engineer",
      applicationId: APP,
      fields: ["Sanctions and export controls"]
    });
  });

  it("refuses a caller without the worker's secret", async () => {
    expect((await POST(post(payload(), "Bearer wrong"))).status).toBe(401);
    expect((await POST(post(payload(), null))).status).toBe(401);
    expect(sendReviewNeededEmail).not.toHaveBeenCalled();
  });

  it("rejects a body it cannot trust", async () => {
    expect((await POST(post({ runId: "not-a-uuid" }))).status).toBe(400);
    expect((await POST(post(undefined))).status).toBe(400);
    expect(sendReviewNeededEmail).not.toHaveBeenCalled();
  });

  it("says so plainly when there is no address on file", async () => {
    holder.service = serviceWith({ profile: null });

    const res = await POST(post(payload()));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sent: false, reason: "no_recipient_on_file" });
    expect(sendReviewNeededEmail).not.toHaveBeenCalled();
  });

  it("still sends when the job behind the application cannot be read", async () => {
    // The point of the mail is the parked run, not the job title.
    holder.service = serviceWith({ application: null });

    await POST(post(payload()));

    expect(sendReviewNeededEmail).toHaveBeenCalledWith(
      expect.objectContaining({ company: "", jobTitle: "" })
    );
  });

  it("copes with a profile that has no name", async () => {
    holder.service = serviceWith({ profile: { email: "user@example.com", full_name: null } });

    await POST(post(payload()));

    expect(sendReviewNeededEmail).toHaveBeenCalledWith(expect.objectContaining({ firstName: "" }));
  });

  it("reports a refused send WITHOUT asking to be retried", async () => {
    // A non-2xx would invite a retry, and retrying an email while a user's run
    // sits parked helps nobody.
    sendReviewNeededEmail.mockResolvedValue({ ok: false, reason: "daily_quota_exceeded" });

    const res = await POST(post(payload()));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      sent: false,
      reason: "daily_quota_exceeded"
    });
  });

  it("defaults to naming no fields rather than failing", async () => {
    await POST(post({ runId: RUN, applicationId: APP, userId: USER }));

    expect(sendReviewNeededEmail).toHaveBeenCalledWith(expect.objectContaining({ fields: [] }));
  });
});
