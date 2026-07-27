# Review notes for this repository

Conventions and already-investigated behaviour, so review effort goes to real
defects rather than re-litigating settled ones.

## Verified non-issues

**Git pathspecs like `src/**/*.tsx` do match nested paths.** Git's default
pathspec matching does not set `FNM_PATHNAME`, so `*` matches `/` as well.
Verified in this repo: `git grep -- 'src/**/*.tsx'` matches all 48 tracked TSX
files, including seven-level paths such as
`src/app/admin/(protected)/users/[id]/page.tsx`. The "No Gemini in user-facing
files" gate is not skipping deep App Router pages.

**`jq` reads a stream of JSON values, not a single one.** Several workflows pipe
`gh api --paginate --jq '...'` output, which is one JSON object per line, into a
further `jq` filter. That is correct: `jq` processes each value in the stream in
turn. It is not a parse error and later lines are not dropped. Verified directly
against a multi-object stream. Slurping with `jq -s` is used where an aggregate
across the whole stream is needed, which is a different requirement.

## Conventions

**The deploy and merge gates all enforce the same three things** and should stay
in step with each other: a required workflow must have started, must have
finished, and must have concluded success, neutral, or skipped. Judging only two
of the three has caused real gaps. See `.github/scripts/deploy-gate.sh`,
`.github/scripts/security-gate.sh`, and the evaluator in
`.github/workflows/dependabot-automerge.yml`.

**Only the newest run counts.** GitHub keeps the old check run and the old
workflow run when something is re-run, so gates take the latest per name.
Counting every historical run lets one re-run flake block a PR permanently.

**Debug scripts defer to production logic** rather than reimplementing it.
`debug/` has twice drifted from `src/` and driven the wrong behaviour against
live pages. Import from `src/lib/` instead of copying the rule.

**Host matching uses an explicit label boundary,** never a bare `endsWith` on a
hostname, so `evilexample.com` cannot match `example.com`. See `detectAts` in
`src/lib/ats.ts`.

**Coverage is gated at 100%** for `src/**` in `vitest.config.ts`. New logic in
that scope lands with its tests.
