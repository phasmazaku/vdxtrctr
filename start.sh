#!/usr/bin/env sh
# One-command launcher (macOS / Linux / Git Bash). Usage: ./start.sh [--tools] [--dev] [--no-open]
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js is not installed. Get version 20+ from https://nodejs.org"; exit 1; }
exec node run.js "$@"
