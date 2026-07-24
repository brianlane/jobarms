import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBucket, fakeClient, fakeFrom, fakeRpc, type Result } from "../helpers/supabase";

const holder = vi.hoisted(() => ({ server: null as unknown, service: null as unknown }));
const { parseResume, NotAResumeError } = vi.hoisted(() => {
  class NotAResumeError extends Error {}
  return { parseResume: vi.fn(), NotAResumeError };
});
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn(async () => holder.server) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceClient: vi.fn(() => holder.service) }));
vi.mock("@/lib/resume-parse", () => ({ parseResume, NotAResumeError }));

import { POST } from "@/app/api/resumes/route";

const PARSED = {
  full_name: "Jane", phone: "555", location: "Phoenix", headline: "Eng", summary: "s",
  links: {}, work_history: [], education: [], skills: ["ts"]
};

function pdfRequest(size = 1000, type = "application/pdf") {
  const file = new File([new Uint8Array(size)], "resume.pdf", { type });
  const form = new FormData();
  form.append("file", file);
  return new Request("http://x", { method: "POST", body: form });
}

function service(over: {
  resumes?: Result[];
  profiles?: Result[];
  subscriptions?: Result[];
  rpc?: ReturnType<typeof fakeRpc> | Record<string, unknown[]>;
  bucket?: ReturnType<typeof fakeBucket>;
}) {
  return fakeClient({
    from: fakeFrom({
      subscriptions: over.subscriptions ?? [{ data: { plan: "free", status: "active" } }],
      resumes: over.resumes ?? [{ data: { id: "r1" } }, { error: null }],
      profiles: over.profiles ?? [{ data: {} }, { error: null }]
    }),
    rpc: typeof over.rpc === "function" ? over.rpc : fakeRpc(over.rpc ?? { try_reserve_ai_call: [true] }),
    bucket: over.bucket
  });
}

beforeEach(() => {
  holder.server = null;
  holder.service = null;
  parseResume.mockReset();
  parseResume.mockResolvedValue(PARSED);
});

describe("POST /api/resumes", () => {
  it("401 without a user", async () => {
    holder.server = fakeClient({ user: null });
    expect((await POST(pdfRequest())).status).toBe(401);
  });

  it("400 when no file is attached", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    const res = await POST(new Request("http://x", { method: "POST", body: new FormData() }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("missing_file");
  });

  it("400 for an unsupported file type", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    expect((await POST(pdfRequest(100, "image/png"))).status).toBe(400);
  });

  it("400 when the file is too large", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    expect((await POST(pdfRequest(9 * 1024 * 1024))).status).toBe(400);
  });

  it("402 with the free-tier hint when parses are spent", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    holder.service = service({ rpc: { try_reserve_ai_call: [false] } });
    const res = await POST(pdfRequest());
    expect(res.status).toBe(402);
    expect((await res.json()).hint).toContain("2 free resume parses");
  });

  it("402 with the fair-use hint for a paid plan", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    holder.service = service({
      subscriptions: [{ data: { plan: "premium", status: "active" } }],
      rpc: { try_reserve_ai_call: [false] }
    });
    const res = await POST(pdfRequest());
    expect((await res.json()).hint).toContain("fair-use");
  });

  it("500 when the upload fails", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    holder.service = service({
      bucket: fakeBucket({ upload: vi.fn(async () => ({ data: null, error: { message: "no" } })) })
    });
    expect((await POST(pdfRequest())).status).toBe(500);
  });

  it("500 when the resume row insert fails", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    holder.service = service({ resumes: [{ data: null, error: { message: "x" } }] });
    expect((await POST(pdfRequest())).status).toBe(500);
  });

  it("parses and merges, keeping non-empty existing fields over parsed values", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    // Existing profile mixes: non-empty string (kept), empty string (filled),
    // non-empty array (kept), non-empty object (kept), empty object (filled).
    holder.service = service({
      resumes: [{ data: { id: "r1" } }, { error: null }],
      profiles: [
        {
          data: {
            full_name: "Existing Name",
            headline: "",
            skills: ["kept-skill"],
            education: [],
            links: { github: "https://gh/x" },
            work_history: {}
          }
        },
        { error: null }
      ]
    });
    const res = await POST(pdfRequest());
    expect(res.status).toBe(200);
    expect((await res.json()).resume_id).toBe("r1");
  });

  it("merges onto an empty profile (fills every field)", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    holder.service = service({ resumes: [{ data: { id: "r1" } }, { error: null }], profiles: [{ data: null }, { error: null }] });
    expect((await POST(pdfRequest())).status).toBe(200);
  });

  it("422 (slot kept) when the model says it is not a resume", async () => {
    parseResume.mockRejectedValueOnce(new NotAResumeError("not_a_resume"));
    holder.server = fakeClient({ user: { id: "u1" } });
    const rpc = fakeRpc({ try_reserve_ai_call: [true] });
    holder.service = service({ rpc });
    const res = await POST(pdfRequest());
    expect(res.status).toBe(422);
    expect(rpc).not.toHaveBeenCalledWith("release_ai_call", expect.anything());
  });

  it("503 (slot released) on a transient parse failure", async () => {
    parseResume.mockRejectedValueOnce(new Error("gemini 503"));
    holder.server = fakeClient({ user: { id: "u1" } });
    const rpc = fakeRpc({ try_reserve_ai_call: [true], release_ai_call: [null] });
    holder.service = service({ rpc });
    const res = await POST(pdfRequest());
    expect(res.status).toBe(503);
    expect(rpc).toHaveBeenCalledWith("release_ai_call", expect.objectContaining({ p_kind: "resume_parse" }));
  });

  it("stringifies a non-Error rejection into the recorded parse error", async () => {
    parseResume.mockRejectedValueOnce("weird failure");
    holder.server = fakeClient({ user: { id: "u1" } });
    holder.service = service({ rpc: { try_reserve_ai_call: [true], release_ai_call: [null] } });
    expect((await POST(pdfRequest())).status).toBe(503);
  });
});
