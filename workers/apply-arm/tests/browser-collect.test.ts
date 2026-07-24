import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakePage } from "./helpers/fake-page";
import type { Env, RunParams } from "../src/types";

const launch = vi.hoisted(() => vi.fn());
vi.mock("@cloudflare/playwright", () => ({ launch }));
const adapter = vi.hoisted(() => ({
  formSelector: "form",
  openApplication: vi.fn(async () => {}),
  submit: vi.fn(async () => {}),
  confirmSubmitted: vi.fn(async () => true)
}));
vi.mock("../src/adapters", () => ({ ADAPTERS: { lever: adapter, greenhouse: adapter } }));
vi.mock("../src/db", () => ({ getPlaybook: vi.fn(async () => null), recordPlaybookFailure: vi.fn(async () => {}) }));
vi.mock("../src/gemini", () => ({ diagnosePage: vi.fn() }));
vi.mock("../src/captcha-vision", () => ({ detectInteractiveChallenge: vi.fn(async () => null), solveInteractiveChallenge: vi.fn(async () => false) }));

import { extractForm } from "../src/browser";

const env = { BROWSER: {} } as Env;
const params = (): RunParams => ({
  runId: "r1", applicationId: "a1", userId: "u1", jobUrl: "https://jobs.lever.co/acme/1",
  ats: "lever", autonomy: "review_gate", jobTitle: "E", jobCompany: "A", jobDescription: "d",
  profile: {}, resume: { signedUrl: null, fileName: "r.pdf", mimeType: "application/pdf" }
}) as RunParams;

/** Minimal fake DOM element. */
interface El {
  tagName: string;
  attrs: Record<string, string>;
  closestMap?: Record<string, { textContent?: string; querySelector?: (s: string) => unknown } | null>;
  options?: Array<{ textContent: string }>;
}
function fakeEl(tag: string, attrs: Record<string, string>, extra: Partial<El> = {}): unknown {
  return {
    tagName: tag.toUpperCase(),
    getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
    hasAttribute: (k: string) => k in attrs,
    closest: (sel: string) => extra.closestMap?.[sel] ?? null,
    querySelectorAll: (sel: string) => (sel === "option" ? extra.options ?? [] : [])
  };
}

/**
 * Run collectFields' in-page callback against a crafted DOM. We set up the
 * globals it reads (document + CSS.escape), then have $$eval invoke it.
 */
function domPage(elements: unknown[], doc: Record<string, unknown>) {
  return fakePage({
    eval$$: (_selector, fn) => {
      const g = globalThis as unknown as { document?: unknown; CSS?: unknown };
      const prevDoc = g.document;
      const prevCss = g.CSS;
      g.document = doc;
      g.CSS = { escape: (s: string) => s };
      try {
        return fn(elements);
      } finally {
        g.document = prevDoc;
        g.CSS = prevCss;
      }
    }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  adapter.confirmSubmitted.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllGlobals());

describe("collectFields (in-page extraction)", () => {
  it("extracts a rich mixed form covering every label + field-type branch", async () => {
    // Label sources: label[for], aria-labelledby, closest(label), aria-label,
    // placeholder, name fallback.
    const emailEl = fakeEl("input", { type: "email", name: "email", id: "email-id", required: "" });
    const nameByLabelledby = fakeEl("input", { type: "text", name: "full_name", "aria-labelledby": "lbl1 lbl2" });
    const wrapped = fakeEl("input", { type: "text", name: "wrapped" }, {
      closestMap: { label: { textContent: "Wrapped Label" }, fieldset: null }
    });
    const ariaLabel = fakeEl("input", { type: "text", name: "aria", "aria-label": "Aria Field" });
    const placeholderEl = fakeEl("input", { type: "text", name: "ph", placeholder: "Type here" });
    const nameOnly = fakeEl("input", { type: "text", name: "bare" });
    const hidden = fakeEl("input", { type: "hidden", name: "csrf" }); // skipped
    const noName = fakeEl("input", { type: "text" }); // skipped (no name)
    const combobox = fakeEl("input", { name: "country", class: "select__input", role: "combobox" });
    const selectEl = fakeEl("select", { name: "years" }, {
      options: [{ textContent: "Select one" }, { textContent: "1" }, { textContent: "2" }]
    });
    const radioA = fakeEl("input", { type: "radio", name: "consent_radio", id: "r1", required: "" });
    const checkbox1 = fakeEl("input", { type: "checkbox", name: "lone", id: "c-lone" });
    const checkGroupA = fakeEl("input", { type: "checkbox", name: "skills", id: "ck1", description: "Your skills" });
    // Radio group whose prompt comes from aria-describedby (no description/legend).
    const describedRadio = fakeEl("input", { type: "radio", name: "src_radio", id: "sr1", "aria-describedby": "d1 d2" });

    const doc = {
      getElementById: (id: string) =>
        id === "lbl1" ? { textContent: "First" } : id === "lbl2" ? { textContent: "Name" }
          : id === "d1" ? { textContent: "How" } : id === "d2" ? { textContent: "heard" } : null,
      querySelector: (sel: string) => {
        if (sel.includes('label[for="email-id"]')) return { textContent: "Email" };
        if (sel.includes('label[for="r1"]')) return { textContent: "Yes" };
        if (sel.includes('label[for="c-lone"]')) return { textContent: "I agree" };
        if (sel.includes('label[for="ck1"]')) return { textContent: "TypeScript" };
        return null;
      },
      querySelectorAll: (sel: string) => {
        if (sel.includes('type="radio"') && sel.includes("consent_radio")) return [radioA];
        if (sel.includes('type="checkbox"') && sel.includes('"lone"')) return [checkbox1];
        if (sel.includes('type="checkbox"') && sel.includes('"skills"')) return [checkGroupA, fakeEl("input", { type: "checkbox", name: "skills", id: "ck2" })];
        if (sel.includes('type="radio"') && sel.includes("src_radio")) return [describedRadio, fakeEl("input", { type: "radio", name: "src_radio", id: "sr2" })];
        return [];
      }
    };

    const elements = [emailEl, nameByLabelledby, wrapped, ariaLabel, placeholderEl, nameOnly, hidden, noName, combobox, selectEl, radioA, checkbox1, checkGroupA, describedRadio];
    usePageDom(elements, doc);
    const result = await extractForm(env, params());
    const byName = Object.fromEntries(result.fields.map((f) => [f.name, f]));
    // email + name pass sanity; combobox surfaced as select; select options filtered
    expect(byName["email"].label).toBe("Email");
    expect(byName["country"].type).toBe("select");
    expect(byName["years"].options).toEqual(["1", "2"]);
  });

  it("covers label fallbacks, duplicate names, and option-label sources", async () => {
    // label[for] exists but has no text; aria-labelledby resolves to blanks
    // and a missing id (the `?? ""` default).
    const blankLabel = fakeEl("input", { type: "email", name: "email", id: "e1", "aria-labelledby": "b1 missing" });
    const named = fakeEl("input", { type: "text", name: "first_name" });
    // Checkbox group whose prompt comes from a fieldset legend WITH text.
    const legendBox = fakeEl("input", { type: "checkbox", name: "legend_grp", id: "lg1" }, {
      closestMap: { fieldset: { querySelector: () => ({ textContent: "Pick your perks" }) } }
    });
    // Radio group with an aria-describedby that resolves to nothing.
    const emptyDesc = fakeEl("input", { type: "radio", name: "empty_desc", "aria-describedby": "missing" });
    const idOnly = fakeEl("input", { type: "text", id: "only-id" }); // name falls back to id
    const dupA = fakeEl("input", { type: "text", name: "twice" });
    const dupB = fakeEl("input", { type: "text", name: "twice" }); // seen -> skipped
    // Radio group processed once; options labeled via aria-label and value.
    const radioX = fakeEl("input", { type: "radio", name: "pick", "aria-label": "Option A" }, {
      closestMap: { fieldset: { querySelector: () => ({ textContent: null }) } }
    });
    const radioY = fakeEl("input", { type: "radio", name: "pick", value: "b-value" });
    const selectNoise = fakeEl("select", { name: "noise" }, {
      options: [{ textContent: "Select an option" }, { textContent: "" }, { textContent: null as unknown as string }]
    });

    const doc = {
      getElementById: (id: string) => (id === "b1" ? { textContent: "   " } : null),
      querySelector: (sel: string) => (sel.includes('label[for="e1"]') ? { textContent: null } : null),
      querySelectorAll: (sel: string) => {
        if (sel.includes('type="radio"') && sel.includes("pick")) return [radioX, radioY];
        if (sel.includes('type="radio"') && sel.includes("empty_desc")) return [emptyDesc, fakeEl("input", { type: "radio", name: "empty_desc" })];
        if (sel.includes('type="checkbox"') && sel.includes("legend_grp")) return [legendBox, fakeEl("input", { type: "checkbox", name: "legend_grp" })];
        return [];
      }
    };
    usePageDom([blankLabel, named, idOnly, dupA, dupB, radioX, radioY, selectNoise, legendBox, emptyDesc], doc);
    const result = await extractForm(env, params());
    const byName = Object.fromEntries(result.fields.map((f) => [f.name, f]));
    expect(byName["email"].label).toBe("email"); // fell all the way back to the name
    expect(byName["only-id"]).toBeDefined();
    expect(result.fields.filter((f) => f.name === "twice")).toHaveLength(1);
    expect(byName["pick"].options).toEqual(["Option A", "b-value"]);
    expect(byName["noise"].options).toEqual([]);
    expect(byName["legend_grp"].label).toBe("Pick your perks");
    expect(byName["empty_desc"]).toBeDefined();
  });

  function usePageDom(elements: unknown[], doc: Record<string, unknown>) {
    launch.mockResolvedValue({ newPage: async () => domPage(elements, doc), close: vi.fn(async () => {}) });
  }
});
