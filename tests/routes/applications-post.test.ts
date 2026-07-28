import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBucket, fakeClient, fakeFrom, fakeRpc, type Result } from "../helpers/supabase";

const holder = vi.hoisted(() => ({ server: null as unknown, service: null as unknown }));
const mocks = vi.hoisted(() => ({
  fetchJobMeta: vi.fn(),
  tailorResume: vi.fn(),
  renderResumePdf: vi.fn(),
  buildAndDispatchRun: vi.fn(),
  ensureApplicantAlias: vi.fn(async () => "a-abcdefghjk@jobarms.com" as string | null),
  ensureSiteAccount: vi.fn(
    async () =>
      ({
        tenantHost: "acme.wd1.myworkdayjobs.com",
        email: "a-abcdefghjk@jobarms.com",
        password: ["fixture", "value"].join("-"),
        status: "pending_verification"
      }) as {
        tenantHost: string;
        email: string;
        password: string;
        status: string;
      } | null
  )
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn(async () => holder.server) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceClient: vi.fn(() => holder.service) }));
vi.mock("@/lib/job-fetch", () => ({ fetchJobMeta: mocks.fetchJobMeta }));
vi.mock("@/lib/tailor", () => ({ tailorResume: mocks.tailorResume }));
vi.mock("@/lib/resume-pdf", () => ({ renderResumePdf: mocks.renderResumePdf }));
vi.mock("@/lib/arm-dispatch", () => ({ buildAndDispatchRun: mocks.buildAndDispatchRun }));
vi.mock("@/lib/applicant-email", () => ({ ensureApplicantAlias: mocks.ensureApplicantAlias }));
vi.mock("@/lib/site-accounts", () => ({ ensureSiteAccount: mocks.ensureSiteAccount }));

import { POST } from "@/app/api/applications/route";

const GH = "https://boards.greenhouse.io/acme/jobs/1";
const META = { company: "Acme", title: "Engineer", location: "Remote", description: "d", ats: "greenhouse" };
const VALID_RESUME = {
  full_name: "Jane", email: "", phone: "", location: "", headline: "", summary: "",
  links: {}, work_history: [], education: [], skills: []
};

const post = (body: unknown) => new Request("http://x", { method: "POST", body: JSON.stringify(body) });

function service(over: {
  jobs?: Result[];
  applications?: Result[];
  profiles?: Result[];
  resumes?: Result[];
  subscriptions?: Result[];
  application_runs?: Result[];
  rpc?: Record<string, unknown[]>;
  bucket?: ReturnType<typeof fakeBucket>;
}) {
  return fakeClient({
    from: fakeFrom({
      jobs: over.jobs ?? [{ data: { id: "job1" } }],
      applications: over.applications ?? [],
      profiles: over.profiles ?? [{ data: { arm_autonomy: "review_gate" } }],
      resumes: over.resumes ?? [{ data: null }],
      subscriptions: over.subscriptions ?? [{ data: { plan: "free", status: "active" } }],
      application_runs: over.application_runs ?? [{ data: { id: "run1" } }]
    }),
    rpc: fakeRpc(over.rpc ?? {}),
    bucket: over.bucket
  });
}

beforeEach(() => {
  holder.server = null;
  holder.service = null;
  vi.clearAllMocks();
  mocks.fetchJobMeta.mockResolvedValue(META);
  mocks.buildAndDispatchRun.mockResolvedValue({ ok: true });
  mocks.ensureApplicantAlias.mockResolvedValue("a-abcdefghjk@jobarms.com");
  mocks.ensureSiteAccount.mockResolvedValue({
    tenantHost: "acme.wd1.myworkdayjobs.com",
    email: "a-abcdefghjk@jobarms.com",
    password: ["fixture", "value"].join("-"),
    status: "pending_verification"
  });
  mocks.tailorResume.mockResolvedValue({ resume: VALID_RESUME, keywords: { incorporated: [], missing: [] } });
  mocks.renderResumePdf.mockResolvedValue(new Uint8Array([1, 2, 3]));
});

describe("POST /api/applications", () => {
  it("401 without a user", async () => {
    holder.server = fakeClient({ user: null });
    expect((await POST(post({ url: GH }))).status).toBe(401);
  });

  it("400 on an invalid body", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    expect((await POST(post({}))).status).toBe(400);
  });

  it("400 when the JSON body is malformed", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    const res = await POST(new Request("http://x", { method: "POST", body: "{" }));
    expect(res.status).toBe(400);
  });

  it("400 on an invalid URL protocol", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    holder.service = service({});
    expect((await POST(post({ url: "javascript:alert(1)" }))).status).toBe(400);
  });

  it("track_only saves a tracker row and returns the id", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    holder.service = service({ jobs: [{ data: null }, { data: { id: "job1" } }], applications: [{ data: null }, { data: { id: "app1" } }] });
    const res = await POST(post({ url: "https://example.com/job", mode: "track_only" }));
    expect(res.status).toBe(200);
    expect((await res.json()).application_id).toBe("app1");
  });

  it("backfills empty fields on an existing job row from the fresh fetch", async () => {
    // A row created before its ATS had a metadata fetcher shows "Untitled
    // role" forever otherwise, because re-pastes reuse the row as-is.
    holder.server = fakeClient({ user: { id: "u1" } });
    const from = fakeFrom({
      jobs: [
        { data: { id: "job1", title: "", company: "", location: "", description: "" } },
        { data: null }
      ],
      applications: [{ data: null }, { data: { id: "app1" } }]
    });
    holder.service = fakeClient({ from, rpc: fakeRpc({}) });

    const res = await POST(post({ url: GH, mode: "track_only" }));
    expect(res.status).toBe(200);

    const jobsQueries = from.mock.calls
      .map((c, i) => ({ table: c[0], query: from.mock.results[i].value }))
      .filter((q) => q.table === "jobs");
    expect(jobsQueries[1].query.update).toHaveBeenCalledWith({
      title: "Engineer",
      company: "Acme",
      location: "Remote",
      description: "d"
    });
  });

  it("backfills only the empty fields, never the populated ones", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    const from = fakeFrom({
      jobs: [
        { data: { id: "job1", title: "Kept Title", company: "", location: "Kept City", description: "" } },
        { data: null }
      ],
      applications: [{ data: null }, { data: { id: "app1" } }]
    });
    holder.service = fakeClient({ from, rpc: fakeRpc({}) });

    await POST(post({ url: GH, mode: "track_only" }));

    const jobsQueries = from.mock.calls
      .map((c, i) => ({ table: c[0], query: from.mock.results[i].value }))
      .filter((q) => q.table === "jobs");
    expect(jobsQueries[1].query.update).toHaveBeenCalledWith({ company: "Acme", description: "d" });
  });

  it("skips the backfill entirely when the fetch returned nothing", async () => {
    // The no-clobber rule's other half: an empty fetch (network hiccup,
    // unknown ATS) must write nothing at all.
    mocks.fetchJobMeta.mockResolvedValueOnce({ company: "", title: "", location: "", description: "", ats: "unknown" });
    holder.server = fakeClient({ user: { id: "u1" } });
    const from = fakeFrom({
      jobs: [{ data: { id: "job1", title: "", company: "", location: "", description: "" } }],
      applications: [{ data: null }, { data: { id: "app1" } }]
    });
    holder.service = fakeClient({ from, rpc: fakeRpc({}) });

    await POST(post({ url: "https://example.com/job", mode: "track_only" }));

    for (let i = 0; i < from.mock.calls.length; i++) {
      if (from.mock.calls[i][0] !== "jobs") continue;
      expect(from.mock.results[i].value.update).not.toHaveBeenCalled();
    }
  });

  it("500 when the job cannot be resolved (insert + race both empty)", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    holder.service = service({ jobs: [{ data: null }, { data: null }, { data: null }] });
    expect((await POST(post({ url: GH }))).status).toBe(500);
  });

  it("409 when an arm application already exists and is in flight", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    holder.service = service({ applications: [{ data: { id: "app1", status: "applied" } }] });
    const res = await POST(post({ url: GH }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("already_applied");
  });

  it("500 when the application insert fails", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    holder.service = service({ applications: [{ data: null }, { data: null }] });
    expect((await POST(post({ url: GH }))).status).toBe(500);
  });

  it("422 asking for the best-effort acknowledgment on an untuned board", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    holder.service = service({ applications: [{ data: null }, { data: { id: "app1" } }] });
    const res = await POST(post({ url: "https://example.com/job", mode: "arm" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("best_effort_ack_required");
    // The job is still saved, so declining costs nothing.
    expect(body.application_id).toBe("app1");
  });

  it("dispatches generic + review-gate-only once the best-effort terms are accepted", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    holder.service = service({
      applications: [{ data: null }, { data: { id: "app1" } }, { data: null }],
      // full_auto on a paid plan would normally be honored; generic never is.
      profiles: [{ data: { arm_autonomy: "full_auto" } }],
      subscriptions: [{ data: { plan: "premium", status: "active" } }],
      rpc: { try_reserve_arm_run: [true] }
    });
    const res = await POST(
      post({ url: "https://example.com/job", mode: "arm", accept_best_effort: true })
    );
    expect(res.status).toBe(200);
    const args = mocks.buildAndDispatchRun.mock.calls[0][1];
    expect(args.ats).toBe("generic");
    expect(args.autonomy).toBe("review_gate");
    // Generic runs never touch the account-vault path.
    expect(mocks.ensureSiteAccount).not.toHaveBeenCalled();
  });

  it("400 when the profile is missing", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    holder.service = service({ applications: [{ data: null }, { data: { id: "app1" } }], profiles: [{ data: null }] });
    expect((await POST(post({ url: GH }))).status).toBe(400);
  });

  it("402 when the run quota is spent", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    holder.service = service({
      applications: [{ data: null }, { data: { id: "app1" } }],
      rpc: { try_reserve_arm_run: [false] }
    });
    const res = await POST(post({ url: GH }));
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("run_limit_reached");
  });

  it("reuses an existing saved application row", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    holder.service = service({
      applications: [{ data: { id: "app1", status: "saved" } }, { data: null }],
      rpc: { try_reserve_arm_run: [true] }
    });
    const res = await POST(post({ url: GH }));
    expect(res.status).toBe(200);
    expect((await res.json()).application_id).toBe("app1");
  });

  it("shows the premium hint when a premium user hits the monthly cap", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    holder.service = service({
      applications: [{ data: null }, { data: { id: "app1" } }],
      subscriptions: [{ data: { plan: "premium", status: "active" } }],
      rpc: { try_reserve_arm_run: [false] }
    });
    const res = await POST(post({ url: GH }));
    expect((await res.json()).hint).toContain("200-run cap");
  });

  it("shows the max hint when a max user hits the daily cap", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    holder.service = service({
      applications: [{ data: null }, { data: { id: "app1" } }],
      subscriptions: [{ data: { plan: "max", status: "active" } }],
      rpc: { try_reserve_arm_run: [false] }
    });
    const res = await POST(post({ url: GH }));
    expect((await res.json()).hint).toContain("today's 100 runs");
  });

  it("503 with a generic hint when dispatch errors", async () => {
    mocks.buildAndDispatchRun.mockResolvedValueOnce({ ok: false, reason: "arm_error" });
    holder.server = fakeClient({ user: { id: "u1" } });
    holder.service = fakeClient({
      from: fakeFrom({
        jobs: [{ data: { id: "job1" } }],
        applications: [{ data: null }, { data: { id: "app1" } }, { data: null }],
        profiles: [{ data: { arm_autonomy: "review_gate" } }],
        resumes: [{ data: null }],
        subscriptions: [{ data: { plan: "free", status: "active" } }],
        application_runs: [{ data: { id: "run1" } }, { data: null }]
      }),
      rpc: fakeRpc({ try_reserve_arm_run: [true], refund_arm_run: [true] })
    });
    const res = await POST(post({ url: GH }));
    expect((await res.json()).hint).toContain("couldn't start");
  });

  it("dispatches a run on the happy path (free, review-gate forced)", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    holder.service = service({
      applications: [{ data: null }, { data: { id: "app1" } }, { data: null }],
      profiles: [{ data: { arm_autonomy: "full_auto" } }], // free -> forced to review_gate
      rpc: { try_reserve_arm_run: [true] }
    });
    const res = await POST(post({ url: GH }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run_id).toBe("run1");
    expect(body.tailored).toBe(false);
    expect(mocks.buildAndDispatchRun.mock.calls[0][1].autonomy).toBe("review_gate");
  });

  it("honors full-auto for a paid plan", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    holder.service = service({
      applications: [{ data: null }, { data: { id: "app1" } }, { data: null }],
      profiles: [{ data: { arm_autonomy: "full_auto" } }],
      subscriptions: [{ data: { plan: "premium", status: "active" } }],
      rpc: { try_reserve_arm_run: [true] }
    });
    await POST(post({ url: GH }));
    expect(mocks.buildAndDispatchRun.mock.calls[0][1].autonomy).toBe("full_auto");
  });

  it("defaults autonomy to review_gate when the profile has none (paid plan)", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    holder.service = service({
      applications: [{ data: null }, { data: { id: "app1" } }, { data: null }],
      profiles: [{ data: {} }], // no arm_autonomy -> ?? "review_gate"
      subscriptions: [{ data: { plan: "premium", status: "active" } }],
      rpc: { try_reserve_arm_run: [true] }
    });
    await POST(post({ url: GH }));
    expect(mocks.buildAndDispatchRun.mock.calls[0][1].autonomy).toBe("review_gate");
  });

  it("500 + refund when the run row insert fails", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    const rpc = fakeRpc({ try_reserve_arm_run: [true], refund_arm_run: [true] });
    holder.service = fakeClient({
      from: fakeFrom({
        jobs: [{ data: { id: "job1" } }],
        applications: [{ data: null }, { data: { id: "app1" } }],
        profiles: [{ data: { arm_autonomy: "review_gate" } }],
        resumes: [{ data: null }],
        subscriptions: [{ data: { plan: "free", status: "active" } }],
        application_runs: [{ data: null, error: { message: "boom" } }]
      }),
      rpc
    });
    const res = await POST(post({ url: GH }));
    expect(res.status).toBe(500);
    expect(rpc).toHaveBeenCalledWith("release_arm_run", { p_user_id: "u1", p_month_key: expect.any(String) });
  });

  it("503 + refund when dispatch fails", async () => {
    mocks.buildAndDispatchRun.mockResolvedValueOnce({ ok: false, reason: "arm_offline" });
    holder.server = fakeClient({ user: { id: "u1" } });
    const rpc = fakeRpc({ try_reserve_arm_run: [true], refund_arm_run: [true] });
    holder.service = fakeClient({
      from: fakeFrom({
        jobs: [{ data: { id: "job1" } }],
        applications: [{ data: null }, { data: { id: "app1" } }, { data: null }],
        profiles: [{ data: { arm_autonomy: "review_gate" } }],
        resumes: [{ data: null }],
        subscriptions: [{ data: { plan: "free", status: "active" } }],
        application_runs: [{ data: { id: "run1" } }, { data: null }]
      }),
      rpc
    });
    const res = await POST(post({ url: GH }));
    expect(res.status).toBe(503);
    expect(rpc).toHaveBeenCalledWith("refund_arm_run", { p_run_id: "run1" });
  });

  it("503 with a deploy hint when the arm is unconfigured", async () => {
    mocks.buildAndDispatchRun.mockResolvedValueOnce({ ok: false, reason: "arm_unconfigured" });
    holder.server = fakeClient({ user: { id: "u1" } });
    holder.service = fakeClient({
      from: fakeFrom({
        jobs: [{ data: { id: "job1" } }],
        applications: [{ data: null }, { data: { id: "app1" } }, { data: null }],
        profiles: [{ data: { arm_autonomy: "review_gate" } }],
        resumes: [{ data: null }],
        subscriptions: [{ data: { plan: "free", status: "active" } }],
        application_runs: [{ data: { id: "run1" } }, { data: null }]
      }),
      rpc: fakeRpc({ try_reserve_arm_run: [true], refund_arm_run: [true] })
    });
    const res = await POST(post({ url: GH }));
    expect((await res.json()).hint).toContain("isn't deployed");
  });

  it("tailors the resume first on a paid plan (tailored=true)", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    holder.service = fakeClient({
      from: fakeFrom({
        jobs: [{ data: { id: "job1" } }],
        applications: [{ data: null }, { data: { id: "app1" } }, { data: null }, { data: null }],
        profiles: [{ data: { arm_autonomy: "review_gate" } }],
        resumes: [
          { data: { id: "r1", file_name: "base.pdf", storage_path: "u1/base.pdf", mime_type: "application/pdf" } },
          { data: { id: "r2", file_name: "Acme-resume.pdf", storage_path: "u1/t.pdf", mime_type: "application/pdf" } }
        ],
        subscriptions: [{ data: { plan: "premium", status: "active" } }],
        application_runs: [{ data: { id: "run1" } }]
      }),
      rpc: fakeRpc({ try_reserve_ai_call: [true], try_reserve_arm_run: [true] })
    });
    const res = await POST(post({ url: GH, tailor: true }));
    expect((await res.json()).tailored).toBe(true);
  });

  it("skips tailoring for a free plan even when requested", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    holder.service = service({
      applications: [{ data: null }, { data: { id: "app1" } }, { data: null }],
      resumes: [{ data: { id: "r1", file_name: "base.pdf", storage_path: "u1/base.pdf", mime_type: "application/pdf" } }],
      subscriptions: [{ data: { plan: "free", status: "active" } }],
      rpc: { try_reserve_arm_run: [true] }
    });
    const res = await POST(post({ url: GH, tailor: true }));
    expect((await res.json()).tailored).toBe(false);
    expect(mocks.tailorResume).not.toHaveBeenCalled();
  });

  it("skips tailoring when the tailor quota is spent", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    holder.service = service({
      applications: [{ data: null }, { data: { id: "app1" } }, { data: null }],
      resumes: [{ data: { id: "r1", file_name: "base.pdf", storage_path: "u1/base.pdf", mime_type: "application/pdf" } }],
      subscriptions: [{ data: { plan: "premium", status: "active" } }],
      rpc: { try_reserve_ai_call: [false], try_reserve_arm_run: [true] }
    });
    const res = await POST(post({ url: GH, tailor: true }));
    expect((await res.json()).tailored).toBe(false);
    expect(mocks.tailorResume).not.toHaveBeenCalled();
  });

  it("falls back to base resume when the tailored upload fails", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    holder.service = fakeClient({
      from: fakeFrom({
        jobs: [{ data: { id: "job1" } }],
        applications: [{ data: null }, { data: { id: "app1" } }, { data: null }],
        profiles: [{ data: { arm_autonomy: "review_gate" } }],
        resumes: [{ data: { id: "r1", file_name: "base.pdf", storage_path: "u1/base.pdf", mime_type: "application/pdf" } }],
        subscriptions: [{ data: { plan: "premium", status: "active" } }],
        application_runs: [{ data: { id: "run1" } }]
      }),
      rpc: fakeRpc({ try_reserve_ai_call: [true], try_reserve_arm_run: [true], release_ai_call: [null] }),
      bucket: fakeBucket({ upload: vi.fn(async () => ({ data: null, error: { message: "no" } })) })
    });
    const res = await POST(post({ url: GH, tailor: true }));
    expect((await res.json()).tailored).toBe(false);
  });

  it("falls back to base resume when the tailored row insert returns nothing", async () => {
    mocks.fetchJobMeta.mockResolvedValueOnce({ ...META, company: "" }); // -> "tailored" filename
    holder.server = fakeClient({ user: { id: "u1" } });
    holder.service = fakeClient({
      from: fakeFrom({
        jobs: [{ data: { id: "job1" } }],
        applications: [{ data: null }, { data: { id: "app1" } }, { data: null }],
        profiles: [{ data: { arm_autonomy: "review_gate" } }],
        resumes: [
          { data: { id: "r1", file_name: "base.pdf", storage_path: "u1/base.pdf", mime_type: "application/pdf" } },
          { data: null } // tailored insert returns nothing
        ],
        subscriptions: [{ data: { plan: "premium", status: "active" } }],
        application_runs: [{ data: { id: "run1" } }]
      }),
      rpc: fakeRpc({ try_reserve_ai_call: [true], try_reserve_arm_run: [true] })
    });
    const res = await POST(post({ url: GH, tailor: true }));
    expect((await res.json()).tailored).toBe(false);
  });

  it("does not tailor when there is no base resume", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    holder.service = service({
      applications: [{ data: null }, { data: { id: "app1" } }, { data: null }],
      resumes: [{ data: null }],
      subscriptions: [{ data: { plan: "premium", status: "active" } }],
      rpc: { try_reserve_arm_run: [true] }
    });
    const res = await POST(post({ url: GH, tailor: true }));
    expect((await res.json()).tailored).toBe(false);
  });

  it("releases the tailor slot and falls back to base resume when tailoring throws", async () => {
    mocks.tailorResume.mockRejectedValueOnce(new Error("model down"));
    holder.server = fakeClient({ user: { id: "u1" } });
    const rpc = fakeRpc({ try_reserve_ai_call: [true], try_reserve_arm_run: [true] });
    holder.service = fakeClient({
      from: fakeFrom({
        jobs: [{ data: { id: "job1" } }],
        applications: [{ data: null }, { data: { id: "app1" } }, { data: null }],
        profiles: [{ data: { arm_autonomy: "review_gate" } }],
        resumes: [{ data: { id: "r1", file_name: "base.pdf", storage_path: "u1/base.pdf", mime_type: "application/pdf" } }],
        subscriptions: [{ data: { plan: "premium", status: "active" } }],
        application_runs: [{ data: { id: "run1" } }]
      }),
      rpc
    });
    const res = await POST(post({ url: GH, tailor: true }));
    expect((await res.json()).tailored).toBe(false);
    expect(rpc).toHaveBeenCalledWith("release_ai_call", expect.objectContaining({ p_kind: "tailor_resume" }));
  });
});

describe("POST /api/applications (account-gated ATS)", () => {
  const WD =
    "https://acme.wd1.myworkdayjobs.com/en-US/Careers/job/Remote/Engineer_JR1";

  function workdayService(over: Parameters<typeof service>[0] = {}) {
    return service({
      applications: [{ data: null }, { data: { id: "app1" } }, { data: null }],
      rpc: { try_reserve_arm_run: [true] },
      ...over
    });
  }

  beforeEach(() => {
    mocks.fetchJobMeta.mockResolvedValue({ ...META, ats: "workday" });
    holder.server = fakeClient({ user: { id: "u1" } });
  });

  it("provisions the alias + tenant account and passes credentials to the arm", async () => {
    holder.service = workdayService();

    const res = await POST(post({ url: WD }));

    expect(res.status).toBe(200);
    expect(mocks.ensureApplicantAlias).toHaveBeenCalled();
    expect(mocks.ensureSiteAccount).toHaveBeenCalledWith(expect.anything(), {
      userId: "u1",
      tenantHost: "acme.wd1.myworkdayjobs.com",
      ats: "workday",
      email: "a-abcdefghjk@jobarms.com"
    });
    const dispatched = mocks.buildAndDispatchRun.mock.calls[0][1];
    expect(dispatched.account).toEqual({
      email: "a-abcdefghjk@jobarms.com",
      password: ["fixture", "value"].join("-")
    });
    // The run records its tenant so the inbound webhook can find it later.
    expect(dispatched.ats).toBe("workday");
  });

  it("records the tenant host on the run row", async () => {
    const client = workdayService();
    holder.service = client;

    await POST(post({ url: WD }));

    const runInsert = client.from.mock.results
      .map((r) => r.value)
      .filter((q) => q.insert.mock.calls.length)
      .map((q) => q.insert.mock.calls[0][0])
      .find((a) => "month_key" in a);
    expect(runInsert.tenant_host).toBe("acme.wd1.myworkdayjobs.com");
  });

  it("refunds the reserved slot and 503s when no managed email can be issued", async () => {
    mocks.ensureApplicantAlias.mockResolvedValueOnce(null);
    // Built by hand rather than via service() so the rpc stub can be asserted on.
    const rpc = fakeRpc({ try_reserve_arm_run: [true] });
    holder.service = fakeClient({
      from: fakeFrom({
        jobs: [{ data: { id: "job1" } }],
        applications: [{ data: null }, { data: { id: "app1" } }, { data: null }],
        profiles: [{ data: { arm_autonomy: "review_gate" } }],
        resumes: [{ data: null }],
        subscriptions: [{ data: { plan: "free", status: "active" } }],
        application_runs: [{ data: { id: "run1" } }]
      }),
      rpc
    });

    const res = await POST(post({ url: WD }));

    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("applicant_email_unavailable");
    expect(rpc).toHaveBeenCalledWith("release_arm_run", expect.anything());
    expect(mocks.buildAndDispatchRun).not.toHaveBeenCalled();
  });

  it("422s without dispatching when the tenant account is locked", async () => {
    mocks.ensureSiteAccount.mockResolvedValueOnce(null);
    const rpc = fakeRpc({ try_reserve_arm_run: [true] });
    holder.service = fakeClient({
      from: fakeFrom({
        jobs: [{ data: { id: "job1" } }],
        applications: [{ data: null }, { data: { id: "app1" } }, { data: null }],
        profiles: [{ data: { arm_autonomy: "review_gate" } }],
        resumes: [{ data: null }],
        subscriptions: [{ data: { plan: "free", status: "active" } }],
        application_runs: [{ data: { id: "run1" } }]
      }),
      rpc
    });

    const res = await POST(post({ url: WD }));

    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("ats_account_locked");
    expect(rpc).toHaveBeenCalledWith("release_arm_run", expect.anything());
    expect(mocks.buildAndDispatchRun).not.toHaveBeenCalled();
  });

  it("does NOT provision an account for an ATS that needs none", async () => {
    mocks.fetchJobMeta.mockResolvedValue(META);
    holder.service = workdayService();

    await POST(post({ url: GH }));

    expect(mocks.ensureApplicantAlias).not.toHaveBeenCalled();
    expect(mocks.ensureSiteAccount).not.toHaveBeenCalled();
    expect(mocks.buildAndDispatchRun.mock.calls[0][1].account).toBeNull();
  });
});
