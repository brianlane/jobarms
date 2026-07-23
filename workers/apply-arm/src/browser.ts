/**
 * Browser session logic: navigate, extract the application form, fill it,
 * submit. One entry point per phase so the Workflow can retry each phase as
 * its own step with a fresh browser session (sessions cannot survive the
 * human-latency review gate anyway).
 */
import { Buffer } from "node:buffer";
import { launch, type Browser, type Page } from "@cloudflare/playwright";
import type { Answer, Env, FormField, RunParams } from "./types";
import { ADAPTERS } from "./adapters";

export interface FillResult {
  fields: FormField[];
  screenshot: Uint8Array;
}

export interface SubmitResult {
  confirmed: boolean;
  screenshot: Uint8Array;
}

async function withBrowser<T>(env: Env, fn: (page: Page) => Promise<T>): Promise<T> {
  if (!env.BROWSER) {
    throw new Error("BROWSER binding missing — Workers Paid + wrangler.jsonc bindings required");
  }
  const browser: Browser = await launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(20_000);
    return await fn(page);
  } finally {
    await browser.close();
  }
}

/** Extract the form fields from the job's application page. */
export async function extractForm(env: Env, params: RunParams): Promise<FillResult> {
  return withBrowser(env, async (page) => {
    const adapter = ADAPTERS[params.ats];
    await page.goto(params.jobUrl, { waitUntil: "domcontentloaded" });
    await adapter.openApplication(page);
    await page.waitForSelector(adapter.formSelector, { timeout: 20_000 });

    const fields = await collectFields(page, adapter.formSelector);
    const screenshot = new Uint8Array(await page.screenshot({ fullPage: true }));
    return { fields, screenshot };
  });
}

/** Fill the form with approved answers and (optionally) submit. */
export async function fillAndMaybeSubmit(
  env: Env,
  params: RunParams,
  answers: Answer[],
  submit: boolean
): Promise<SubmitResult> {
  return withBrowser(env, async (page) => {
    const adapter = ADAPTERS[params.ats];
    await page.goto(params.jobUrl, { waitUntil: "domcontentloaded" });
    await adapter.openApplication(page);
    await page.waitForSelector(adapter.formSelector, { timeout: 20_000 });

    // Attach the resume first — some ATSes autofill fields from it and we
    // want typed answers to win.
    if (params.resume.signedUrl) {
      await attachResume(page, params);
    }

    for (const answer of answers) {
      if (answer.skipped || answer.value === "") continue;
      await fillField(page, adapter.formSelector, answer);
    }

    if (!submit) {
      const screenshot = new Uint8Array(await page.screenshot({ fullPage: true }));
      return { confirmed: false, screenshot };
    }

    await adapter.submit(page);
    const confirmed = await adapter.confirmSubmitted(page);
    const screenshot = new Uint8Array(await page.screenshot({ fullPage: true }));
    return { confirmed, screenshot };
  });
}

// ---------------------------------------------------------------------------

async function collectFields(page: Page, formSelector: string): Promise<FormField[]> {
  // The callback below is serialized and executed IN THE PAGE (browser DOM),
  // so it's typed loosely — the worker's tsconfig has no DOM lib on purpose.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const inPage = (elements: any[]): FormField[] => {
    const doc = (globalThis as any).document;
    const cssEscape = (globalThis as any).CSS.escape as (v: string) => string;
    const fields: FormField[] = [];
    const seen = new Set<string>();

    const labelFor = (el: any): string => {
      const id = el.getAttribute("id");
      if (id) {
        const label = doc.querySelector(`label[for="${cssEscape(id)}"]`);
        if (label?.textContent) return label.textContent.trim();
      }
      const wrapping = el.closest("label");
      if (wrapping?.textContent) return wrapping.textContent.trim();
      const aria = el.getAttribute("aria-label");
      if (aria) return aria;
      const placeholder = el.getAttribute("placeholder");
      if (placeholder) return placeholder;
      return el.getAttribute("name") ?? "";
    };

    for (const el of elements) {
      const tag = el.tagName.toLowerCase();
      const type = tag === "input" ? (el.getAttribute("type") ?? "text").toLowerCase() : tag;
      if (["hidden", "submit", "button", "image"].includes(type)) continue;

      const name = el.getAttribute("name") ?? el.getAttribute("id") ?? "";
      if (!name) continue;

      // Radio groups: one field per name, options aggregated.
      if (type === "radio") {
        if (seen.has(name)) continue;
        seen.add(name);
        const radios: any[] = Array.from(
          doc.querySelectorAll(`input[type="radio"][name="${cssEscape(name)}"]`)
        );
        fields.push({
          name,
          label: labelFor(el),
          type: "radio",
          required: radios.some((r) => r.hasAttribute("required")),
          options: radios.map((r) => {
            const rid = r.getAttribute("id");
            const rl = rid ? doc.querySelector(`label[for="${cssEscape(rid)}"]`) : null;
            return ((rl?.textContent ?? r.getAttribute("value")) ?? "").trim();
          })
        });
        continue;
      }

      if (seen.has(name)) continue;
      seen.add(name);

      let options: string[] = [];
      if (tag === "select") {
        options = Array.from(el.querySelectorAll("option"))
          .map((o: any) => (o.textContent ?? "").trim())
          .filter((t: string) => t && !/^select/i.test(t));
      }

      fields.push({
        name,
        label: labelFor(el).replace(/\s+/g, " ").slice(0, 300),
        type: type === "select" ? "select" : type,
        required: el.hasAttribute("required") || el.getAttribute("aria-required") === "true",
        options
      });
    }
    return fields;
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return page.$$eval(
    `${formSelector} input, ${formSelector} textarea, ${formSelector} select`,
    inPage
  );
}

async function fillField(page: Page, formSelector: string, answer: Answer): Promise<void> {
  const esc = answer.name.replace(/"/g, '\\"');
  const base = `${formSelector} [name="${esc}"], ${formSelector} #${CSS_escape(answer.name)}`;

  const el = page.locator(base).first();
  const count = await el.count();
  if (count === 0) return;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tag = await el.evaluate((node: any) => node.tagName.toLowerCase());
  const type = tag === "input" ? await el.getAttribute("type") : tag;

  try {
    switch ((type ?? "text").toLowerCase()) {
      case "select":
        await el.selectOption({ label: answer.value });
        break;
      case "checkbox": {
        if (answer.value === "true") await el.check();
        break;
      }
      case "radio": {
        const radios = page.locator(`${formSelector} input[type="radio"][name="${esc}"]`);
        const n = await radios.count();
        for (let i = 0; i < n; i++) {
          const radio = radios.nth(i);
          const id = await radio.getAttribute("id");
          const label = id ? await page.locator(`label[for="${id}"]`).textContent() : null;
          const value = await radio.getAttribute("value");
          if ((label ?? "").trim() === answer.value || value === answer.value) {
            await radio.check();
            break;
          }
        }
        break;
      }
      case "file":
        break; // handled by attachResume
      default:
        await el.fill(answer.value);
    }
  } catch {
    // Field visible in DOM but not interactable — leave for review.
  }
}

function CSS_escape(value: string): string {
  return value.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}

async function attachResume(page: Page, params: RunParams): Promise<void> {
  if (!params.resume.signedUrl) return;
  const res = await fetch(params.resume.signedUrl);
  if (!res.ok) return;
  const buffer = new Uint8Array(await res.arrayBuffer());

  const fileInput = page.locator('input[type="file"]').first();
  if ((await fileInput.count()) === 0) return;
  try {
    await fileInput.setInputFiles({
      name: params.resume.fileName || "resume.pdf",
      mimeType: params.resume.mimeType || "application/pdf",
      buffer: Buffer.from(buffer)
    });
    // Give ATS-side resume parsing a moment before typed answers land.
    await page.waitForTimeout(3000);
  } catch {
    // Upload widget not a plain input — leave for review gate.
  }
}
