import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diagnosePage, generateAnswers, parseTileResponse, solveImageGrid } from "../src/gemini";
import type { Env, FormField, RunParams } from "../src/types";

const env = { GEMINI_API_KEY: "k" } as Env;
const envModel = { GEMINI_API_KEY: "k", GEMINI_TEXT_MODEL: "gemini-x" } as Env;

function geminiText(text: string) {
  return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }), text: async () => "" };
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("parseTileResponse", () => {
  it("accepts a {tiles:[...]} object, dedups, drops out-of-range/non-numeric, sorts", () => {
    expect(parseTileResponse({ tiles: [3, 0, 0, "1", 9, -1, "x"] }, 4)).toEqual([0, 1, 3]);
  });
  it("accepts a bare array and defaults to empty otherwise", () => {
    expect(parseTileResponse([2, 1], 4)).toEqual([1, 2]);
    expect(parseTileResponse("nope", 4)).toEqual([]);
  });
});

describe("generateAnswers", () => {
  const params = {
    profile: { full_name: "Jane" },
    jobTitle: "Eng",
    jobCompany: "Acme",
    jobDescription: "d",
    memory: { answers: [{ label: "Phone", answer: "555", source: "approved" }], lessons: ["prefer X"] }
  } as unknown as RunParams;
  const fields: FormField[] = [{ name: "email", label: "Email", type: "email", required: true, options: [] }];

  it("maps model output onto known fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        geminiText(JSON.stringify([
          { name: "email", label: "Email", value: "a@b.com", skipped: false },
          { name: "ghost", label: "X", value: "y" }, // unknown field -> dropped
          null, // non-object -> dropped
          { name: "email", value: 42 } // label fallback + value String()
        ]))
      )
    );
    const answers = await generateAnswers(env, params, fields);
    expect(answers[0]).toEqual({ name: "email", label: "Email", value: "a@b.com", skipped: false });
    expect(answers[1]).toEqual({ name: "email", label: "Email", value: "42", skipped: false });
  });

  it("strips markdown fences and works without memory/lessons", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(geminiText('```json\n[]\n```')));
    const answers = await generateAnswers(envModel, { profile: {}, jobTitle: "", jobCompany: "", jobDescription: "" } as unknown as RunParams, []);
    expect(answers).toEqual([]);
  });

  it("throws when the model does not return an array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(geminiText('{"not":"array"}')));
    await expect(generateAnswers(env, params, fields)).rejects.toThrow(/not an array/);
  });

  it("throws on a non-2xx gemini response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}), text: async () => "overloaded" }));
    await expect(generateAnswers(env, params, fields)).rejects.toThrow(/gemini 503/);
  });

  it("defaults the api key + label/value when they are absent", async () => {
    const noKey = {} as Env; // GEMINI_API_KEY undefined -> `?? ""`
    const labellessField: FormField = { name: "x", label: undefined as unknown as string, type: "text", required: false, options: [] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(geminiText(JSON.stringify([{ name: "x" }])))); // no label/value
    const answers = await generateAnswers(noKey, { profile: {}, jobTitle: "", jobCompany: "", jobDescription: "" } as unknown as RunParams, [labellessField]);
    expect(answers[0]).toEqual({ name: "x", label: "", value: "", skipped: false });
  });

  it("rejects when the model returns no text at all", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{}] } }] }), text: async () => "" }));
    await expect(generateAnswers(env, params, fields)).rejects.toThrow();
  });
});

describe("diagnosePage default action", () => {
  it("coerces a missing action to none", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(geminiText(JSON.stringify({ form_visible: true }))));
    const d = await diagnosePage(env, new Uint8Array(), "https://x", "p");
    expect(d.action).toBe("none");
  });
});

describe("diagnosePage", () => {
  it("normalizes a valid diagnosis", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(geminiText(JSON.stringify({ form_visible: true, action: "click", click_text: "Apply", reason: "button" }))));
    const d = await diagnosePage(env, new Uint8Array([1, 2, 3]), "https://x", "no fields");
    expect(d).toEqual({ form_visible: true, action: "click", click_text: "Apply", reason: "button" });
  });

  it("coerces an unknown action to none and defaults click_text/reason", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(geminiText(JSON.stringify({ action: "explode", click_text: 5, reason: 9 }))));
    const d = await diagnosePage(env, new Uint8Array(), "https://x", "p");
    expect(d).toEqual({ form_visible: false, action: "none", click_text: undefined, reason: "" });
  });
});

describe("solveImageGrid", () => {
  it("returns validated tile indices", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(geminiText(JSON.stringify({ tiles: [0, 8, 3] }))));
    expect(await solveImageGrid(env, new Uint8Array([1]), "crosswalks", 3, 3)).toEqual([0, 3, 8]);
  });
});
