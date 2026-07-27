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
# This waits on WORKFLOW RUNS rather than check runs, by name. Waiting on
# check runs meant a matrix leg that had not registered its check yet was
# simply invisible: "some checks exist and none are pending" was satisfied by
# whichever legs happened to appear first, and the deploy went ahead while the
# rest were still queued. A workflow run covers every job inside it, including
# every matrix leg, so requiring the named runs to exist and conclude closes
# that hole.
set -euo pipefail

: "${REPO:?REPO is required}"
: "${SHA:?SHA is required}"

# Must match the `name:` of each workflow, not the job or check names.
REQUIRED_WORKFLOWS=("CodeQL" "Dependency Audit")
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-1200}"
POLL_SECONDS="${POLL_SECONDS:-15}"
DEADLINE=$(( $(date +%s) + TIMEOUT_SECONDS ))

while :; do
  # --paginate emits one object per line, so slurp into a single array before
  # filtering. Every run for this commit, no per_page ceiling to fall off.
  RUNS=$(gh api --paginate "repos/$REPO/actions/runs?head_sha=$SHA&per_page=100" \
    --jq '.workflow_runs[] | {id: .id, name: .name, status: .status, conclusion: .conclusion}' \
    | jq -s '.')

  MISSING=()
  RUNNING=()
  FAILED=()

  for wf in "${REQUIRED_WORKFLOWS[@]}"; do
    # Newest run only. Re-running a workflow leaves the old failed run on the
    # same commit, and counting every run would let a failure that has since
    # been re-run green block the deploy forever.
    LATEST=$(echo "$RUNS" | jq -c --arg n "$wf" '[.[] | select(.name == $n)] | sort_by(.id) | last // null')

    if [ "$LATEST" = "null" ]; then
      MISSING+=("$wf")
      continue
    fi
    if [ "$(echo "$LATEST" | jq -r '.status')" != "completed" ]; then
      RUNNING+=("$wf")
      continue
    fi
    # neutral and skipped are passes: a run with nothing to do found nothing.
    case "$(echo "$LATEST" | jq -r '.conclusion // ""')" in
      success|neutral|skipped) ;;
      *) FAILED+=("$wf") ;;
    esac
  done

  if [ ${#FAILED[@]} -gt 0 ]; then
    echo "::error::Security workflows failed on this commit: ${FAILED[*]}. Not deploying."
    exit 1
  fi

  if [ ${#MISSING[@]} -eq 0 ] && [ ${#RUNNING[@]} -eq 0 ]; then
    echo "All required security workflows passed on $SHA: ${REQUIRED_WORKFLOWS[*]}"
    exit 0
  fi

  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    echo "::error::Timed out after ${TIMEOUT_SECONDS}s waiting for security workflows on $SHA. Never started: ${MISSING[*]:-none}. Still running: ${RUNNING[*]:-none}. Refusing to deploy without them."
    exit 1
  fi

  echo "Waiting on security workflows. Not started: ${MISSING[*]:-none}. Running: ${RUNNING[*]:-none}."
  sleep "$POLL_SECONDS"
done
