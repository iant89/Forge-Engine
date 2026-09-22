#!/usr/bin/env bash
#
# scripts/setup-deps.sh — install (or verify) everything needed to build and test Forge.
#
# Idempotent: every dependency is probed first, and only installed when it is missing or at the
# wrong version. Re-running on a healthy checkout does nothing but print a status table.
#
# What it covers, in order:
#   1. Node.js       — must satisfy `engines.node` in package.json (the one source of truth).
#   2. npm           — ships with Node; must understand lockfileVersion 3 (npm >= 7).
#   3. git           — required for the workflow (not for the build itself).
#   4. npm packages  — every devDependency's installed version must equal the version pinned in
#                      package-lock.json; otherwise `npm ci` (never `npm install`, so the lockfile
#                      stays authoritative).
#   5. Headless Chromium + SwiftShader (optional, for `npm run check:browser`) — extracted from the
#                      bundled @sparticuz/chromium package into $TMPDIR (where tools/browser-check.mjs
#                      already looks), and its reported version is checked against the package. Falls
#                      back to Playwright's managed Chromium when that CDN is reachable.
#   6. Vulkan loader + software ICD (optional, needs step 5) — `libvulkan1` and Mesa's lavapipe,
#                      because a browser that does not ship its own Vulkan stack gets no adapter
#                      without them. Which ICD the gate will actually use is decided by
#                      tools/gpu-env.mjs: the one bundled beside the browser when there is one
#                      (VK_ICD_FILENAMES/VK_DRIVER_FILES are pointed at it), otherwise the system
#                      loader's own list. This step also writes that environment to
#                      $TMPDIR/forge-gpu-env.sh for launching Chromium by hand.
#
# Usage:
#   scripts/setup-deps.sh              # install what is missing, verify the rest
#   scripts/setup-deps.sh --check      # verify only; exit 1 if anything would be installed
#   scripts/setup-deps.sh --no-browser # skip the headless-browser step (typecheck/test/wgsl only)
#   scripts/setup-deps.sh --browser    # fail (instead of warn) when no browser can be provisioned
#   scripts/setup-deps.sh --verbose    # echo the commands being run
#
# Exit codes: 0 all good, 1 a required dependency is missing/wrong and could not be fixed (or
# --check found drift), 2 bad usage.
#
# Environment:
#   FORGE_NODE_INSTALL=nvm|fnm|none  How to obtain Node when it is missing/too old (default: auto —
#                                    uses whichever of nvm/fnm is already installed; never installs a
#                                    version manager behind your back).
#   PLAYWRIGHT_CHROMIUM=/path        Pre-provisioned Chromium binary; honoured by the checker too.
#   TMPDIR                           Where the @sparticuz/chromium payload is extracted (default /tmp).
#
# Installing packages (step 6) needs root: the script uses sudo when it is available without a
# password prompt, and otherwise reports the exact command to run by hand. It never fails a run for a
# machine that cannot install them — a browser that bundles its own ICD does not need them.

set -euo pipefail

# ------------------------------------------------------------------------------------------ setup

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

MODE="install"          # install | check
BROWSER="auto"          # auto | required | skip
VERBOSE=0

for arg in "$@"; do
  case "$arg" in
    --check) MODE="check" ;;
    --browser) BROWSER="required" ;;
    --no-browser) BROWSER="skip" ;;
    --verbose|-v) VERBOSE=1 ;;
    -h|--help)
      sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown option: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

if [[ -t 1 ]]; then
  C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'; C_OFF=$'\033[0m'
else
  C_OK=""; C_WARN=""; C_ERR=""; C_DIM=""; C_BOLD=""; C_OFF=""
fi

FAILURES=0
WARNINGS=0
CHANGES=0
declare -a SUMMARY=()

ok()      { SUMMARY+=("${C_OK}  ok   ${C_OFF} $1"); }
fixed()   { SUMMARY+=("${C_OK} fixed ${C_OFF} $1"); CHANGES=$((CHANGES + 1)); }
warn()    { SUMMARY+=("${C_WARN} warn  ${C_OFF} $1"); WARNINGS=$((WARNINGS + 1)); }
fail()    { SUMMARY+=("${C_ERR} FAIL  ${C_OFF} $1"); FAILURES=$((FAILURES + 1)); }
step()    { printf '%s==>%s %s\n' "$C_BOLD" "$C_OFF" "$1"; }
detail()  { printf '    %s%s%s\n' "$C_DIM" "$1" "$C_OFF"; }
run()     { [[ $VERBOSE -eq 1 ]] && printf '    $ %s\n' "$*"; "$@"; }
have()    { command -v "$1" >/dev/null 2>&1; }

# In --check mode nothing may be installed; callers use `can_install || return`.
can_install() { [[ $MODE == "install" ]]; }

# Compare dotted versions: returns 0 when $1 >= $2.
version_ge() {
  [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" == "$2" ]]
}

# Read a JSON path from a file without assuming Node is present yet (python3 is on every CI image
# we target; when neither is available fall back to a conservative grep).
json_get() {
  local file="$1" path="$2"
  if have node; then
    node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=process.argv[2].split(".").reduce((a,k)=>a?.[k],o);if(v===undefined)process.exit(1);console.log(typeof v==="string"?v:JSON.stringify(v))' "$file" "$path"
  elif have python3; then
    python3 -c 'import json,sys;o=json.load(open(sys.argv[1]));v=o
for k in sys.argv[2].split("."):
    v=v[k]
print(v if isinstance(v,str) else json.dumps(v))' "$file" "$path"
  else
    grep -o "\"${path##*.}\": *\"[^\"]*\"" "$file" | head -n1 | sed 's/.*: *"\(.*\)"/\1/'
  fi
}

# ------------------------------------------------------------------------------- 1. Node.js

REQUIRED_NODE_RANGE="$(json_get package.json engines.node 2>/dev/null || echo '>=20.11')"
# The manifest uses ">=X.Y"; extract the floor for the comparison and keep the range for messages.
REQUIRED_NODE_MIN="${REQUIRED_NODE_RANGE//[^0-9.]/}"

install_node() {
  local want="$1" how="${FORGE_NODE_INSTALL:-auto}"
  case "$how" in
    none) return 1 ;;
  esac
  # Prefer a version manager the developer already uses; never bootstrap one silently.
  if [[ $how == "auto" || $how == "fnm" ]] && have fnm; then
    detail "installing Node $want with fnm"
    run fnm install "$want" && run fnm use "$want" && return 0
  fi
  if [[ $how == "auto" || $how == "nvm" ]]; then
    local nvm_sh="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    if [[ -s "$nvm_sh" ]]; then
      detail "installing Node $want with nvm"
      # shellcheck disable=SC1090
      set +u; . "$nvm_sh"; set -u
      nvm install "$want" >/dev/null && nvm use "$want" >/dev/null && return 0
    fi
  fi
  return 1
}

step "Node.js (${REQUIRED_NODE_RANGE})"
NODE_OK=0
if have node; then
  NODE_VER="$(node --version | sed 's/^v//')"
  if version_ge "$NODE_VER" "$REQUIRED_NODE_MIN"; then
    ok "node v$NODE_VER satisfies $REQUIRED_NODE_RANGE"
    NODE_OK=1
  else
    detail "found node v$NODE_VER, need $REQUIRED_NODE_RANGE"
    if can_install && install_node "$REQUIRED_NODE_MIN"; then
      NODE_VER="$(node --version | sed 's/^v//')"
      fixed "node upgraded to v$NODE_VER"
      NODE_OK=1
    else
      fail "node v$NODE_VER is too old (need $REQUIRED_NODE_RANGE) — install via nvm/fnm or https://nodejs.org/"
    fi
  fi
else
  detail "node not found on PATH"
  if can_install && install_node "$REQUIRED_NODE_MIN"; then
    NODE_VER="$(node --version | sed 's/^v//')"
    fixed "node v$NODE_VER installed"
    NODE_OK=1
  else
    fail "node is not installed (need $REQUIRED_NODE_RANGE) — install via nvm/fnm or https://nodejs.org/"
  fi
fi

# ----------------------------------------------------------------------------------- 2. npm

step "npm (lockfileVersion $(json_get package-lock.json lockfileVersion 2>/dev/null || echo 3) needs npm >= 7)"
if [[ $NODE_OK -eq 1 ]] && have npm; then
  NPM_VER="$(npm --version)"
  if version_ge "$NPM_VER" "7.0.0"; then
    ok "npm v$NPM_VER"
  else
    fail "npm v$NPM_VER cannot read this lockfile; upgrade with: npm install -g npm@latest"
  fi
elif [[ $NODE_OK -eq 1 ]]; then
  fail "npm not found even though node is present — reinstall Node (npm ships with it)"
else
  detail "skipped (no usable node)"
fi

# ----------------------------------------------------------------------------------- 3. git

step "git"
if have git; then
  ok "git $(git --version | awk '{print $3}')"
else
  warn "git not found — not needed to build, but required to commit/push (apt: git, brew: git)"
fi

# ---------------------------------------------------------------------------- 4. npm packages

# Every devDependency must be present at exactly the version package-lock.json resolved it to.
# Reading node_modules/<pkg>/package.json directly (instead of `npm ls`) keeps this fast and makes
# the "installed vs locked" comparison explicit.
step "npm packages (package-lock.json is authoritative)"
PKG_DRIFT=()
if [[ $NODE_OK -eq 1 ]]; then
  while IFS=$'\t' read -r name locked installed; do
    if [[ "$installed" == "-" ]]; then
      PKG_DRIFT+=("$name: missing (want $locked)")
    elif [[ "$installed" != "$locked" ]]; then
      PKG_DRIFT+=("$name: $installed installed, lock says $locked")
    fi
  done < <(node -e '
    const fs = require("fs");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    for (const name of names) {
      const locked = lock.packages?.["node_modules/" + name]?.version ?? "?";
      let installed = "-";
      try { installed = JSON.parse(fs.readFileSync("node_modules/" + name + "/package.json", "utf8")).version; } catch {}
      process.stdout.write(`${name}\t${locked}\t${installed}\n`);
    }
    // Workspace link: engine/ must be symlinked into node_modules for @forge/engine to resolve.
    const ws = "node_modules/@forge/engine";
    let linked = "-";
    try { if (fs.lstatSync(ws).isSymbolicLink()) linked = "linked"; } catch {}
    process.stdout.write(`@forge/engine (workspace)\tlinked\t${linked}\n`);
  ')

  if [[ ${#PKG_DRIFT[@]} -eq 0 ]]; then
    ok "all locked packages present at the pinned versions"
  else
    for d in "${PKG_DRIFT[@]}"; do detail "$d"; done
    if can_install; then
      detail "running npm ci"
      if run npm ci --no-audit --no-fund --loglevel=error; then
        fixed "npm ci restored node_modules to the lockfile (${#PKG_DRIFT[@]} package(s) were off)"
      else
        fail "npm ci failed — see output above"
      fi
    else
      fail "${#PKG_DRIFT[@]} package(s) differ from package-lock.json (run without --check to fix)"
    fi
  fi
else
  detail "skipped (no usable node)"
fi

# Parse one field out of a JSON document held in a variable (the file-based json_get above reads
# files, and gpu-env.mjs prints to stdout). Prints an empty line for a missing/null field.
json_str_get() {
  local text="$1" path="$2"
  if have node; then
    printf '%s' "$text" | node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        let v;
        try { v = JSON.parse(s); } catch { process.exit(1); }
        for (const key of process.argv[1].split(".")) v = v?.[key];
        if (v === undefined || v === null) { process.stdout.write(""); process.exit(0); }
        process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
      });
    ' "$path" 2>/dev/null || true
  else
    printf '%s' "$text" | sed -n "s/.*\"${path##*.}\": *\(\"[^\"]*\"\|null\).*/\1/p" | head -n1 | sed 's/^"//; s/"$//'
  fi
}

# The full Chromium build Playwright would launch (`channel: "chromium"`), or nothing. Not
# `chromium-headless-shell`, which the gate cannot use: it has no WebGPU.
playwright_browser_path() {
  node -e 'import("playwright-core").then((m) => { try { process.stdout.write(m.chromium.executablePath() ?? ""); } catch {} }).catch(() => {})' 2>/dev/null || true
}

# ------------------------------------------------------- 5. headless Chromium (check:browser)

# tools/browser-check.mjs discovers a browser in this order: $PLAYWRIGHT_CHROMIUM, $TMPDIR/chromium
# (the @sparticuz/chromium payload), then Playwright's managed install. We provision in the same
# order so what this script validates is exactly what the checker will launch.
TMP="${TMPDIR:-/tmp}"
SPARTICUZ_BIN="$TMP/chromium"
SPARTICUZ_LIBS="$TMP/al2023/lib"
SPARTICUZ_ICD="$TMP/vk_swiftshader_icd.json"
GPU_ENV_FILE="$TMP/forge-gpu-env.sh"

chromium_version_of() {
  # Prints "153.0.8010.0" for a launchable binary, or nothing.
  local bin="$1"
  LD_LIBRARY_PATH="$SPARTICUZ_LIBS:$TMP:${LD_LIBRARY_PATH:-}" \
    "$bin" --headless=new --no-sandbox --disable-gpu --version 2>/dev/null | awk '{print $2}' || true
}

provision_sparticuz() {
  # Inflate chromium + swiftshader + fonts, and the NSS/NSPR libs the binary links against (the
  # package only extracts those automatically on Amazon Linux; every other distro needs them too
  # unless libnss3 is installed system-wide).
  node -e '
    (async () => {
      const m = await import("@sparticuz/chromium");
      const bin = "node_modules/@sparticuz/chromium/bin/";
      await m.default.executablePath();
      await m.inflate(bin + "al2023.tar.br");
    })().catch((e) => { console.error(String(e)); process.exit(1); });
  '
}

step "headless Chromium + SwiftShader (npm run check:browser)"
if [[ $BROWSER == "skip" ]]; then
  detail "skipped (--no-browser)"
elif [[ $NODE_OK -ne 1 || ${#PKG_DRIFT[@]} -gt 0 && $MODE == "check" ]]; then
  detail "skipped (packages not in a known-good state)"
else
  BROWSER_READY=0

  # 5a. Explicit override wins.
  if [[ -n "${PLAYWRIGHT_CHROMIUM:-}" ]]; then
    if [[ -x "$PLAYWRIGHT_CHROMIUM" ]] && v="$(chromium_version_of "$PLAYWRIGHT_CHROMIUM")" && [[ -n "$v" ]]; then
      ok "PLAYWRIGHT_CHROMIUM -> Chromium $v"
      BROWSER_READY=1
    else
      fail "PLAYWRIGHT_CHROMIUM=$PLAYWRIGHT_CHROMIUM is not a launchable Chromium"
    fi
  fi

  # 5b. Bundled @sparticuz/chromium payload: verify the extracted binary matches the package major.
  if [[ $BROWSER_READY -eq 0 ]]; then
    WANT_MAJOR="$(json_get node_modules/@sparticuz/chromium/package.json version 2>/dev/null | cut -d. -f1 || true)"
    HAVE_VER="$( [[ -x "$SPARTICUZ_BIN" ]] && chromium_version_of "$SPARTICUZ_BIN" || true )"
    HAVE_MAJOR="${HAVE_VER%%.*}"
    if [[ -n "$HAVE_VER" && -n "$WANT_MAJOR" && "$HAVE_MAJOR" == "$WANT_MAJOR" && -f "$SPARTICUZ_ICD" ]]; then
      ok "bundled Chromium $HAVE_VER at $SPARTICUZ_BIN (SwiftShader Vulkan ICD present)"
      BROWSER_READY=1
    elif can_install && [[ -n "$WANT_MAJOR" ]]; then
      if [[ -n "$HAVE_VER" ]]; then
        detail "found Chromium $HAVE_VER at $SPARTICUZ_BIN but package is $WANT_MAJOR.x — re-extracting"
        rm -f "$SPARTICUZ_BIN"
      else
        detail "extracting @sparticuz/chromium $WANT_MAJOR.x to $TMP (one-time, ~150 MB)"
      fi
      if provision_sparticuz && HAVE_VER="$(chromium_version_of "$SPARTICUZ_BIN")" && [[ -n "$HAVE_VER" ]]; then
        fixed "bundled Chromium $HAVE_VER extracted to $SPARTICUZ_BIN"
        BROWSER_READY=1
      else
        detail "bundled Chromium could not be launched here (missing system libs?)"
        detail "on Debian/Ubuntu: sudo apt-get install -y libnss3 libnspr4 libatk-bridge2.0-0 libgbm1 libxkbcommon0 libasound2"
      fi
    else
      detail "bundled Chromium not extracted (run without --check)"
    fi
  fi

  # 5c. Playwright-managed Chromium (needs its CDN to be reachable).
  if [[ $BROWSER_READY -eq 0 ]]; then
    PW_PATH="$(playwright_browser_path)"
    if [[ -n "$PW_PATH" && -x "$PW_PATH" ]]; then
      ok "Playwright Chromium at $PW_PATH"
      BROWSER_READY=1
    elif can_install; then
      detail "trying Playwright's managed Chromium download"
      if run npx --no-install playwright-core install chromium >/dev/null 2>&1 && [[ -x "$PW_PATH" || -n "$(playwright_browser_path)" ]]; then
        fixed "Playwright Chromium installed"
        BROWSER_READY=1
      else
        detail "Playwright CDN unreachable or install failed"
      fi
    fi
  fi

  if [[ $BROWSER_READY -eq 0 ]]; then
    if [[ $BROWSER == "required" ]]; then
      fail "no headless Chromium available — check:browser cannot run"
    else
      warn "no headless Chromium — typecheck/test/check:wgsl will work, check:browser will exit 2 (NOT RUN)"
    fi
  fi
fi

# ------------------------------------- 6. Vulkan loader + software ICD (real WebGPU in Chromium)

# Chromium presents WebGPU through Vulkan, and on a headless machine that takes two things: a Vulkan
# loader, and a software ICD to answer for (Mesa's lavapipe; Chromium can also bundle its own). Two
# machines can both say "no adapter" and need different fixes, so this step checks both halves
# separately, installs the system packages when they are missing, and reports which ICD
# tools/gpu-env.mjs will hand the gate. A build that bundles its own ICD needs none of the packages —
# which is why anything here is a warning, not a failure, unless --browser asks for a hard answer.
step "Vulkan loader + software ICD (real WebGPU)"

vulkan_packages() {
  if have apt-get; then echo "libvulkan1 mesa-vulkan-drivers"
  elif have dnf; then echo "vulkan-loader mesa-vulkan-drivers"
  elif have yum; then echo "vulkan-loader mesa-vulkan-drivers"
  elif have pacman; then echo "vulkan-icd-loader mesa"
  elif have apk; then echo "vulkan-loader mesa-vulkan-lavapipe"
  else echo ""
  fi
}

# sudo only when it will not stop for a password: a setup script that hangs on a prompt is worse than
# one that prints the command to run.
install_prefix() {
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then echo ""
  elif have sudo && sudo -n true 2>/dev/null; then echo "sudo"
  else echo ""
  fi
}

install_vulkan() {
  local prefix="$1" pkgs="$2"
  if have apt-get; then
    $prefix env DEBIAN_FRONTEND=noninteractive apt-get update -qq &&
      $prefix env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $pkgs
  elif have dnf; then $prefix dnf install -y -q $pkgs
  elif have yum; then $prefix yum install -y -q $pkgs
  elif have pacman; then $prefix pacman -Sy --noconfirm --needed $pkgs
  elif have apk; then $prefix apk add --no-cache $pkgs
  else return 1
  fi
}

system_loader() {
  local candidate
  for candidate in \
    /usr/lib/x86_64-linux-gnu/libvulkan.so.1 \
    /usr/lib/aarch64-linux-gnu/libvulkan.so.1 \
    /usr/lib64/libvulkan.so.1 \
    /usr/lib/libvulkan.so.1; do
    if [[ -f "$candidate" ]]; then printf '%s' "$candidate"; return 0; fi
  done
  return 1
}

system_icd_count() {
  local count=0 candidate
  for candidate in /usr/share/vulkan/icd.d/*.json /etc/vulkan/icd.d/*.json; do
    [[ -f "$candidate" ]] && count=$((count + 1))
  done
  printf '%s' "$count"
}

if [[ $BROWSER == "skip" ]]; then
  detail "skipped (--no-browser)"
elif [[ $NODE_OK -ne 1 ]]; then
  detail "skipped (no usable node)"
else
  # The browser the gate will launch, discovered exactly as tools/browser-check.mjs discovers it, so
  # the ICD reported here is the ICD that run uses.
  BROWSER_BIN=""
  if [[ -n "${PLAYWRIGHT_CHROMIUM:-}" && -x "$PLAYWRIGHT_CHROMIUM" ]]; then
    BROWSER_BIN="$PLAYWRIGHT_CHROMIUM"
  elif [[ -x "$SPARTICUZ_BIN" ]]; then
    BROWSER_BIN="$SPARTICUZ_BIN"
  else
    BROWSER_BIN="$(playwright_browser_path)"
    [[ -x "$BROWSER_BIN" ]] || BROWSER_BIN=""
  fi

  GPU_JSON="{}"
  if [[ -n "$BROWSER_BIN" ]]; then
    GPU_JSON="$(node tools/gpu-env.mjs --chromium "$BROWSER_BIN" --extra-lib "$SPARTICUZ_LIBS" --json 2>/dev/null || echo '{}')"
  fi
  BUNDLED_ICD="$(json_str_get "$GPU_JSON" icd)"
  BUNDLED_LOADER="$(json_str_get "$GPU_JSON" loader)"
  GATE_LIBRARY_PATH="$(json_str_get "$GPU_JSON" libraryPath)"

  SYS_LOADER="$(system_loader || true)"
  SYS_ICDS="$(system_icd_count)"

  if [[ -n "$BUNDLED_ICD" ]]; then
    ok "the gate points VK_ICD_FILENAMES at $BUNDLED_ICD (bundled with $(basename "$BROWSER_BIN"))"
    if [[ -n "$BUNDLED_LOADER" ]]; then
      detail "bundled Vulkan loader $BUNDLED_LOADER, library path $GATE_LIBRARY_PATH"
    fi
  fi
  if [[ -n "$SYS_LOADER" && "$SYS_ICDS" -gt 0 ]]; then
    ok "system Vulkan stack: $SYS_LOADER with $SYS_ICDS ICD(s)"
  fi

  if [[ -z "$SYS_LOADER" || "$SYS_ICDS" -eq 0 ]]; then
    PKGS="$(vulkan_packages)"
    PREFIX="$(install_prefix)"
    # The command printed when the script cannot install: the same packages, for the manager this
    # machine actually has, so the message can be pasted as-is.
    INSTALL_CMD=""
    if [[ -n "$PKGS" ]]; then
      if have apt-get; then INSTALL_CMD="sudo apt-get install -y $PKGS"
      elif have dnf; then INSTALL_CMD="sudo dnf install -y $PKGS"
      elif have yum; then INSTALL_CMD="sudo yum install -y $PKGS"
      elif have pacman; then INSTALL_CMD="sudo pacman -S --needed $PKGS"
      elif have apk; then INSTALL_CMD="sudo apk add --no-cache $PKGS"
      fi
    fi

    if [[ $MODE == "check" ]]; then
      if [[ -n "$BUNDLED_ICD" ]]; then
        warn "no system Vulkan loader/ICD (${INSTALL_CMD:-no known package set for this distro}) — the browser's own ICD covers the gate"
      elif [[ -z "$BROWSER_BIN" ]]; then
        # Without a browser there is nothing to give an ICD to; step 5 already reported that half.
        warn "no system Vulkan loader/ICD (${INSTALL_CMD:-install libvulkan1 and a software ICD}) — and no browser to run"
      else
        fail "no Vulkan loader and no ICD: $BROWSER_BIN cannot get an adapter here (fix: ${INSTALL_CMD:-install libvulkan1 and a software ICD})"
      fi
    elif [[ -z "$PKGS" ]]; then
      warn "no supported package manager for the Vulkan loader — install libvulkan1 and a software ICD (lavapipe) by hand"
    elif [[ -z "$PREFIX" && "${EUID:-$(id -u)}" -ne 0 ]]; then
      warn "cannot install $PKGS (no passwordless sudo) — run: $INSTALL_CMD"
    else
      detail "installing $PKGS (a browser with no bundled Vulkan stack needs these to get an adapter)"
      if run install_vulkan "$PREFIX" "$PKGS" >/dev/null; then
        SYS_LOADER="$(system_loader || true)"
        SYS_ICDS="$(system_icd_count)"
        if [[ -n "$SYS_LOADER" && "$SYS_ICDS" -gt 0 ]]; then
          fixed "$PKGS -> $SYS_LOADER with $SYS_ICDS ICD(s)"
        else
          warn "$PKGS installed but no loader/ICD appeared — check /usr/share/vulkan/icd.d"
        fi
      elif [[ -n "$BUNDLED_ICD" ]]; then
        warn "could not install $PKGS (offline or not permitted) — the browser's own ICD still covers the gate; run: $INSTALL_CMD"
      else
        warn "could not install $PKGS (offline or not permitted) — run: $INSTALL_CMD"
      fi
    fi
  fi

  # Whatever the packaging situation turned out to be, can this machine give the gate an adapter? With
  # a bundled ICD it always can. Without one, --browser asked for a hard answer, and anything else is
  # told plainly that the gate will report "did not run" rather than run.
  if [[ $MODE == "install" && -z "$BUNDLED_ICD" ]]; then
    SYS_LOADER="$(system_loader || true)"
    SYS_ICDS="$(system_icd_count)"
    if [[ -z "$SYS_LOADER" || "$SYS_ICDS" -eq 0 ]]; then
      if [[ $BROWSER == "required" ]]; then
        fail "no Vulkan ICD for the browser gate — run: ${INSTALL_CMD:-install libvulkan1 and a software ICD}"
      else
        warn "no Vulkan ICD available: the browser gate will report 'did not run' instead of running"
      fi
    fi
  fi

  # One machine-readable record of what the gate will launch with, for anyone starting that browser by
  # hand (devtools debugging, tracing a shader).
  if [[ $MODE == "install" && -n "$BROWSER_BIN" ]]; then
    {
      printf '# Generated by scripts/setup-deps.sh — the Vulkan environment tools/browser-check.mjs\n'
      printf '# launches %s with. Source it to launch that binary by hand with the same ICD.\n' "$BROWSER_BIN"
      printf "export LD_LIBRARY_PATH='%s'\n" "$GATE_LIBRARY_PATH"
      if [[ -n "$BUNDLED_ICD" ]]; then
        printf "export VK_ICD_FILENAMES='%s'\n" "$BUNDLED_ICD"
        printf "export VK_DRIVER_FILES='%s'\n" "$BUNDLED_ICD"
      fi
    } > "$GPU_ENV_FILE"
    detail "wrote $GPU_ENV_FILE"
  fi
fi

# ------------------------------------------------------------------------------------ report

echo
printf '%sForge dependency status%s (%s mode)\n' "$C_BOLD" "$C_OFF" "$MODE"
for line in "${SUMMARY[@]}"; do printf '%s\n' "$line"; done
echo

if [[ $FAILURES -gt 0 ]]; then
  printf '%s%d problem(s).%s\n' "$C_ERR" "$FAILURES" "$C_OFF"
  exit 1
fi
if [[ $MODE == "check" ]]; then
  printf '%sEverything required is installed at the expected versions.%s\n' "$C_OK" "$C_OFF"
else
  if [[ $CHANGES -gt 0 ]]; then
    printf '%sInstalled/updated %d item(s).%s ' "$C_OK" "$CHANGES" "$C_OFF"
  else
    printf '%sNothing to do — already up to date.%s ' "$C_OK" "$C_OFF"
  fi
  printf 'Next: %snpm run verify%s  (add %snpm run check:browser%s for the real-WebGPU gate)\n' "$C_BOLD" "$C_OFF" "$C_BOLD" "$C_OFF"
fi
[[ $WARNINGS -gt 0 ]] && printf '%s%d warning(s) above.%s\n' "$C_WARN" "$WARNINGS" "$C_OFF"
exit 0
