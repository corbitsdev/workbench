#!/usr/bin/env bash
# Build all four service images exactly as Railway does.
#
# Railway builds each service from a *git snapshot* of the repo (context = repo
# root, -f apps/<svc>/Dockerfile). By default this script mirrors that by
# building from a clean `git worktree` at HEAD, so untracked working-tree files
# cannot mask drift (e.g. a stale empty package dir that hides a bad COPY).
#
# Usage:
#   scripts/docker-build-all.sh              # faithful: clean worktree at HEAD
#   scripts/docker-build-all.sh --dirty      # fast: build from current tree
#   scripts/docker-build-all.sh hub sidecar  # build a subset
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ALL_SERVICES=(hub sidecar web)
DIRTY=0
SERVICES=()

for arg in "$@"; do
  case "$arg" in
    --dirty) DIRTY=1 ;;
    hub|sidecar|web) SERVICES+=("$arg") ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done
[ ${#SERVICES[@]} -eq 0 ] && SERVICES=("${ALL_SERVICES[@]}")

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is not running. Start Docker Desktop and retry." >&2
  exit 1
fi

build_ctx="$REPO_ROOT"
cleanup() { :; }

if [ "$DIRTY" -eq 0 ]; then
  WORKTREE="$(mktemp -d "${TMPDIR:-/tmp}/wb-docker-build.XXXXXX")"
  cleanup() { git -C "$REPO_ROOT" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || rm -rf "$WORKTREE"; }
  trap cleanup EXIT
  echo "==> Creating clean worktree at HEAD: $WORKTREE"
  git -C "$REPO_ROOT" worktree add --detach "$WORKTREE" HEAD >/dev/null
  echo "==> Syncing interchange submodule to pin"
  git -C "$WORKTREE" submodule update --init interchange >/dev/null
  build_ctx="$WORKTREE"
else
  echo "==> --dirty: building from current working tree (may mask snapshot-only failures)"
fi

failed=()
for svc in "${SERVICES[@]}"; do
  echo ""
  echo "========================================================"
  echo "==> Building $svc  (docker build -f apps/$svc/Dockerfile)"
  echo "========================================================"
  if docker build -f "$build_ctx/apps/$svc/Dockerfile" -t "wb-$svc" "$build_ctx"; then
    echo "==> OK: wb-$svc"
  else
    echo "==> FAILED: $svc" >&2
    failed+=("$svc")
  fi
done

echo ""
if [ ${#failed[@]} -ne 0 ]; then
  echo "BUILD FAILED: ${failed[*]}" >&2
  exit 1
fi
echo "All images built: ${SERVICES[*]}"
