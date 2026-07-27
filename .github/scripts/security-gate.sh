#!/usr/bin/env bash
# Push-to-main gate for the security analyses that live in their own
# workflows.
#
# On a pull request `deploy-gate.sh` waits for every other check, so CodeQL and
# the dependency audits are covered. A push to main has no PR to gate against
# and skipped that wait entirely, so `vercel-deploy` only depended on the jobs
# inside ci.yml. CodeQL and the audit workflows run on the same commit but in
# separate workflows, and they routinely finished AFTER production had already
# deployed, which meant a high-severity finding could be reported against a
# commit that was live.
#
# This waits for exactly those out-of-workflow checks to conclude, and fails
# if any of them did not pass. Checks from ci.yml are already handled by
# `needs:` and are deliberately not matched here, since waiting on the job
# that runs this script would deadlock.
set -euo pipefail

: "${REPO:?REPO is required}"
: "${SHA:?SHA is required}"

# CodeQL reports as "CodeQL" and "Analyze"; audit.yml reports one check per
# workspace, all prefixed "npm audit".
PATTERN='^(CodeQL|Analyze|npm audit)'
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-900}"
POLL_SECONDS="${POLL_SECONDS:-15}"
DEADLINE=$(( $(date +%s) + TIMEOUT_SECONDS ))

while :; do
  RUNS=$(gh api "repos/$REPO/commits/$SHA/check-runs?per_page=100" \
    --jq "[.check_runs[] | select(.name | test(\"$PATTERN\")) | {name: .name, status: .status, conclusion: .conclusion}]")

  TOTAL=$(echo "$RUNS" | jq 'length')
  PENDING=$(echo "$RUNS" | jq '[.[] | select(.status != "completed")] | length')
  # neutral and skipped are passes: a check that had nothing to do has not
  # found a problem.
  FAILED=$(echo "$RUNS" | jq -r '[.[] | select(.status == "completed" and (.conclusion | IN("success","neutral","skipped") | not))] | map(.name) | join(", ")')

  if [ -n "$FAILED" ]; then
    echo "::error::Security analyses failed on this commit: $FAILED. Not deploying."
    exit 1
  fi

  if [ "$TOTAL" -gt 0 ] && [ "$PENDING" -eq 0 ]; then
    echo "All $TOTAL security check(s) passed on $SHA."
    exit 0
  fi

  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    echo "::error::Timed out after ${TIMEOUT_SECONDS}s waiting for security analyses on $SHA (found $TOTAL, $PENDING still running). Refusing to deploy without them."
    exit 1
  fi

  echo "Waiting on security analyses: $TOTAL found, $PENDING still running."
  sleep "$POLL_SECONDS"
done
