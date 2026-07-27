/**
 * jobarms-render HTTP surface.
 *
 * The apply-arm Workflow keeps owning orchestration (the review gate, the
 * verification wait, retries, refunds) and calls this box for every browser
 * phase. One request equals one phase, so a crash mid-run costs a step, never
 * the run.
 *
 * IMPORTANT: application-level failures return HTTP **200** with an
 * `{ error, detail }` body, NOT a 5xx. This service sits behind a Cloudflare
 * Tunnel, and Cloudflare REPLACES the body of any origin 5xx with its own error
 * page, which would erase the structured error and make the worker retry a
 * permanent failure. The worker classifies on the `error` code and treats a
 * genuine non-2xx as a transport failure worth retrying. Client errors (400/401)
 * keep their status, since Cloudflare passes 4xx through.
 *
 * EQUALLY IMPORTANT: the three phases that drive a form return a job id, not a
 * result. Cloudflare also caps an origin response at 100 seconds, and these
 * phases regularly run longer (a 24-field Lever fill measured 133s), so waiting
 * inline turned finished work into a 524. They start the phase and the caller
 * polls GET /jobs/:id. See jobs.ts.
 *
 * Endpoints (all bearer-authed except /health):
 *   POST /session/ensure  - start: authenticate/create the candidate account
 *   POST /extract         - start: reach the form and read its fields
 *   POST /fill            - start: fill approved answers, optionally submit
 *   GET  /jobs/:id        - poll one of the above
 *   POST /verify          - finish an email verification in the held session.
 *                           Synchronous: one navigation, and its caller is the
 *                           inbound-mail webhook, which wants a prompt answer.
 */
import express, { type Express, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import type { BrowserContext, Page } from "playwright";
import { CONFIG } from "./config.js";
import { safeUrl } from "./ssrf.js";
import {
  acquireSession,
  dropSession,
  finishSession,
  saveStorageState,
  sessionCount,
  sessionKey
} from "./sessions.js";
import { ADAPTERS } from "./adapters.js";
import { FormNotFoundError, reachForm } from "./reach.js";
import { filterApplicationFields } from "./field-filter.js";
import {
  alternativeTactics,
  attachResume,
  DEFAULT_TACTICS,
  fillAnswers,
  fillField,
  type Tactics
} from "./fill.js";
import { collectFields, readFilledState } from "./extract.js";
import { completeVerification, ensureAccount } from "./account.js";
import { detectChallenge, httpSolver, solveChallenge, type AskSolver } from "./captcha.js";
import { type JobPayload, readJob, runningJobs, startJob } from "./jobs.js";
import { blocksSubmit, checkAnswers, type FillCheck } from "./verify.js";
import type { Answer, Ats, FormField, Mismatch, SubmitOutcome, TacticWin } from "./types.js";

const ATS_VALUES: readonly Ats[] = ["greenhouse", "lever", "workday"];

function isAts(value: unknown): value is Ats {
  return typeof value === "string" && (ATS_VALUES as readonly string[]).includes(value);
}

/** A structured, retry-safe application error (see the module doc). */
function appError(res: Response, error: string, detail = ""): Response {
  return res.status(200).json({ error, ...(detail ? { detail: detail.slice(0, 400) } : {}) });
}

/** The same structured error, as a job result rather than a response body. */
function errorPayload(error: string, detail: string): JobPayload {
  return { error, detail: detail.slice(0, 400) };
}

/**
 * Verdict per answer, across however many pages a form spans.
 *
 * The LAST look at a field wins. A wizard is checked page by page, so a control
 * that could not be driven on one page and was driven correctly on the next must
 * stop counting as a problem; simply appending every page's findings would report
 * a field as wrong long after it came right, and refuse to submit a form that is
 * actually correct.
 */
function fillVerdicts() {
  const byName = new Map<string, Mismatch | null>();
  return {
    record(check: { mismatches: Mismatch[]; seen: string[] }) {
      for (const name of check.seen) byName.set(name, null);
      for (const mismatch of check.mismatches) byName.set(mismatch.name, mismatch);
    },
    mismatches(): Mismatch[] {
      return [...byName.values()].filter((entry): entry is Mismatch => entry !== null);
    }
  };
}

/** Read the form back and compare it to the answers it was given. */
async function checkFill(page: Page, scope: string, answers: Answer[]) {
  return checkAnswers(answers, await readFilledState(page, scope));
}

/**
 * Try the fields that did not take again, the other way round.
 *
 * Sites disagree about how a control wants to be driven: a custom widget can
 * leave its real input hidden and wire everything to the visible label, so
 * ticking the input does nothing while clicking the label works. Rather than
 * guess per ATS, the read-back says which fields failed and this tries the other
 * way, then looks again. Whatever worked is reported so the caller can remember
 * it and lead with it next time on this site.
 */
async function retryWithAlternative(
  page: Page,
  scope: string,
  answers: Answer[],
  failed: Mismatch[],
  tactics: Tactics
): Promise<{ check: FillCheck; tried: TacticWin[] }> {
  const other = alternativeTactics(tactics);
  const failedNames = new Set(failed.map((mismatch) => mismatch.name));

  // Walked in answer order rather than looked up per mismatch: every mismatch
  // came from this list, so a lookup could only ever add a branch that cannot
  // happen.
  for (const answer of answers) {
    if (failedNames.has(answer.name)) await fillField(page, scope, answer, other);
  }

  // What was ATTEMPTED, not what worked. Whether it worked cannot be judged here:
  // on a wizard this page's read-back says nothing about a field still wrong two
  // pages back, and teaching a tactic while that field is broken is how you learn
  // the wrong lesson confidently. The caller decides, once it has seen everything.
  const tried: TacticWin[] = [...new Set(failed.map((mismatch) => mismatch.kind))].map((kind) => ({
    kind,
    tactic: kind === "choice" ? other.choice : other.text
  }));

  return { check: await checkFill(page, scope, answers), tried };
}

/** Screenshot the page as base64 JPEG. Never throws; null when it fails. */
async function shot(page: Page): Promise<string | null> {
  try {
    const buffer = await page.screenshot({ fullPage: true, type: "jpeg", quality: 60 });
    return buffer.toString("base64");
  } catch {
    // A failed screenshot must never fail the phase; the answers still flow.
    return null;
  }
}

/**
 * Serialize browser work. Each phase drives a real Chromium context, and on the
 * shared KVM1 box more than a couple at once thrashes. Requests queue rather
 * than fail, since the caller is a durable workflow that is happy to wait.
 */
function createGate(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= limit) {
      // Woken by a finishing job that handed its slot straight over, so the
      // count already includes this caller and must not be incremented again.
      await new Promise<void>((resolve) => queue.push(resolve));
    } else {
      active++;
    }
    try {
      return await fn();
    } finally {
      // Hand the slot to the next waiter rather than releasing it and waking
      // them. Releasing first left a window where `active` had dropped but the
      // woken waiter had not resumed, so a fresh caller could walk straight
      // through the check and take the same slot, putting two jobs on one
      // permit and pushing past RENDER_MAX_CONCURRENCY.
      const next = queue.shift();
      if (next) {
        next();
      } else {
        active--;
      }
    }
  };
}

interface PhaseContext {
  page: Page;
  context: BrowserContext;
  key: string;
}

export interface AppDeps {
  /** Injected so tests can drive phases without a real browser. */
  runPhase?: <T>(
    userId: string,
    tenantHost: string,
    fn: (ctx: PhaseContext) => Promise<T>
  ) => Promise<T>;
  /**
   * Injected so tests can decide tile picks without HTTP. In production this
   * falls back to `httpSolver()`, which asks the worker (where the vision model
   * and its credentials live).
   */
  askSolver?: AskSolver;
}

export function createApp(deps: AppDeps = {}): Express {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  // Rate-limit BEFORE auth so a leaked or guessed bearer cannot be brute-forced
  // and one caller cannot exhaust the browser pool.
  app.use(
    rateLimit({
      windowMs: CONFIG.rateWindowMs,
      max: CONFIG.rateMax,
      standardHeaders: true,
      legacyHeaders: false
    })
  );

  app.get("/health", (_req, res) => {
    res.json({ ok: true, sessions: sessionCount(), jobs: runningJobs() });
  });

  app.use((req, res, next) => {
    if (!CONFIG.token) return next(); // unset only in local dev
    if (req.headers.authorization === `Bearer ${CONFIG.token}`) return next();
    return void res.status(401).json({ error: "unauthorized" });
  });

  const withSlot = createGate(CONFIG.maxConcurrency);

  /**
   * Hand back a job id and let the phase run on. `work` must resolve with the
   * payload the caller should eventually read, including for failures, so every
   * outcome is polled the same way.
   */
  function startPhase(res: Response, work: () => Promise<JobPayload>): void {
    res.json({ jobId: startJob(work) });
  }

  app.get("/jobs/:id", (req, res) => {
    const entry = readJob(req.params.id);
    // Unknown means the box restarted or the result aged out. Reported as a
    // structured error so the worker retries the phase rather than waiting on an
    // answer that is never coming.
    if (!entry) return void appError(res, "job_not_found");
    return void res.json(entry);
  });

  /**
   * Open a page in the user's cached context for this tenant, run one phase, and
   * always persist cookies + release the session. `poisoned` drops the cached
   * context so a broken login is never reused.
   */
  const runPhase =
    deps.runPhase ??
    (async function runPhase<T>(
      userId: string,
      tenantHost: string,
      fn: (ctx: PhaseContext) => Promise<T>
    ): Promise<T> {
      const key = sessionKey(userId, tenantHost);
      const entry = await acquireSession(key);
      // acquireSession resolves `context` or throws, so it is set here.
      const context = entry.context!;
      let page: Page | null = null;
      let poisoned = false;
      try {
        const opened = await context.newPage();
        page = opened;
        opened.setDefaultTimeout(CONFIG.actionTimeoutMs);
        return await fn({ page: opened, context, key });
      } catch (err) {
        poisoned = true;
        throw err;
      } finally {
        // Save BEFORE closing the page so a just-completed login persists, but
        // NOT if the session was dropped mid-phase (a disconnect): dropSession
        // deletes the cookie file, and re-saving here would revive the login the
        // user just asked us to forget. `doomed` is set synchronously by
        // dropSession before it deletes the file, so this check cannot race it.
        if (!entry.doomed) await saveStorageState(key, context);
        if (page) await page.close().catch(() => {});
        finishSession(key, entry, poisoned);
      }
    });

  /** Shared request parsing for the phases that navigate to a posting. */
  function parseJobRequest(req: Request):
    | { ok: true; userId: string; jobUrl: string; ats: Ats; tenantHost: string }
    | { ok: false; error: string } {
    const body = req.body ?? {};
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    const rawUrl = typeof body.jobUrl === "string" ? body.jobUrl : "";
    if (!userId || !isAts(body.ats)) return { ok: false, error: "invalid_body" };
    const jobUrl = safeUrl(rawUrl);
    if (!jobUrl) return { ok: false, error: "invalid_or_unsafe_url" };
    return { ok: true, userId, jobUrl, ats: body.ats, tenantHost: new URL(jobUrl).hostname };
  }

  // ------------------------------------------------------------------ session
  app.post("/session/ensure", (req, res) => {
    const parsed = parseJobRequest(req);
    if (!parsed.ok) {
      return parsed.error === "invalid_body"
        ? void res.status(400).json({ error: parsed.error })
        : void appError(res, parsed.error);
    }
    const account = req.body?.account ?? {};
    const adapter = ADAPTERS[parsed.ats];

    // ATSes that need no account are trivially "authenticated". Still answered
    // as a job so every phase route keeps ONE contract: the caller always gets a
    // job id back and never has to branch on which shape arrived.
    if (!adapter.requiresAccount) {
      return void startPhase(res, () =>
        Promise.resolve({ status: "authenticated", accountRequired: false })
      );
    }
    if (typeof account.email !== "string" || typeof account.password !== "string") {
      return void res.status(400).json({ error: "invalid_body" });
    }

    return void startPhase(res, async () => {
      try {
        const result = await withSlot(() =>
          runPhase(parsed.userId, parsed.tenantHost, async ({ page }) => {
            await page.goto(parsed.jobUrl, { waitUntil: "domcontentloaded" });
            await adapter.openApplication(page);
            const status = await ensureAccount(page, account);
            return { status, screenshotBase64: await shot(page) };
          })
        );
        return { ...result, accountRequired: true };
      } catch (err) {
        return errorPayload("render_failed", String(err));
      }
    });
  });

  app.post("/verify", async (req, res) => {
    const body = req.body ?? {};
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    const tenantHost = typeof body.tenantHost === "string" ? body.tenantHost.trim() : "";
    const link = typeof body.link === "string" ? safeUrl(body.link) : null;
    const code = typeof body.code === "string" ? body.code : null;
    if (!userId || !tenantHost || (!link && !code)) {
      return void res.status(400).json({ error: "invalid_body" });
    }

    try {
      const result = await withSlot(() =>
        runPhase(userId, tenantHost, async ({ page }) => {
          // A code has to be typed into the page the tenant left us on, so start
          // from the tenant root when we only have a code.
          if (!link) {
            await page
              .goto(`https://${tenantHost}/`, { waitUntil: "domcontentloaded" })
              .catch(() => {});
          }
          const status = await completeVerification(page, { link, code });
          return { status, screenshotBase64: await shot(page) };
        })
      );
      return void res.json(result);
    } catch (err) {
      return void appError(res, "render_failed", String(err));
    }
  });

  // Forget a stored session on disconnect. Synchronous and tiny: it evicts the
  // cached context and deletes the cookie file, so the user's next run starts
  // logged out. Not a browser phase, so it never takes a concurrency slot.
  app.delete("/session", async (req, res) => {
    const body = req.body ?? {};
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    const tenantHost = typeof body.tenantHost === "string" ? body.tenantHost.trim() : "";
    if (!userId || !tenantHost) return void res.status(400).json({ error: "invalid_body" });
    await dropSession(sessionKey(userId, tenantHost));
    return void res.json({ ok: true });
  });

  // ------------------------------------------------------------------ extract
  app.post("/extract", (req, res) => {
    const parsed = parseJobRequest(req);
    if (!parsed.ok) {
      return parsed.error === "invalid_body"
        ? void res.status(400).json({ error: parsed.error })
        : void appError(res, parsed.error);
    }
    const playbook = req.body?.playbook ?? null;

    return void startPhase(res, async () => {
      try {
        return await withSlot(() =>
          runPhase(parsed.userId, parsed.tenantHost, async ({ page }) => {
            const reached = await reachForm(
              page,
              parsed.jobUrl,
              parsed.ats,
              { playbook },
              { throwIfNotFound: true }
            );

            // Multi-page wizards (Workday): keep walking while the adapter can
            // advance, accumulating every page's fields into ONE review payload
            // so the user approves the whole application at once. Bounded so a
            // never-advancing wizard cannot spin.
            const adapter = ADAPTERS[parsed.ats];
            const all: FormField[] = [...reached.rawFields];
            let pages = 1;
            if (adapter.nextPage) {
              while (pages < CONFIG.maxWizardPages) {
                if (await adapter.isLastPage?.(page)) break;
                if (!(await adapter.nextPage(page))) break;
                pages++;
                const more = await collectFields(page, reached.scope);
                // Later pages repeat nothing, but guard anyway: a wizard that
                // re-renders the same page would otherwise duplicate questions.
                const seen = new Set(all.map((f) => f.name));
                for (const field of more) if (!seen.has(field.name)) all.push(field);
              }
            }

            return {
              fields: filterApplicationFields(all),
              pages,
              scope: reached.scope,
              recovery: reached.recovery,
              playbookFailed: reached.playbookFailed,
              screenshotBase64: await shot(page)
            };
          })
        );
      } catch (err) {
        if (err instanceof FormNotFoundError) {
          // Not retryable as-is, but the caller can look at the screenshot, pick
          // a recovery strategy with its vision model, and call back with it as
          // the `playbook`. So the shot and the reason both ride along.
          return {
            error: "form_not_found",
            detail: err.reason.slice(0, 400),
            ...(err.screenshot ? { screenshotBase64: err.screenshot.toString("base64") } : {})
          };
        }
        return errorPayload("render_failed", String(err));
      }
    });
  });

  // --------------------------------------------------------------------- fill
  app.post("/fill", (req, res) => {
    const parsed = parseJobRequest(req);
    if (!parsed.ok) {
      return parsed.error === "invalid_body"
        ? void res.status(400).json({ error: parsed.error })
        : void appError(res, parsed.error);
    }
    // parseJobRequest already proved the body exists and carries a userId + ats.
    const body = req.body;
    if (!Array.isArray(body.answers)) {
      return void res.status(400).json({ error: "invalid_body" });
    }
    const answers = body.answers as Answer[];
    const submit = body.submit === true;
    // Optional: only used to attribute captcha model spend to the run.
    const runId = typeof body.runId === "string" ? body.runId : "";
    const resume = body.resume ?? { contentBase64: null, fileName: "", mimeType: "" };
    const playbook = body.playbook ?? null;
    // What worked on this site before, so a known-awkward widget is driven the
    // right way on the FIRST attempt rather than rediscovered every run.
    const tactics: Tactics = { ...DEFAULT_TACTICS, ...(body.tactics ?? {}) };

    return void startPhase(res, async () => {
      try {
        return await withSlot(() =>
          runPhase(parsed.userId, parsed.tenantHost, async ({ page }) => {
            // Reach the SAME form extraction found. Lenient: fillField's page-wide
            // fallback beats filling nothing.
            const reached = await reachForm(
              page,
              parsed.jobUrl,
              parsed.ats,
              { playbook },
              { throwIfNotFound: false }
            );
            const adapter = ADAPTERS[parsed.ats];

            // Resume first: some ATSes autofill from it and typed answers must win.
            // The outcome rides along on every reply: a resume that did not attach
            // leaves a REQUIRED field empty, and the review gate can only warn
            // about what it is told.
            const resumeOutcome = await attachResume(page, resume);
            await fillAnswers(page, reached.scope, answers, tactics);

            // Read the page back and compare it to what was approved. Checked
            // BEFORE advancing, because a wizard page's state is gone once we
            // leave it, so this is the only moment it can be seen.
            const verdicts = fillVerdicts();
            const attempted: TacticWin[] = [];

            /** Check, and if something did not take, try the other way once. */
            const settle = async (target: Page, scope: string, list: Answer[]) => {
              const first = await checkFill(target, scope, list);
              if (first.mismatches.length === 0) return first;
              const retry = await retryWithAlternative(target, scope, list, first.mismatches, tactics);
              attempted.push(...retry.tried);
              return retry.check;
            };

            /**
             * The tactics worth remembering, judged against the WHOLE form.
             *
             * A kind only counts as solved when nothing of that kind is still
             * wrong anywhere, so neither one lucky field nor one clean wizard page
             * can teach a tactic the rest of the form disagrees with.
             */
            const learnedTactics = (): TacticWin[] => {
              const stillWrong = new Set(verdicts.mismatches().map((m) => m.kind));
              const byKind = new Map(
                attempted.filter((win) => !stillWrong.has(win.kind)).map((win) => [win.kind, win])
              );
              return [...byKind.values()];
            };

            verdicts.record(await settle(page, reached.scope, answers));

            // Multi-page: fill each page, then advance. The same answer list is
            // applied per page; fillField no-ops on names this page does not have.
            let pages = 1;
            if (adapter.nextPage) {
              while (pages < CONFIG.maxWizardPages) {
                if (await adapter.isLastPage?.(page)) break;
                if (!(await adapter.nextPage(page))) break;
                pages++;
                await fillAnswers(page, reached.scope, answers, tactics);
                verdicts.record(await settle(page, reached.scope, answers));
              }
            }

            if (!submit) {
              return {
                outcome: "filled" as SubmitOutcome,
                resume: resumeOutcome,
                mismatches: verdicts.mismatches(),
              tactics: learnedTactics(),
                pages,
                screenshotBase64: await shot(page)
              };
            }

            // The interlock. A choice field that disagrees is a factual
            // misstatement made on the user's behalf, so this refuses to send it
            // and hands the run to a human instead of failing it outright.
            //
            // Judged on everything gathered page by page above, NOT on a fresh
            // read of the page we happen to be standing on: a wizard's earlier
            // pages are already out of the DOM by now.
            if (blocksSubmit(verdicts.mismatches())) {
              return {
                outcome: "verification_failed" as SubmitOutcome,
                resume: resumeOutcome,
                mismatches: verdicts.mismatches(),
              tactics: learnedTactics(),
                pages,
                screenshotBase64: await shot(page)
              };
            }

            const askSolver =
              deps.askSolver ?? httpSolver({ userId: parsed.userId, ...(runId ? { runId } : {}) });

            // A challenge sitting on the form BEFORE we submit (a v2 checkbox next
            // to the button) is worth clearing first: submitting into it just
            // wastes the attempt.
            const preKind = await detectChallenge(page);
            if (preKind && askSolver) {
              await solveChallenge(page, preKind, askSolver).catch(() => false);
            }

            // A deliberate pause before the final click so behavioral scoring sees
            // a human cadence, then click the REAL control (never a programmatic
            // submit) so the site's captcha JS mints its token.
            await page.waitForTimeout(1000 + Math.floor(Math.random() * 1000));
            await adapter.submit(page);
            await page.waitForTimeout(2500);

            if (await adapter.confirmSubmitted(page).catch(() => false)) {
              return {
                outcome: "submitted" as SubmitOutcome,
                resume: resumeOutcome,
                mismatches: verdicts.mismatches(),
              tactics: learnedTactics(),
                pages,
                screenshotBase64: await shot(page)
              };
            }

            // No confirmation. A challenge on screen now means one escalated on
            // submit (the invisible check failed and forced a visible puzzle, or
            // the form re-rendered with one). Try to clear it and send again.
            const postKind = await detectChallenge(page);
            if (postKind) {
              const solved = askSolver
                ? await solveChallenge(page, postKind, askSolver).catch(() => false)
                : false;
              if (solved) {
                await adapter.submit(page).catch(() => {});
                await page.waitForTimeout(2500);
                if (await adapter.confirmSubmitted(page).catch(() => false)) {
                  return {
                    outcome: "submitted" as SubmitOutcome,
                    resume: resumeOutcome,
                    mismatches: verdicts.mismatches(),
              tactics: learnedTactics(),
                    pages,
                    screenshotBase64: await shot(page)
                  };
                }
              }
              // Everything is filled and the employer's bot check stopped the
              // send. An honest, specific outcome: metering counts it as work
              // done and the user is told to finish on the employer's site.
              return {
                outcome: "captcha_blocked" as SubmitOutcome,
                resume: resumeOutcome,
                mismatches: verdicts.mismatches(),
              tactics: learnedTactics(),
                pages,
                screenshotBase64: await shot(page)
              };
            }

            return {
              outcome: "unconfirmed" as SubmitOutcome,
              resume: resumeOutcome,
              mismatches: verdicts.mismatches(),
              tactics: learnedTactics(),
              pages,
              screenshotBase64: await shot(page)
            };
          })
        );
      } catch (err) {
        return errorPayload("render_failed", String(err));
      }
    });
  });

  return app;
}
