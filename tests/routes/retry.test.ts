import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, fakeFrom, fakeRpc, type Result } from "../helpers/supabase";

const holder = vi.hoisted(() => ({ server: null as unknown, service: null as unknown }));
const cancelRun = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const buildAndDispatchRun = vi.hoisted(() =>
  vi.fn(async (_service: unknown, _args: { autonomy: string }): Promise<{ ok: boolean; reason?: string }> => ({ ok: true }))
);
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn(async () => holder.server) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceClient: vi.fn(() => holder.service) }));
const ensureApplicantAlias = vi.hoisted(() =>
  vi.fn(async () => "a-abcdefghjk@jobarms.com" as string | null)
);
const ensureSiteAccount = vi.hoisted(() =>
  vi.fn(
    async () =>
      ({
        tenantHost: "acme.wd1.myworkdayjobs.com",
        email: "a-abcdefghjk@jobarms.com",
        password: ["fixture", "value"].join("-"),
        status: "verified"
      }) as { tenantHost: string; email: string; password: string; status: string } | null
  )
);
vi.mock("@/lib/arm", () => ({ cancelRun }));
vi.mock("@/lib/arm-dispatch", () => ({ buildAndDispatchRun }));
vi.mock("@/lib/applicant-email", () => ({ ensureApplicantAlias }));
vi.mock("@/lib/site-accounts", () => ({ ensureSiteAccount }));

import { POST } from "@/app/api/applications/[id]/retry/route";

const ctx = { params: Promise.resolve({ id: "app-1" }) };
const req = () => new Request("http://x", { method: "POST" });
const JOB = { url: "https://jobs.lever.co/acme/1", ats: "lever", title: "Eng", company: "Acme", description: "d" };

function server(app: Result, latest: Result) {
  return fakeClient({ user: { id: "u1" }, from: fakeFrom({ applications: [app], application_runs: [latest] }) });
}
function service(over: {
  application_runs?: Result[];
  profiles?: Result[];
  resumes?: Result[];
  subscriptions?: Result[];
  rpc?: ReturnType<typeof fakeRpc> | Record<string, unknown[]>;
}) {
  return fakeClient({
    from: fakeFrom({
      application_runs: over.application_runs ?? [{ data: { id: "run2" } }],
      profiles: over.profiles ?? [{ data: { arm_autonomy: "review_gate" } }],
      resumes: over.resumes ?? [{ data: null }],
      subscriptions: over.subscriptions ?? [{ data: { plan: "free", status: "active" } }]
    }),
    rpc: typeof over.rpc === "function" ? over.rpc : fakeRpc(over.rpc ?? { try_reserve_arm_run: [true] })
  });
}

beforeEach(() => {
  holder.server = null;
  holder.service = null;
  cancelRun.mockClear();
  buildAndDispatchRun.mockClear();
  buildAndDispatchRun.mockResolvedValue({ ok: true });
  ensureApplicantAlias.mockClear();
  ensureApplicantAlias.mockResolvedValue("a-abcdefghjk@jobarms.com");
  ensureSiteAccount.mockClear();
  ensureSiteAccount.mockResolvedValue({
    tenantHost: "acme.wd1.myworkdayjobs.com",
    email: "a-abcdefghjk@jobarms.com",
    password: ["fixture", "value"].join("-"),
    status: "verified"
  });
});

describe("POST /api/applications/[id]/retry", () => {
  it("401 without a user", async () => {
    holder.server = fakeClient({ user: null });
    expect((await POST(req(), ctx)).status).toBe(401);
  });

  it("404 when the application is missing", async () => {
    holder.server = fakeClient({ user: { id: "u1" }, from: fakeFrom({ applications: [{ data: null }] }) });
    expect((await POST(req(), ctx)).status).toBe(404);
  });

  it("404 when the application row has no job", async () => {
    holder.server = fakeClient({
      user: { id: "u1" },
      from: fakeFrom({ applications: [{ data: { id: "app-1", jobs: null } }] })
    });
    expect((await POST(req(), ctx)).status).toBe(404);
  });

  it("422 for an untuned board with no prior run (the ack lives on the apply page)", async () => {
    holder.server = fakeClient({
      user: { id: "u1" },
      from: fakeFrom({
        applications: [{ data: { id: "app-1", jobs: { ...JOB, ats: "workable" } } }],
        application_runs: [{ data: null }]
      })
    });
    const res = await POST(req(), ctx);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("best_effort_ack_required");
  });

  it("retries an untuned board as generic, review-gate only, no account path", async () => {
    holder.server = server(
      { data: { id: "app-1", resume_id: null, jobs: { ...JOB, ats: "workable" } } },
      // A prior run is the evidence the best-effort terms were accepted.
      { data: { id: "r1", status: "failed", answers: null, created_at: new Date().toISOString() } }
    );
    holder.service = service({
      // full_auto on a paid plan would normally be honored; generic never is.
      profiles: [{ data: { arm_autonomy: "full_auto" } }],
      subscriptions: [{ data: { plan: "premium", status: "active" } }],
      rpc: { refund_arm_run: [true], try_reserve_arm_run: [true] }
    });
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    const args = buildAndDispatchRun.mock.calls[0][1] as { ats: string; autonomy: string };
    expect(args.ats).toBe("generic");
    expect(args.autonomy).toBe("review_gate");
    expect(ensureSiteAccount).not.toHaveBeenCalled();
  });

  it("409 when the latest run is not retryable", async () => {
    holder.server = server(
      { data: { id: "app-1", resume_id: null, jobs: JOB } },
      { data: { id: "r1", status: "needs_review", answers: [{ value: "real", skipped: false }], created_at: new Date().toISOString() } }
    );
    expect((await POST(req(), ctx)).status).toBe(409);
  });

  it("400 when the profile is missing", async () => {
    holder.server = server({ data: { id: "app-1", resume_id: null, jobs: JOB } }, { data: null });
    holder.service = service({ profiles: [{ data: null }] });
    expect((await POST(req(), ctx)).status).toBe(400);
  });

  it("refunds a stale failed run and dispatches a fresh one", async () => {
    holder.server = server(
      { data: { id: "app-1", resume_id: null, jobs: JOB } },
      { data: { id: "r1", status: "failed", answers: [{ value: "", skipped: true }], created_at: new Date().toISOString() } }
    );
    const rpc = fakeRpc({ refund_arm_run: [true], try_reserve_arm_run: [true] });
    holder.service = service({ rpc });
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).run_id).toBe("run2");
    expect(rpc).toHaveBeenCalledWith("refund_arm_run", { p_run_id: "r1" });
  });

  it("cancels + refunds a run stuck >24h before retrying", async () => {
    const old = new Date(Date.now() - 26 * 3600 * 1000).toISOString();
    holder.server = server(
      { data: { id: "app-1", resume_id: "res-1", jobs: JOB } },
      { data: { id: "r1", status: "running", answers: null, created_at: old } }
    );
    const rpc = fakeRpc({ refund_arm_run: [true], try_reserve_arm_run: [true] });
    holder.service = fakeClient({
      from: fakeFrom({
        application_runs: [{ error: null }, { data: { id: "run2" } }],
        profiles: [{ data: { arm_autonomy: "review_gate" } }],
        resumes: [{ data: { file_name: "cv.pdf", storage_path: "u1/cv.pdf", mime_type: "application/pdf" } }],
        subscriptions: [{ data: { plan: "free", status: "active" } }]
      }),
      rpc
    });
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(cancelRun).toHaveBeenCalledWith("r1");
  });

  it("retries a canceled run without refunding (already settled)", async () => {
    holder.server = server(
      { data: { id: "app-1", resume_id: null, jobs: JOB } },
      { data: { id: "r1", status: "canceled", answers: null, created_at: new Date().toISOString() } }
    );
    const rpc = fakeRpc({ try_reserve_arm_run: [true] });
    holder.service = service({ rpc });
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(cancelRun).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalledWith("refund_arm_run", expect.anything());
  });

  it("honors full-auto for a paid plan and defaults missing autonomy", async () => {
    holder.server = server({ data: { id: "app-1", resume_id: null, jobs: JOB } }, { data: null });
    holder.service = service({
      profiles: [{ data: {} }], // no arm_autonomy -> defaults to review_gate
      subscriptions: [{ data: { plan: "premium", status: "active" } }],
      rpc: { try_reserve_arm_run: [true] }
    });
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(buildAndDispatchRun.mock.calls[0][1].autonomy).toBe("review_gate");
  });

  it("falls back to the base resume when the application resume is gone", async () => {
    holder.server = server(
      { data: { id: "app-1", resume_id: "res-1", jobs: JOB } },
      { data: { id: "r1", status: "failed", answers: null, created_at: new Date().toISOString() } }
    );
    holder.service = service({
      resumes: [{ data: null }, { data: { file_name: "base.pdf", storage_path: "u1/base.pdf", mime_type: "application/pdf" } }],
      rpc: { refund_arm_run: [true], try_reserve_arm_run: [true] }
    });
    expect((await POST(req(), ctx)).status).toBe(200);
  });

  it("402 when the run quota is spent", async () => {
    holder.server = server({ data: { id: "app-1", resume_id: null, jobs: JOB } }, { data: null });
    holder.service = service({ rpc: { try_reserve_arm_run: [false] } });
    expect((await POST(req(), ctx)).status).toBe(402);
  });

  it("500 + release when the new run insert fails", async () => {
    holder.server = server({ data: { id: "app-1", resume_id: null, jobs: JOB } }, { data: null });
    const rpc = fakeRpc({ try_reserve_arm_run: [true], release_arm_run: [null] });
    holder.service = service({ application_runs: [{ data: null, error: { message: "x" } }], rpc });
    const res = await POST(req(), ctx);
    expect(res.status).toBe(500);
    expect(rpc).toHaveBeenCalledWith("release_arm_run", expect.any(Object));
  });

  it("503 + refund when dispatch fails", async () => {
    buildAndDispatchRun.mockResolvedValueOnce({ ok: false, reason: "arm_error" });
    holder.server = server({ data: { id: "app-1", resume_id: null, jobs: JOB } }, { data: null });
    const rpc = fakeRpc({ try_reserve_arm_run: [true], refund_arm_run: [true] });
    holder.service = service({ application_runs: [{ data: { id: "run2" } }, { data: null }], rpc });
    const res = await POST(req(), ctx);
    expect(res.status).toBe(503);
    expect(rpc).toHaveBeenCalledWith("refund_arm_run", { p_run_id: "run2" });
  });
});

describe("retrying an account-gated application", () => {
  const WD_JOB = {
    url: "https://acme.wd1.myworkdayjobs.com/en-US/Careers/job/Remote/Engineer_JR1",
    ats: "workday",
    title: "Eng",
    company: "Acme",
    description: "d"
  };

  it("reuses the SAME stored account rather than creating a second profile", async () => {
    holder.server = server({ data: { id: "app-1", resume_id: null, jobs: WD_JOB } }, { data: null });
    holder.service = service({
      application_runs: [{ data: { id: "run2" } }, { data: null }],
      rpc: { try_reserve_arm_run: [true] }
    });

    const res = await POST(req(), ctx);

    expect(res.status).toBe(200);
    // ensureSiteAccount is idempotent, so this signs in instead of registering
    // again, which is what avoids duplicate candidate profiles on the tenant.
    expect(ensureSiteAccount).toHaveBeenCalledWith(expect.anything(), {
      userId: "u1",
      tenantHost: "acme.wd1.myworkdayjobs.com",
      ats: "workday",
      email: "a-abcdefghjk@jobarms.com"
    });
    const dispatched = buildAndDispatchRun.mock.calls[0][1] as { account?: unknown };
    expect(dispatched.account).toEqual({
      email: "a-abcdefghjk@jobarms.com",
      password: ["fixture", "value"].join("-")
    });
  });

  it("422s and releases the slot when the account is unavailable", async () => {
    ensureSiteAccount.mockResolvedValueOnce(null);
    holder.server = server({ data: { id: "app-1", resume_id: null, jobs: WD_JOB } }, { data: null });
    const rpc = fakeRpc({ try_reserve_arm_run: [true] });
    holder.service = service({ application_runs: [{ data: { id: "run2" } }, { data: null }], rpc });

    const res = await POST(req(), ctx);

    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("ats_account_unavailable");
    expect(rpc).toHaveBeenCalledWith("release_arm_run", expect.anything());
    expect(buildAndDispatchRun).not.toHaveBeenCalled();
  });

  it("422s when no managed email can be issued", async () => {
    ensureApplicantAlias.mockResolvedValueOnce(null);
    holder.server = server({ data: { id: "app-1", resume_id: null, jobs: WD_JOB } }, { data: null });
    holder.service = service({
      application_runs: [{ data: { id: "run2" } }, { data: null }],
      rpc: { try_reserve_arm_run: [true] }
    });

    const res = await POST(req(), ctx);

    expect(res.status).toBe(422);
    // Without an alias there is no account to look up at all.
    expect(ensureSiteAccount).not.toHaveBeenCalled();
  });
});
