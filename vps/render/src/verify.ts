/**
 * Checking the arm's own work: does the form hold what the user approved?
 *
 * Nothing compared intention to reality before this, which is how a sanctions
 * question ended up ticked "Ordinarily a resident of Cuba, Iran, North Korea,
 * Syria..." on a run whose approved answer said "None of the above". The answers
 * were right and the fill was wrong, and every layer reported success.
 *
 * The comparison is deliberately UNEVEN, because the two halves have different
 * costs of being wrong:
 *
 *  - Choice fields are checked STRICTLY, as set equality. A wrong tick is a
 *    factual misstatement made on the user's behalf, and the checked set is
 *    unambiguous, so there is no reason to be lenient.
 *  - Text and dropdowns are only flagged when they came back EMPTY on a field we
 *    answered. Forms legitimately rewrite what you type: a location autocomplete
 *    turned "Phoenix, Arizona" into "Phoenix, Arizona, United States", and a
 *    phone field reformats. Comparing those strictly would cry wolf on healthy
 *    runs, and a warning that is usually noise is a warning people learn to
 *    click past, which would cost more than it saves.
 *  - Files are not compared here at all; `attachResume` already confirms the
 *    upload against the widget and reports its own outcome.
 */
import type { FilledState } from "./extract.js";
import { checkboxLabelMatches, splitAnswerValues } from "./field-match.js";
import type { Answer, Mismatch } from "./types.js";

/** Answers phrased as a boolean for a lone consent box. */
const TRUTHY = /^(true|yes|checked|on|1)$/i;

/** Does every wanted option appear among the ticked ones, and nothing else? */
function choiceAgrees(wanted: string[], checked: string[]): boolean {
  const everyWantedIsTicked = wanted.every((w) => checked.some((c) => checkboxLabelMatches(c, [w])));
  // The other direction is what catches the dangerous case: a box we never asked
  // for, ticked on our behalf.
  const everyTickIsWanted = checked.every((c) => checkboxLabelMatches(c, wanted));
  return everyWantedIsTicked && everyTickIsWanted;
}

function describe(values: string[]): string {
  return values.length > 0 ? values.join("; ") : "(nothing)";
}

export interface FillCheck {
  /** Answers this read-back disagreed with. */
  mismatches: Mismatch[];
  /**
   * Answers this read-back could actually SEE, whether they agreed or not.
   *
   * Needed because a wizard is checked page by page: a field that could not be
   * driven on one page and was driven correctly on the next must stop counting as
   * a problem, and only "I looked at this field" distinguishes a field that is now
   * fine from one this page simply never showed.
   */
  seen: string[];
}

/**
 * Compare the answers to what the form holds, reporting both the disagreements
 * and which answers were visible enough to judge.
 */
export function checkAnswers(answers: Answer[], state: FilledState[]): FillCheck {
  const byName = new Map(state.map((entry) => [entry.name, entry]));
  const mismatches: Mismatch[] = [];
  const seen: string[] = [];

  for (const answer of answers) {
    if (answer.skipped || answer.value.trim() === "") continue;
    const found = byName.get(answer.name);
    // Unreadable is not the same as wrong: a later wizard page, or a control the
    // reader could not name, must not be reported as a disagreement.
    if (!found || found.kind === "file") continue;
    seen.push(answer.name);

    if (found.kind === "choice") {
      const agrees =
        found.count <= 1
          ? TRUTHY.test(answer.value.trim()) === found.checked.length > 0
          : choiceAgrees(splitAnswerValues(answer.value), found.checked);
      if (!agrees) {
        mismatches.push({
          name: answer.name,
          label: answer.label,
          kind: "choice",
          expected: answer.value,
          actual: describe(found.checked)
        });
      }
      continue;
    }

    if (found.value === "") {
      mismatches.push({
        name: answer.name,
        label: answer.label,
        kind: "text",
        expected: answer.value,
        actual: "(empty)"
      });
    }
  }

  return { mismatches, seen };
}

/**
 * Is this bad enough to refuse to submit?
 *
 * Only a choice field, and only because being wrong there is a statement of fact
 * rather than a blank. An empty text field is visible to a human reviewing the
 * screenshot and, at worst, gets rejected by the employer's own validation; a
 * wrongly ticked compliance box is neither.
 *
 * Decided from the mismatches ALONE. An earlier version asked the live page which
 * fields were choices, which quietly stopped working on a wizard: by submit time
 * the earlier pages are out of the DOM, so every mismatch found before the last
 * page looked like a text field and sailed through.
 */
export function blocksSubmit(mismatches: Mismatch[]): boolean {
  return mismatches.some((mismatch) => mismatch.kind === "choice");
}
