import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const { dispatchRun } = vi.hoisted(() => ({ dispatchRun: vi.fn() }));
vi.mock("@/lib/arm", () => ({ dispatchRun }));

import { buildAndDispatchRun, type DispatchArgs } from "@/lib/arm-dispatch";

/** Chainable, awaitable PostgREST-style query stub resolving to { data }. */
function query(data: unknown) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit"]) chain[m] = () => chain;
  const p = Promise.resolve({ data });
  chain.then = p.then.bind(p);
  return chain;
}

function fakeService(memoryRows: unknown, statRows: unknown, signedUrl: string | null) {
  return {
    from: (table: string) =>
      query(table === "user_answer_memory" ? memoryRows : statRows),
    storage: {
      from: () => ({
        createSignedUrl: vi.fn(async () => ({ data: signedUrl ? { signedUrl } : null }))
      })
    }
  } as unknown as SupabaseClient;
}

const baseArgs: Omit<DispatchArgs, "resume"> = {
  runId: "r1",
  applicationId: "a1",
  userId: "u1",
  jobUrl: "https://jobs.lever.co/acme/1",
  ats: "lever",
  autonomy: "review_gate",
  jobTitle: "Engineer",
  jobCompany: "Acme",
  jobDescription: "desc",
  profile: { full_name: "Jane" }
};

beforeEach(() => {
  dispatchRun.mockReset();
  dispatchRun.mockResolvedValue({ ok: true });
});

describe("buildAndDispatchRun", () => {
  it("builds memory + lessons + a signed resume URL and dispatches", async () => {
    const service = fakeService(
      [{ label: "Phone", answer: "555", source: "approved" }],
      [
        {
          question_key: "src",
          label_example: "Source",
          times_seen: 5,
          times_skipped: 0,
          option_counts: { "Job board": 4, LinkedIn: 1 }
        },
        // row with no option_counts -> exercises the `?? {}` default
        { question_key: "x", label_example: "X", times_seen: 1, times_skipped: 0 }
      ],
      "https://signed.example/resume.pdf"
    );

    const result = await buildAndDispatchRun(service, {
      ...baseArgs,
      resume: { file_name: "cv.pdf", storage_path: "u1/cv.pdf", mime_type: "application/pdf" }
    });

    expect(result).toEqual({ ok: true });
    const payload = dispatchRun.mock.calls[0][0];
    expect(payload.resume.signedUrl).toBe("https://signed.example/resume.pdf");
    expect(payload.resume.fileName).toBe("cv.pdf");
    expect(payload.memory.answers).toEqual([{ label: "Phone", answer: "555", source: "approved" }]);
    expect(payload.memory.lessons.length).toBeGreaterThan(0);
  });

  it("handles no resume and empty learning rows (null coalescing)", async () => {
    const service = fakeService(null, null, null);
    const result = await buildAndDispatchRun(service, { ...baseArgs, resume: null });
    expect(result).toEqual({ ok: true });
    const payload = dispatchRun.mock.calls[0][0];
    expect(payload.resume.signedUrl).toBeNull();
    expect(payload.resume.fileName).toBe("resume.pdf");
    expect(payload.memory.answers).toEqual([]);
    expect(payload.memory.lessons).toEqual([]);
  });

  it("sends a null signed URL when signing a present resume yields no URL", async () => {
    const service = fakeService(null, null, null); // createSignedUrl -> { data: null }
    await buildAndDispatchRun(service, {
      ...baseArgs,
      resume: { file_name: "cv.pdf", storage_path: "u1/cv.pdf", mime_type: "application/pdf" }
    });
    expect(dispatchRun.mock.calls[0][0].resume.signedUrl).toBeNull();
  });
});
