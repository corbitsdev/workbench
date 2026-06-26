#!/usr/bin/env bash
#
# check-vendored-drift.sh — manual pin-bump aid (NOT a CI gate).
#
# The four vendored sidecar files below are copied from interchange's reference
# `apps/sidecar` but carry WORKBENCH-LOCAL divergences (see the "Vendored
# workflow-host wiring (pin-bump gate)" section of AGENTS.md). A literal upstream
# re-sync can silently DROP a workbench-local line and still produce a green
# build (this is the CL-2361 / #364 failure mode).
#
# This script surfaces, for each vendored file, every line present in the PRIOR
# workbench version but ABSENT from the NEW (candidate) version — the dropped
# lines an operator must review before accepting a pin bump.
#
# Usage:
#   scripts/check-vendored-drift.sh <prior-workbench-ref> [candidate-ref]
#
#   <prior-workbench-ref>  git ref holding the known-good workbench vendored files
#                          (e.g. origin/staging, or the commit before the bump)
#   [candidate-ref]        git ref to compare against; defaults to the working
#                          tree (after you have re-synced + re-applied locals)
#
# Examples:
#   # compare working tree against last known-good staging:
#   scripts/check-vendored-drift.sh origin/staging
#   # compare two commits:
#   scripts/check-vendored-drift.sh origin/staging HEAD
#
# Read every reported line and confirm each is an INTENTIONAL upstream removal,
# not a dropped WORKBENCH-LOCAL block. Pay special attention to lines containing
# `WORKBENCH-LOCAL`, `TENANT_ID`, or `WORKFLOW_RAW_DEPLOYMENT_ID`.
set -euo pipefail

PRIOR_REF="${1:-}"
CANDIDATE_REF="${2:-}"

if [[ -z "$PRIOR_REF" ]]; then
  echo "usage: $0 <prior-workbench-ref> [candidate-ref]" >&2
  exit 2
fi

FILES=(
  "apps/sidecar/src/workflow-host-wiring.ts"
  "apps/sidecar/src/workflow-substrate-factory.ts"
  "apps/sidecar/src/workflow-run-pack-client.ts"
  "apps/sidecar/bin/workflow-child"
)

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

found_drift=0

for f in "${FILES[@]}"; do
  prior="$(mktemp)"
  candidate="$(mktemp)"
  trap 'rm -f "$prior" "$candidate"' RETURN

  if ! git show "${PRIOR_REF}:${f}" >"$prior" 2>/dev/null; then
    echo "WARNING: ${f} not found at ${PRIOR_REF}; skipping" >&2
    continue
  fi

  if [[ -n "$CANDIDATE_REF" ]]; then
    if ! git show "${CANDIDATE_REF}:${f}" >"$candidate" 2>/dev/null; then
      echo "WARNING: ${f} not found at ${CANDIDATE_REF}; skipping" >&2
      continue
    fi
  else
    if [[ ! -f "$f" ]]; then
      echo "WARNING: ${f} missing in working tree; skipping" >&2
      continue
    fi
    cp "$f" "$candidate"
  fi

  # Lines present in prior but absent (anywhere) in candidate.
  dropped="$(grep -Fxv -f "$candidate" "$prior" | grep -vE '^[[:space:]]*$' || true)"

  if [[ -n "$dropped" ]]; then
    found_drift=1
    echo "================================================================"
    echo "DROPPED lines in ${f}"
    echo "  (present at ${PRIOR_REF}, absent in ${CANDIDATE_REF:-working tree})"
    echo "================================================================"
    echo "$dropped"
    echo
  fi

  rm -f "$prior" "$candidate"
done

if [[ "$found_drift" -eq 0 ]]; then
  echo "No dropped lines detected across vendored files."
fi

echo
echo "Review each dropped line above: confirm it is an intentional upstream"
echo "removal, NOT a dropped WORKBENCH-LOCAL block. This script does not gate;"
echo "it is an aid for the manual pin-bump re-sync described in AGENTS.md."
