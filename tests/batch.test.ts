import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const { dispatchBatch } = vi.hoisted(() => ({ dispatchBatch: vi.fn() }));
vi.mock("@/lib/arm", () => ({ dispatchBatch }));

import { buildAndDispatchBatch, createBatch } from "@/lib/batch";

/** Chainable, awaitable PostgREST-style query stub resolving to { data }. */
function query(data: unknown) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit", "insert", "single"]) chain[m] = () => chain;
  const p = Promise.resolve({ data });
  chain.then = p.then.bind(p);
  return chain;
}

function fakeService(memoryRows: unknown, statRows: unknown, signedUrl: string | null) {
  return {
    from: (table: string) => query(table === "user_answer_memory" ? memoryRows : statRows),
    storage: {
      from: () => ({
        createSignedUrl: vi.fn(async () => ({ data: signedUrl ? { signedUrl } : null }))
      })
    }
  } as unknown as SupabaseClient;
}

const baseArgs = {
  batchId: "b1",
  userId: "u1",
  keywords: "react engineer",
  location: "Denver",
  remote: true,
  reserved: 5,
  monthKey: "2026-07",
  profile: { full_name: "Jane" },
  account: { email: "me@example.com", password: ["fixture", "v"].join("-") }
};

beforeEach(() => {
  dispatchBatch.mockReset();
  dispatchBatch.mockResolvedValue({ ok: true });
});

describe("createBatch", () => {
  it("inserts the batch row and returns its id", async () => {
    const insert = vi.fn(() => ({
      select: () => ({ single: async () => ({ data: { id: "b1" } }) })
    }));
    const service = { from: vi.fn(() => ({ insert })) } as unknown as SupabaseClient;

    const id = await createBatch(service, "u1", {
      keywords: "react",
      location: "",
      remote: false,
      requested: 10,
      reserved: 7,
      monthKey: "2026-07"
    });

    expect(id).toBe("b1");
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: "u1", requested: 10, reserved: 7, month_key: "2026-07" })
    );
  });

  it("returns null when the insert yields nothing", async () => {
    const service = {
      from: () => ({
        insert: () => ({ select: () => ({ single: async () => ({ data: null }) }) })
      })
    } as unknown as SupabaseClient;
    expect(
      await createBatch(service, "u1", {
        keywords: "x",
        location: "",
        remote: false,
        requested: 1,
        reserved: 1,
        monthKey: "2026-07"
      })
    ).toBeNull();
  });
});

describe("buildAndDispatchBatch", () => {
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

    const result = await buildAndDispatchBatch(service, {
      ...baseArgs,
      resume: { file_name: "cv.pdf", storage_path: "u1/cv.pdf", mime_type: "application/pdf" }
    });

    expect(result).toEqual({ ok: true });
    const payload = dispatchBatch.mock.calls[0][0];
    expect(payload).toMatchObject({
      batchId: "b1",
      keywords: "react engineer",
      reserved: 5,
      monthKey: "2026-07",
      account: baseArgs.account
    });
    expect(payload.resume.signedUrl).toBe("https://signed.example/resume.pdf");
    expect(payload.resume.fileName).toBe("cv.pdf");
    expect(payload.memory.answers).toEqual([{ label: "Phone", answer: "555", source: "approved" }]);
    expect(payload.memory.lessons.length).toBeGreaterThan(0);
  });

  it("handles no resume and empty learning rows (null coalescing)", async () => {
    const service = fakeService(null, null, null);
    const result = await buildAndDispatchBatch(service, { ...baseArgs, resume: null });
    expect(result).toEqual({ ok: true });
    const payload = dispatchBatch.mock.calls[0][0];
    expect(payload.resume.signedUrl).toBeNull();
    expect(payload.resume.fileName).toBe("resume.pdf");
    expect(payload.memory.answers).toEqual([]);
    expect(payload.memory.lessons).toEqual([]);
  });

  it("sends a null signed URL when signing a present resume yields no URL", async () => {
    const service = fakeService(null, null, null); // createSignedUrl -> { data: null }
    await buildAndDispatchBatch(service, {
      ...baseArgs,
      resume: { file_name: "cv.pdf", storage_path: "u1/cv.pdf", mime_type: "application/pdf" }
    });
    expect(dispatchBatch.mock.calls[0][0].resume.signedUrl).toBeNull();
  });
});
