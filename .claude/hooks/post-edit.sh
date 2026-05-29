#!/bin/bash
set -e

# Read file_path from stdin (jq format from Claude Code)
file_path=$(jq -r '.file_path // empty' 2>/dev/null) || exit 0
[[ -z "$file_path" ]] && exit 0

# Determine project root
project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

# Make path absolute if needed
if [[ "$file_path" != /* ]]; then
  file_path="$project_root/$file_path"
fi

# Exclude node_modules, interchange/, and hidden files
if [[ "$file_path" == */node_modules/* ]] || \
   [[ "$file_path" == */interchange/* ]] || \
   [[ "$file_path" == */.*/* ]] || \
   [[ "$(basename "$file_path")" == .* ]]; then
  exit 0
fi

# Supported extensions for oxfmt
if [[ "$file_path" =~ \.(ts|tsx|js|jsx|mjs|cjs|json|css|html)$ ]]; then
  oxfmt --write "$file_path" 2>/dev/null || true
fi

# Supported extensions for oxlint (JS/TS only)
if [[ "$file_path" =~ \.(ts|tsx|js|jsx|mjs|cjs)$ ]]; then
  oxlint --fix --quiet "$file_path" 2>/dev/null || true
fi

exit 0
