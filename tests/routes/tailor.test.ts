import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBucket, fakeClient, fakeFrom, fakeRpc, type Result } from "../helpers/supabase";

const holder = vi.hoisted(() => ({ server: null as unknown, service: null as unknown }));
const mocks = vi.hoisted(() => ({
  tailorResume: vi.fn(),
  generateCoverLetter: vi.fn(),
  renderResumePdf: vi.fn()
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn(async () => holder.server) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceClient: vi.fn(() => holder.service) }));
vi.mock("@/lib/tailor", () => ({ tailorResume: mocks.tailorResume, generateCoverLetter: mocks.generateCoverLetter }));
vi.mock("@/lib/resume-pdf", () => ({ renderResumePdf: mocks.renderResumePdf }));

import { POST } from "@/app/api/applications/[id]/tailor/route";

const ctx = { params: Promise.resolve({ id: "app-1" }) };
const post = (body?: unknown) =>
  new Request("http://x", { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const RESUME = {
  full_name: "Jane", email: "", phone: "", location: "", headline: "", summary: "",
  links: {}, work_history: [], education: [], skills: []
};

function service(over: {
  profiles?: Result[];
  applications?: Result[];
  resumes?: Result[];
  subscriptions?: Result[];
  rpc?: ReturnType<typeof fakeRpc> | Record<string, unknown[]>;
  bucket?: ReturnType<typeof fakeBucket>;
}) {
  return fakeClient({
    from: fakeFrom({
      subscriptions: over.subscriptions ?? [{ data: { plan: "premium", status: "active" } }],
      profiles: over.profiles ?? [{ data: { full_name: "Jane" } }],
      applications: over.applications ?? [{ error: null }],
      resumes: over.resumes ?? [{ data: { id: "r1" } }]
    }),
    rpc: typeof over.rpc === "function" ? over.rpc : fakeRpc(over.rpc ?? { try_reserve_ai_call: [true] }),
    bucket: over.bucket
  });
}

beforeEach(() => {
  holder.server = null;
  holder.service = null;
  vi.clearAllMocks();
  mocks.tailorResume.mockResolvedValue({ resume: RESUME, keywords: { incorporated: ["a"], missing: [] } });
  mocks.generateCoverLetter.mockResolvedValue("Hi Acme team, ...");
  mocks.renderResumePdf.mockResolvedValue(new Uint8Array([1]));
});

const appServer = () =>
  fakeClient({ user: { id: "u1" }, from: fakeFrom({ applications: [{ data: { id: "app-1", jobs: { title: "Eng", company: "Acme", description: "d" } } }] }) });

describe("POST /api/applications/[id]/tailor", () => {
  it("401 without a user", async () => {
    holder.server = fakeClient({ user: null });
    expect((await POST(post({ kind: "resume" }), ctx)).status).toBe(401);
  });

  it("400 on an invalid body", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    expect((await POST(post({ kind: "bogus" }), ctx)).status).toBe(400);
  });

  it("400 when the JSON body is malformed", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    const bad = new Request("http://x", { method: "POST", body: "{" });
    expect((await POST(bad, ctx)).status).toBe(400);
  });

  it("404 when the application is missing", async () => {
    holder.server = fakeClient({ user: { id: "u1" }, from: fakeFrom({ applications: [{ data: null }] }) });
    holder.service = service({});
    expect((await POST(post({ kind: "resume" }), ctx)).status).toBe(404);
  });

  it("tolerates a missing job join (uses empty strings) and null signed URL", async () => {
    holder.server = fakeClient({
      user: { id: "u1" },
      from: fakeFrom({ applications: [{ data: { id: "app-1", jobs: null } }] })
    });
    holder.service = service({
      resumes: [{ data: { id: "r3" } }],
      bucket: fakeBucket({ createSignedUrl: vi.fn(async () => ({ data: null, error: null })) })
    });
    const res = await POST(post({ kind: "resume" }), ctx);
    expect((await res.json()).download_url).toBeNull();
  });

  it("402 for a free plan (premium feature)", async () => {
    holder.server = appServer();
    holder.service = service({ subscriptions: [{ data: { plan: "free", status: "active" } }] });
    const res = await POST(post({ kind: "resume" }), ctx);
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("premium_required");
  });

  it("402 when the AI quota is spent", async () => {
    holder.server = appServer();
    holder.service = service({ rpc: { try_reserve_ai_call: [false] } });
    const res = await POST(post({ kind: "resume" }), ctx);
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("ai_limit_reached");
  });

  it("400 when the profile is missing", async () => {
    holder.server = appServer();
    holder.service = service({ profiles: [{ data: null }] });
    expect((await POST(post({ kind: "resume" }), ctx)).status).toBe(400);
  });

  it("generates a cover letter", async () => {
    holder.server = appServer();
    holder.service = service({});
    const res = await POST(post({ kind: "cover_letter" }), ctx);
    expect((await res.json()).cover_letter).toContain("Hi Acme team");
  });

  it("generates a cover letter even when the job join is missing", async () => {
    holder.server = fakeClient({
      user: { id: "u1" },
      from: fakeFrom({ applications: [{ data: { id: "app-1", jobs: null } }] })
    });
    holder.service = service({});
    const res = await POST(post({ kind: "cover_letter" }), ctx);
    expect(res.status).toBe(200);
  });

  it("tailors a resume and returns a signed download URL", async () => {
    holder.server = appServer();
    holder.service = service({ resumes: [{ data: { id: "r2" } }] });
    const res = await POST(post({ kind: "resume" }), ctx);
    const body = await res.json();
    expect(body.resume_id).toBe("r2");
    expect(body.download_url).toBe("https://signed.example/x");
  });

  it("500 when the tailored PDF upload fails", async () => {
    holder.server = appServer();
    holder.service = service({
      bucket: fakeBucket({ upload: vi.fn(async () => ({ data: null, error: { message: "no" } })) })
    });
    expect((await POST(post({ kind: "resume" }), ctx)).status).toBe(500);
  });

  it("500 when the resume row insert fails", async () => {
    holder.server = appServer();
    holder.service = service({ resumes: [{ data: null, error: { message: "x" } }] });
    expect((await POST(post({ kind: "resume" }), ctx)).status).toBe(500);
  });

  it("503 + release when generation throws", async () => {
    mocks.tailorResume.mockRejectedValueOnce(new Error("model down"));
    holder.server = appServer();
    const rpc = fakeRpc({ try_reserve_ai_call: [true], release_ai_call: [null] });
    holder.service = service({ rpc });
    const res = await POST(post({ kind: "resume" }), ctx);
    expect(res.status).toBe(503);
    expect(rpc).toHaveBeenCalledWith("release_ai_call", expect.objectContaining({ p_kind: "tailor_resume" }));
  });
});
