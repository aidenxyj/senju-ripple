#!/usr/bin/env bash
# Give the autoresearch loop its own copy of the repo, so it never touches the shared checkout
# (other agents' branches, app/skills/, the ledger in main's tree).
#
#   evals/research/sandbox.sh <task-id> [dir]
#
# Creates (or reuses) a git worktree at [dir] (default: ../ripple-research-<task-id>, next to this repo)
# on branch research/<task-id>, started from origin/main. Links app/node_modules and .env from
# this checkout, so nothing is installed twice and no key is copied. Prints the worktree path.
# The loop's skill edits, ledger rows and commits then live only on research/<task-id>; ship the
# trained skill later with a PR of evals/skills/<task-id>/ (or --export --to <the app's skills dir>).
set -euo pipefail
task="${1:?usage: evals/research/sandbox.sh <task-id> [dir]}"
src="$(git rev-parse --show-toplevel)"
main="$(git -C "$src" worktree list --porcelain | awk 'NR==1{print $2}')"   # the primary checkout has node_modules and .env
dir="${2:-$(dirname "$main")/ripple-research-$task}"
branch="research/$task"

if [ ! -d "$dir" ]; then
  git -C "$src" fetch -q origin main
  if git -C "$src" show-ref -q --verify "refs/heads/$branch"; then
    git -C "$src" worktree add -q "$dir" "$branch"
  else
    git -C "$src" worktree add -q -b "$branch" "$dir" origin/main
  fi
fi
[ -e "$dir/app/node_modules" ] || ln -s "$main/app/node_modules" "$dir/app/node_modules"
[ -e "$dir/.env" ] || { [ -f "$main/.env" ] && ln -s "$main/.env" "$dir/.env"; } || true
echo "$dir"
