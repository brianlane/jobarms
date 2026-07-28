/**
 * Matching between a drafted group answer and a choice field's options,
 * MIRRORING the sidecar's field-match.ts (splitAnswerValues +
 * checkboxLabelMatches). The review screen must read a draft the same way the
 * filler will apply it: exact-only matching rendered a draft with minor
 * wording drift as "nothing selected" and invited edits that rewrote a
 * working answer.
 */

/** Split a group answer into individual option values ("a; b" -> ["a","b"]). */
export function splitAnswerValues(value: string): string[] {
  return value
    .split(/[;,]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

const norm = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, " ");

/**
 * Does a concrete option label match any of the wanted answer values? Exact
 * match first; then containment either way so minor wording drift still
 * matches, guarded by a minimum length so short tokens ("No") cannot
 * substring-match longer unrelated options ("None of the above").
 */
export function checkboxLabelMatches(optionLabel: string, wanted: string[]): boolean {
  const label = norm(optionLabel);
  if (!label) return false;
  return wanted.some((raw) => {
    const w = norm(raw);
    if (!w) return false;
    if (w === label) return true;
    if (w.length >= 4 && label.includes(w)) return true;
    if (label.length >= 4 && w.includes(label)) return true;
    return false;
  });
}

/**
 * Split a draft into the options it selects and the tokens matching none.
 * The extras ride along untouched: an off-menu token the filler might still
 * place is the user's to keep or delete, never the UI's to silently drop.
 */
export function partitionGroupAnswer(
  value: string,
  options: string[]
): { selected: Set<string>; extras: string[] } {
  const selected = new Set<string>();
  const extras: string[] = [];
  for (const token of splitAnswerValues(value)) {
    const match = options.find((option) => checkboxLabelMatches(option, [token]));
    if (match) selected.add(match);
    else extras.push(token);
  }
  return { selected, extras };
}

/** Toggle one option in a draft, preserving tokens that match no option. */
export function toggleGroupOption(value: string, options: string[], option: string): string {
  const { selected, extras } = partitionGroupAnswer(value, options);
  if (selected.has(option)) selected.delete(option);
  else selected.add(option);
  return [...options.filter((o) => selected.has(o)), ...extras].join("; ");
}
