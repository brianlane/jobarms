#!/usr/bin/env bash
# deploy-gate.sh - hold the gated job (the Vercel preview deploy) until EVERY
# other signal on the PR is green, then let it run. (Ported from the
# newcoworker e2e-gate.)
#
# Why this exists: `needs:` can only gate on jobs in the same workflow file,
# but the repo's merge bar spans other workflows (CodeQL's Analyze, Dependency
# Audit) and GitHub Apps, plus "every review thread resolved", which is not a
# check at all. This script polls the check-runs API, the commit-status API,
# and the reviewThreads GraphQL until all of them pass:
#
#   - every check run must complete with conclusion "success". NEUTRAL is
#     NOT a pass; review apps commonly sit neutral exactly when they have
#     open findings.
#   - every commit status context must be "success".
#   - zero unresolved review threads. Unlike a pending check, a thread can
#     never resolve itself, so this fails IMMEDIATELY instead of polling out
#     the whole timeout on a wait that cannot succeed. Resolve the threads,
#     then re-run this job.
#
# Hard failures (failure / cancelled / timed_out / action_required / error /
# skipped / unresolved threads) exit immediately; pending or neutral states
# poll until GATE_TIMEOUT_MINS, then fail with a summary. "Re-run failed
# jobs" picks the gate back up after a human resolves the blocker.
#
# Expected env: GH_TOKEN, REPO ("owner/name"), SHA, PR (number).
set -euo pipefail

# The gate must never wait on any job that is ITSELF behind or after this
# gate: "Vercel Deploy" runs the gate before deploying, and the workers
# deploys run only on main. The dependabot automation jobs (labeler +
# auto-merge evaluator) skip BY DESIGN on non-dependabot PRs; their check
# runs are plumbing, not merge signals.
EXCLUDED_CHECKS='["Vercel Deploy", "Workers Deploy (apply-arm)", "Workers Deploy (ingest)", "label-dependabot", "auto-merge"]'

GATE_TIMEOUT_MINS="${GATE_TIMEOUT_MINS:-20}"
POLL_SECONDS="${POLL_SECONDS:-30}"

deadline=$(( $(date +%s) + GATE_TIMEOUT_MINS * 60 ))
attempt=0

while true; do
  attempt=$(( attempt + 1 ))
  blockers=""

  # --- Check runs (Actions jobs across ALL workflows + most GitHub Apps) ---
  # filter=latest (the default) returns only the newest attempt per check,
  # so a re-run never trips over its own failed history.
  check_runs=$(gh api "repos/${REPO}/commits/${SHA}/check-runs" --paginate -q '
    .check_runs[] | {name, status, conclusion}' | jq -s '.')
  not_green=$(jq -r --argjson excluded "$EXCLUDED_CHECKS" '
    map(select(.name as $n | $excluded | index($n) | not))
    | map(select(.status != "completed" or .conclusion != "success"))
    | .[] | "\(.name): \(.status)/\(.conclusion // "-")"' <<<"$check_runs")
  # Terminal non-success conclusions fail the gate immediately, including
  # "skipped", which never flips on its own. The one deliberately
  # poll-able non-success state is NEUTRAL (review apps flip to SUCCESS in
  # place once their findings are resolved).
  hard_failed=$(jq -r --argjson excluded "$EXCLUDED_CHECKS" '
    map(select(.name as $n | $excluded | index($n) | not))
    | map(select(.conclusion as $c
        | ["failure", "cancelled", "timed_out", "action_required", "skipped"] | index($c)))
    | .[] | .name' <<<"$check_runs")
  if [ -n "$hard_failed" ]; then
    echo "::error::deploy gate: check(s) failed - $(tr '\n' ' ' <<<"$hard_failed")"
    exit 1
  fi
  [ -n "$not_green" ] && blockers+="checks not green:"$'\n'"$not_green"$'\n'

  # --- Commit statuses (legacy status API - some apps report here) ---
  statuses=$(gh api "repos/${REPO}/commits/${SHA}/status" -q '
    .statuses | map({context, state}) | unique_by(.context)')
  status_failed=$(jq -r '
    map(select(.state == "failure" or .state == "error")) | .[] | .context' <<<"$statuses")
  if [ -n "$status_failed" ]; then
    echo "::error::deploy gate: commit status(es) failed - $(tr '\n' ' ' <<<"$status_failed")"
    exit 1
  fi
  status_pending=$(jq -r '
    map(select(.state != "success")) | .[] | "\(.context): \(.state)"' <<<"$statuses")
  [ -n "$status_pending" ] && blockers+="statuses not green:"$'\n'"$status_pending"$'\n'

  # --- Review threads: every conversation resolved ---
  # Cursor-paginated: a PR can carry more than one page of threads, and an
  # unresolved thread beyond page one must still hold the gate.
  owner="${REPO%%/*}"
  name="${REPO##*/}"
  unresolved=$(gh api graphql --paginate \
    -F owner="$owner" -F name="$name" -F pr="$PR" \
    -f query='query($owner: String!, $name: String!, $pr: Int!, $endCursor: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $pr) {
          reviewThreads(first: 100, after: $endCursor) {
            pageInfo { hasNextPage endCursor }
            nodes { isResolved }
          }
        }
      }
    }' -q '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)] | length' \
    | jq -s 'add // 0')
  if [ "$unresolved" -gt 0 ]; then
    echo "::error::deploy gate: ${unresolved} unresolved review thread(s) - fix/resolve them, then re-run this job (threads cannot self-resolve, so polling would not help)."
    exit 1
  fi

  if [ -z "$blockers" ]; then
    echo "deploy gate: every other check is green and all threads are resolved - gate open."
    exit 0
  fi

  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "::error::deploy gate: timed out after ${GATE_TIMEOUT_MINS}m waiting on:"
    echo "$blockers"
    echo "Fix/resolve the blockers, then re-run this job (no new commit needed unless code must change)."
    exit 1
  fi

  echo "deploy gate poll #${attempt} - still waiting on:"
  echo "$blockers"
  sleep "$POLL_SECONDS"
done
