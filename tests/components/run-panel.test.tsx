// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RunPanel, type RunData } from "@/components/RunPanel";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const AT = "2026-07-24T10:00:00Z";

function run(over: Partial<RunData>): RunData {
  return {
    id: "run-1",
    status: "running",
    autonomy: "review_gate",
    steps: [],
    answers: null,
    form_fields: [],
    error: null,
    slot_refunded: false,
    created_at: AT,
    ...over
  };
}

/** fetch stub: screenshots GET returns `shots`, everything else returns ok. */
function stubFetch(shots: { path: string; url: string }[] = [], actionOk = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (typeof url === "string" && url.endsWith("/screenshots")) {
        return { ok: true, json: async () => ({ screenshots: shots }) };
      }
      return { ok: actionOk, json: async () => (actionOk ? {} : { hint: "Action failed." }) };
    })
  );
}

beforeEach(() => {
  router.refresh.mockClear();
  stubFetch();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("RunPanel review gate", () => {
  it("renders editable answers and approves", async () => {
    stubFetch([{ path: "p1", url: "https://s/1" }]); // screenshots open while reviewing
    render(
      <RunPanel
        run={run({
          status: "needs_review",
          answers: [
            { name: "phone", label: "Phone", value: "555" },
            { name: "nolabel", label: "", value: "has value but no label" },
            { name: "long", label: "Essay", value: "x".repeat(150) },
            { name: "blank", label: "", value: "" }, // filtered out of the review list
            { name: "why", label: "Why?", value: "", skipped: true }
          ]
        })}
        applicationId="app-1"
      />
    );
    expect(screen.getByText(/review the answers below/)).toBeInTheDocument();
    await screen.findByText(/Screenshots from the arm/);
    const phone = screen.getByDisplayValue("555");
    fireEvent.change(phone, { target: { value: "555-1234" } });
    fireEvent.click(screen.getByText("Approve and submit application"));
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(fetch).toHaveBeenCalledWith("/api/runs/run-1/approve", expect.objectContaining({ method: "POST" }));
  });

  it("renders a dropdown for a choice question, with a leave-blank entry", async () => {
    // Free text boxes on multiple-choice questions invite answers the form
    // will refuse; the review edit offers the form's actual options instead.
    stubFetch();
    render(
      <RunPanel
        run={run({
          status: "needs_review",
          form_fields: [
            { name: "gender", label: "What is your gender identity?", type: "radio", required: false, options: ["Man", "Woman", "Non-Binary"] }
          ],
          answers: [{ name: "gender", label: "What is your gender identity?", value: "" , skipped: true }]
        })}
        applicationId="app-1"
      />
    );
    const select = screen.getByRole("combobox");
    expect(select).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "(leave blank)" })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "Woman" } });
    fireEvent.click(screen.getByText("Approve and submit application"));
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    const body = JSON.parse(
      (fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) => c[0] === "/api/runs/run-1/approve"
      )![1].body as string
    );
    expect(body.answers[0]).toMatchObject({ value: "Woman", skipped: false });
  });

  it("keeps an off-menu answer selectable rather than silently dropping it", () => {
    stubFetch();
    render(
      <RunPanel
        run={run({
          status: "needs_review",
          form_fields: [
            { name: "years", label: "Years", type: "select", required: true, options: ["1-3", "4+"] }
          ],
          answers: [{ name: "years", label: "Years", value: "about five" }]
        })}
        applicationId="app-1"
      />
    );
    // The model's off-menu draft still shows as the current selection.
    expect(screen.getByRole("option", { name: "about five" })).toBeInTheDocument();
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("about five");
  });

  it("renders a checkbox list for a multi-option group and joins with semicolons", async () => {
    stubFetch();
    render(
      <RunPanel
        run={run({
          status: "needs_review",
          form_fields: [
            {
              name: "Bisexual",
              label: "How do you identify your sexual orientation?",
              type: "checkbox",
              required: false,
              options: ["Bisexual", "Queer", "I prefer not to answer"]
            }
          ],
          answers: [
            { name: "Bisexual", label: "How do you identify your sexual orientation?", value: "Queer" }
          ]
        })}
        applicationId="app-1"
      />
    );
    const queer = screen.getByRole("checkbox", { name: "Queer" }) as HTMLInputElement;
    expect(queer.checked).toBe(true);

    // Tick one more, untick the original: the answer follows in option order.
    fireEvent.click(screen.getByRole("checkbox", { name: "Bisexual" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Queer" }));
    fireEvent.click(screen.getByText("Approve and submit application"));
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    const body = JSON.parse(
      (fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) => c[0] === "/api/runs/run-1/approve"
      )![1].body as string
    );
    expect(body.answers[0].value).toBe("Bisexual");
  });

  it("reads a comma-joined draft the way the filler would", () => {
    // The sidecar's splitAnswerValues accepts semicolons AND commas; a
    // comma-joined model draft must not render as nothing selected while
    // still filling fine after approval.
    stubFetch();
    render(
      <RunPanel
        run={run({
          status: "needs_review",
          form_fields: [
            { name: "grp", label: "Which apply?", type: "checkbox", required: false, options: ["A", "B", "C"] }
          ],
          answers: [{ name: "grp", label: "Which apply?", value: "A, C" }]
        })}
        applicationId="app-1"
      />
    );
    expect((screen.getByRole("checkbox", { name: "A" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "B" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("checkbox", { name: "C" }) as HTMLInputElement).checked).toBe(true);
  });

  it("nags only for skipped REQUIRED fields; optional blanks are just noted", () => {
    stubFetch();
    render(
      <RunPanel
        run={run({
          status: "needs_review",
          form_fields: [
            { name: "must", label: "Must", type: "text", required: true, options: [] },
            { name: "may", label: "May", type: "text", required: false, options: [] }
          ],
          answers: [
            { name: "must", label: "Must", value: "", skipped: true },
            { name: "may", label: "May", value: "", skipped: true }
          ]
        })}
        applicationId="app-1"
      />
    );
    expect(screen.getAllByText("needs your answer")).toHaveLength(1);
    expect(screen.getByText("(left blank, optional)")).toBeInTheDocument();
  });

  it("tolerates junk form structure and falls back to text areas", () => {
    stubFetch();
    render(
      <RunPanel
        run={run({
          status: "needs_review",
          form_fields: [
            null,
            "junk",
            { noName: true },
            { name: "q", type: 7, required: "yes", options: "not-an-array" },
            { name: "r", type: "radio", options: ["A", 3, "B"] }
          ] as unknown,
          answers: [
            { name: "q", label: "Q", value: "v" },
            { name: "r", label: "R", value: "A" }
          ]
        })}
        applicationId="app-1"
      />
    );
    // q: junk shape degrades to a plain text box; r: mixed options keep strings.
    expect(screen.getByDisplayValue("v").tagName).toBe("TEXTAREA");
    expect(screen.getByRole("option", { name: "B" })).toBeInTheDocument();
  });

  it("keeps the nag for skipped answers when the run stored no form structure", () => {
    stubFetch();
    render(
      <RunPanel
        run={run({
          status: "needs_review",
          form_fields: null as unknown,
          answers: [{ name: "old", label: "Old run", value: "", skipped: true }]
        })}
        applicationId="app-1"
      />
    );
    expect(screen.getByText("needs your answer")).toBeInTheDocument();
  });

  it("shows the snag state when there is nothing reviewable", async () => {
    render(<RunPanel run={run({ status: "needs_review", answers: [{ name: "x", label: "", value: "" }] })} applicationId="app-1" />);
    expect(screen.getByText(/hit a snag/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Retry with a fresh arm"));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/applications/app-1/retry", expect.any(Object)));
  });

  it("surfaces an action error hint", async () => {
    stubFetch([], false);
    render(<RunPanel run={run({ status: "needs_review", answers: [{ name: "p", label: "P", value: "v" }] })} applicationId="app-1" />);
    fireEvent.click(screen.getByText("Approve and submit application"));
    expect(await screen.findByText("Action failed.")).toBeInTheDocument();
  });

  it("cancels a review-gated run from the header control", async () => {
    render(<RunPanel run={run({ status: "needs_review", answers: [{ name: "p", label: "P", value: "v" }] })} applicationId="app-1" />);
    fireEvent.click(screen.getByText("Cancel this run"));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/runs/run-1/cancel", expect.any(Object)));
  });

  it("cancels from the snag block", async () => {
    render(<RunPanel run={run({ status: "needs_review", answers: [{ name: "x", label: "", value: "" }] })} applicationId="app-1" />);
    fireEvent.click(screen.getByText("Cancel and apply manually"));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/runs/run-1/cancel", expect.any(Object)));
  });
});

describe("RunPanel terminal + errors", () => {
  it("failed run shows a retry (with neutral step dots) and the refund note", async () => {
    render(
      <RunPanel
        run={run({
          status: "failed",
          error: "some crash",
          slot_refunded: true,
          steps: [{ at: AT, step: "navigate" }, { at: AT, step: "form_extracted", detail: "3" }]
        })}
        applicationId="app-1"
      />
    );
    expect(screen.getByText(/did not count against your arm runs/)).toBeInTheDocument();
    expect(screen.getByText("Opened the job application")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Retry with a fresh arm"));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/applications/app-1/retry", expect.any(Object)));
  });

  it.each([
    ["captcha_blocked: x", /anti-bot check blocked/],
    ["submit_unconfirmed - x", /never showed a confirmation/],
    ["review_timeout: x", /sat for 7 days/],
    ["form_not_found: x", /couldn't find a real application form/],
    // System failures own up instead of hiding behind "a problem": the Valon
    // incident's error read only as the generic line, which told the user
    // nothing about whose fault it was or whether anything got sent.
    ["render_failed during fill for review: SyntaxError", /on our side.*Nothing was submitted/],
    ["render_unreachable during fill for review", /on our side.*Nothing was submitted/],
    // Mid-submit failures must NOT claim nothing was submitted: the click may
    // have landed before the crash.
    ["render_unreachable during submit", /couldn't confirm whether the application went through/],
    ["weird error", /couldn't recover from/]
  ])("maps error %s to a friendly message", (error, re) => {
    render(<RunPanel run={run({ status: "failed", error })} applicationId="app-1" />);
    expect(screen.getByText(re)).toBeInTheDocument();
  });

  it("canceled run renders the muted status", () => {
    render(<RunPanel run={run({ status: "canceled" })} applicationId="app-1" />);
    expect(screen.getByText("Run canceled")).toBeInTheDocument();
  });

  it("falls back to the raw label for an unrecognized status", () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) }))); // no screenshots key
    render(<RunPanel run={run({ status: "mystery_state" })} applicationId="app-1" />);
    expect(screen.getByText("mystery_state")).toBeInTheDocument();
  });

  it("shows b.error and tolerates a failed screenshots fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/screenshots")
          ? { ok: false, json: async () => ({}) }
          : { ok: false, json: async () => ({ error: "boom" }) }
      )
    );
    render(<RunPanel run={run({ status: "needs_review", answers: [{ name: "p", label: "P", value: "v" }] })} applicationId="app-1" />);
    fireEvent.click(screen.getByText("Approve and submit application"));
    expect(await screen.findByText("boom")).toBeInTheDocument();
  });

  it("falls back to a generic action error when the body is unparseable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/screenshots")
          ? { ok: true, json: async () => ({ screenshots: [] }) }
          : {
              ok: false,
              json: async () => {
                throw new Error("bad json");
              }
            }
      )
    );
    render(<RunPanel run={run({ status: "needs_review", answers: [{ name: "p", label: "P", value: "v" }] })} applicationId="app-1" />);
    fireEvent.click(screen.getByText("Approve and submit application"));
    expect(await screen.findByText("Action failed.")).toBeInTheDocument();
  });
});

describe("RunPanel steps, screenshots, submitted answers", () => {
  it("translates the full step log and shows submitted answers + screenshots", async () => {
    stubFetch([{ path: "p1", url: "https://s/1" }]);
    render(
      <RunPanel
        run={run({
          status: "submitted",
          answers: [
            { name: "a", label: "A", value: "yes" },
            { name: "b", label: "B", value: "", skipped: true },
            { name: "c", label: "", value: "" }
          ],
          steps: [
            { at: AT, step: "navigate" },
            { at: AT, step: "form_extracted", detail: "5" },
            { at: AT, step: "form_extracted", detail: "1" },
            { at: AT, step: "form_extracted", detail: "x" },
            { at: AT, step: "form_extracted" },
            { at: AT, step: "answers_generated" },
            { at: AT, step: "recovery_vision" },
            { at: AT, step: "recovery_playbook" },
            { at: AT, step: "form_not_found" },
            { at: AT, step: "answers_generated", detail: "3" },
            { at: AT, step: "answers_generated", detail: "1" },
            { at: AT, step: "review_requested" },
            { at: AT, step: "approved" },
            { at: AT, step: "submitted" },
            { at: AT, step: "submit_unconfirmed" },
            { at: AT, step: "captcha_blocked" },
            { at: AT, step: "mystery_internal" }
          ]
        })}
        applicationId="app-1"
      />
    );
    expect(screen.getByText("Read the form: 5 questions")).toBeInTheDocument();
    expect(screen.getByText("Read the form: 1 question")).toBeInTheDocument();
    expect(screen.getAllByText("Read the application form").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Drafted your answers").length).toBeGreaterThan(0);
    expect(screen.getByText(/What your arm submitted/)).toBeInTheDocument();
    await screen.findByText(/Screenshots from the arm/);
  });
});

describe("RunPanel polling", () => {
  it("ignores a screenshots fetch that rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    render(<RunPanel run={run({ status: "failed", error: "x" })} applicationId="app-1" />);
    expect(await screen.findByText("Retry with a fresh arm")).toBeInTheDocument();
  });

  it("polls for updates while the arm is working", async () => {
    vi.useFakeTimers();
    render(<RunPanel run={run({ status: "running" })} applicationId="app-1" />);
    await vi.advanceTimersByTimeAsync(5000);
    expect(router.refresh).toHaveBeenCalled();
    expect(screen.getByText(/Your arm is working/)).toBeInTheDocument();
  });
});

describe("answers the form did not accept", () => {
  const mismatch = {
    name: "q[]",
    label: "Sanctions",
    expected: "None of the above",
    actual: "Ordinarily a resident of Cuba"
  };

  it("marks the exact field, so nobody hunts for it in a screenshot", () => {
    stubFetch();
    render(
      <RunPanel
        run={run({
          status: "needs_review",
          answers: [
            { name: "q[]", label: "Sanctions", value: "None of the above" },
            { name: "email", label: "Email", value: "a@b.com" }
          ],
          fill_mismatches: [mismatch]
        })}
        applicationId="app-1"
      />
    );

    expect(screen.getByText(/the form shows Ordinarily a resident of Cuba/)).toBeInTheDocument();
    expect(screen.getByText(/found an answer the form did not accept/)).toBeInTheDocument();
  });

  it("tells a full-auto user why their arm stopped at all", () => {
    // They chose not to be asked, so a review request needs to explain itself.
    stubFetch();
    render(
      <RunPanel
        run={run({
          status: "needs_review",
          autonomy: "full_auto",
          answers: [{ name: "q[]", label: "Sanctions", value: "None of the above" }],
          fill_mismatches: [mismatch]
        })}
        applicationId="app-1"
      />
    );
    expect(screen.getByText(/normally submits without asking/)).toBeInTheDocument();
  });

  it("counts them when several disagree", () => {
    stubFetch();
    render(
      <RunPanel
        run={run({
          status: "needs_review",
          answers: [
            { name: "q[]", label: "Sanctions", value: "None of the above" },
            { name: "b[]", label: "Other", value: "Yes" }
          ],
          fill_mismatches: [mismatch, { ...mismatch, name: "b[]", label: "Other" }]
        })}
        applicationId="app-1"
      />
    );
    expect(screen.getByText(/found 2 answers the form did not accept/)).toBeInTheDocument();
  });

  it("says nothing when the read-back agreed", () => {
    stubFetch();
    render(
      <RunPanel
        run={run({
          status: "needs_review",
          answers: [{ name: "q[]", label: "Sanctions", value: "None of the above" }],
          fill_mismatches: []
        })}
        applicationId="app-1"
      />
    );
    expect(screen.queryByText(/did not accept/)).not.toBeInTheDocument();
  });

  it("explains a run that refused to submit", () => {
    stubFetch();
    render(
      <RunPanel
        run={run({
          status: "failed",
          error: "verification_failed: the form did not accept your answer for Sanctions"
        })}
        applicationId="app-1"
      />
    );
    expect(screen.getByText(/refused to submit rather than send a wrong answer/)).toBeInTheDocument();
  });

  it("translates the fill_mismatch and resume steps for humans", () => {
    stubFetch();
    render(
      <RunPanel
        run={run({
          status: "needs_review",
          answers: [{ name: "p", label: "P", value: "v" }],
          steps: [
            { at: AT, step: "fill_mismatch", detail: "Sanctions" },
            { at: AT, step: "resume_not_attached" }
          ]
        })}
        applicationId="app-1"
      />
    );
    expect(screen.getByText(/the form disagreed on Sanctions/)).toBeInTheDocument();
    expect(screen.getByText(/Couldn't attach your resume/)).toBeInTheDocument();
  });

  it("falls back when a fill_mismatch step names no fields", () => {
    stubFetch();
    render(
      <RunPanel
        run={run({
          status: "needs_review",
          answers: [{ name: "p", label: "P", value: "v" }],
          steps: [{ at: AT, step: "fill_mismatch" }]
        })}
        applicationId="app-1"
      />
    );
    expect(screen.getByText(/the form disagreed on some answers/)).toBeInTheDocument();
  });
});

describe("RunPanel LinkedIn login code", () => {
  it("prompts for the PIN and submits it, once it is long enough", async () => {
    stubFetch();
    render(
      <RunPanel
        run={run({
          status: "needs_login_code",
          steps: [{ at: AT, step: "login_code_pending" }, { at: AT, step: "account_verified" }]
        })}
        applicationId="app-1"
      />
    );

    expect(screen.getByText("Enter your LinkedIn code")).toBeInTheDocument();
    expect(screen.getByText(/LinkedIn asked for a verification code/)).toBeInTheDocument();

    const submit = screen.getByText("Submit code");
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText("LinkedIn verification code"), {
      target: { value: "483920" }
    });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(fetch).toHaveBeenCalledWith(
      "/api/runs/run-1/login-code",
      expect.objectContaining({ method: "POST" })
    );
    const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].endsWith("/login-code")
    );
    expect(JSON.parse(call![1].body)).toEqual({ code: "483920" });
  });

  it("can be canceled while waiting for the code", async () => {
    stubFetch();
    render(<RunPanel run={run({ status: "needs_login_code" })} applicationId="app-1" />);
    fireEvent.click(screen.getByText("Cancel this run"));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/api/runs/run-1/cancel", expect.any(Object))
    );
  });

  it("shows the working label while confirming an account email", () => {
    stubFetch();
    render(<RunPanel run={run({ status: "needs_account_verification" })} applicationId="app-1" />);
    expect(screen.getByText(/Confirming your application email/)).toBeInTheDocument();
  });

  it("polls while parked on a login code", async () => {
    vi.useFakeTimers();
    render(<RunPanel run={run({ status: "needs_login_code" })} applicationId="app-1" />);
    await vi.advanceTimersByTimeAsync(5000);
    expect(router.refresh).toHaveBeenCalled();
  });
});
