#!/usr/bin/env bash
# Provision a fresh Ubuntu machine for Forge Engine, build it, then optionally start the demo.
# Usage: bash scripts/setup-ubuntu.sh [--no-demo] [--browser]
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
NO_DEMO=0
BROWSER=0
for arg in "$@"; do
  case "$arg" in
    --no-demo) NO_DEMO=1 ;;
    --browser) BROWSER=1 ;;
    -h|--help)
      echo "Usage: bash scripts/setup-ubuntu.sh [--no-demo] [--browser]"
      echo "  --no-demo  provision and build, but do not start the Vite demo"
      echo "  --browser  also require headless Chromium/WebGPU test dependencies"
      exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [[ ! -r /etc/os-release ]] || ! . /etc/os-release || [[ "${ID:-}" != ubuntu ]]; then
  echo "This script supports Ubuntu only." >&2
  exit 1
fi

if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then SUDO=(); else SUDO=(sudo); fi
if ! command -v apt-get >/dev/null; then echo "apt-get is required." >&2; exit 1; fi

printf '\n==> Installing base Ubuntu tools\n'
"${SUDO[@]}" apt-get update
"${SUDO[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates curl git build-essential python3 xz-utils

# Ubuntu's packaged Node can be below the engine's >=20.11 requirement. Install Node 22 via nvm
# for this user (no sudo), unless a sufficiently recent Node is already available.
node_ok=0
if command -v node >/dev/null 2>&1; then
  node_version="$(node -p 'process.versions.node')"
  if [[ "$(printf '%s\n' 20.11.0 "$node_version" | sort -V | head -n1)" == 20.11.0 ]]; then
    node_ok=1
  fi
fi
if (( ! node_ok )); then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
    printf '\n==> Installing nvm\n'
    mkdir -p "$NVM_DIR"
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  fi
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
  nvm install 22
  nvm use 22
else
  echo "Using existing Node.js v${node_version}."
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js/npm are not available in this shell. Open a new shell and rerun this script." >&2
  exit 1
fi
printf '\n==> Installing locked npm dependencies and optional browser prerequisites\n'
if (( BROWSER )); then
  bash scripts/setup-deps.sh --browser
else
  bash scripts/setup-deps.sh
fi

printf '\n==> Building Forge Engine and editor\n'
npm run build
printf '\nBuild complete.\n'
if (( ! NO_DEMO )); then
  printf '\n==> Starting the Forge demo at http://localhost:5173\n'
  printf 'Press Ctrl+C to stop. For remote access, use http://<machine-ip>:5173\n'
  npm run demo
else
  printf '\nStart the demo later with: npm run demo\n'
fi
