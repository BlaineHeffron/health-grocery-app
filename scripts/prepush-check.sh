#!/usr/bin/env bash
# Public-repo guard. Run before EVERY push (it is deliberately not a git hook):
#   scripts/prepush-check.sh
# Scans the outgoing commits (PREPUSH_BASE..HEAD, default origin/main..HEAD), the staged
# changes and the tracked file list for secrets, db files, tailnet hosts/addresses and absolute
# local paths (which would reveal the private health folder or the host layout).
# Exits 0 when clean, 1 with a list of findings otherwise. Matched values are never printed.
set -euo pipefail

base="${PREPUSH_BASE:-origin/main}"
if ! git rev-parse --verify --quiet "${base}^{commit}" >/dev/null; then
  echo "prepush-check: base ref '${base}' not found (git fetch origin, or set PREPUSH_BASE)" >&2
  exit 2
fi

if ! git merge-base "$base" HEAD >/dev/null 2>&1; then
  echo "prepush-check: FAILED: HEAD shares no history with ${base} (unrelated history; rebase onto ${base})" >&2
  exit 1
fi

findings=()
add() { findings+=("$1"); }

# ---- Path rules: every path touched by outgoing commits, staged, or tracked. ----
paths="$(
  {
    git log --format= --name-only "${base}..HEAD"
    git diff --cached --name-only
    git ls-files
  } | sed '/^$/d' | sort -u
)"

# Patterns are written so this file does not match itself.
# Tailnet MagicDNS names (*.ts.net).
tailnet_host_re='[A-Za-z0-9-]+[.]ts[.]net([^A-Za-z0-9-]|$)'
# CGNAT range used by tailnets (100.64/10): first octet 100, second octet 64-127.
tailnet_ip_re='(^|[^0-9.])100[.](6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])[.][0-9]{1,3}[.][0-9]{1,3}([^0-9]|$)'
# Absolute local paths under /home/<user> or /media
local_path_re='(^|[^A-Za-z0-9_.~-])/(home/[A-Za-z0-9_.-]+|media)/[^[:space:]]'

while IFS= read -r p; do
  if [ -z "$p" ]; then continue; fi
  base_name="${p##*/}"
  case "$base_name" in
    .env.example) ;;
    .env | .env.*) add "env file: $p" ;;
  esac
  case "$base_name" in
    *.db | *.db-* | *.sqlite | *.sqlite3) add "database file: $p" ;;
    *.pem | *.key | *.p12 | *.pfx | id_rsa | id_ed25519 | id_ecdsa) add "key file: $p" ;;
  esac
  case "$p" in
    .agent_bus/*) add "agent bus content: $p" ;;
  esac
  if printf '%s\n' "$p" | grep -qiE "$tailnet_host_re"; then
    add "tailnet hostname in path: $p"
  fi
done <<<"$paths"

# ---- Content rules: lines added by outgoing commits (merge resolutions included via
# --remerge-diff), by the staged diff, and the outgoing commit messages. ----
# Each line is prefixed "<where>:" so findings name the file or commit, never the value.
# A "+++ " line is a file header only between "diff --git" and the first "@@" hunk.
added="$(
  {
    git log --format= -p --remerge-diff --text --no-color --no-ext-diff --unified=0 "${base}..HEAD"
    git diff --cached -p --text --no-color --no-ext-diff --unified=0
  } | awk '
    /^diff --git / { header = 1; next }
    header && /^\+\+\+ / { f = substr($0, 5); sub(/^"?b\//, "", f); sub(/"$/, "", f); next }
    /^@@/          { header = 0; next }
    !header && /^\+/ { print f ":" substr($0, 2) }
  '
  git log --format='prepush-check-commit %h%n%B' "${base}..HEAD" | awk '
    /^prepush-check-commit / { c = "commit message " $2; next }
    { print c ":" $0 }
  '
)"

check() { # check <label> <extended-regex> [-i]
  local label="$1" re="$2" flags="${3:-}" hits
  hits="$(printf '%s\n' "$added" | grep -E $flags -- "$re" | cut -d: -f1 | sort -u || true)"
  while IFS= read -r f; do
    if [ -n "$f" ]; then add "$label in $f"; fi
  done <<<"$hits"
}

check "private key block" '-----BEGIN[ A-Z]*PRIVATE KEY-----'
check "bearer token" 'Bearer[[:space:]]+[A-Za-z0-9._~+/=-]{8,}'
check "KROGER_CLIENT_SECRET value" 'KROGER_CLIENT_SECRET[[:space:]]*=[[:space:]]*["'\'']?[^[:space:]"'\''#]'
check "KITCHENOWL_TOKEN value" 'KITCHENOWL_TOKEN[[:space:]]*=[[:space:]]*["'\'']?[^[:space:]"'\''#]'
check "tailnet hostname" "$tailnet_host_re" -i
check "tailnet address" "$tailnet_ip_re"
check "absolute local path" "$local_path_re"

# Generic high-entropy assignment: a secret-ish name assigned a 20+ char literal that mixes
# letters and digits (e.g. api_key = "a1B2...", TOKEN=abc123...).
secret_name='[A-Za-z0-9_]*(secret|token|passw(or)?d|api[_-]?key|access[_-]?key|private[_-]?key|auth)[A-Za-z0-9_]*'
secret_re="${secret_name}[\"']?[[:space:]]*[:=][[:space:]]*[\"']?[A-Za-z0-9+/_.=-]{20,}"
hits="$(
  { printf '%s\n' "$added" | grep -iE -- "$secret_re" || true; } | while IFS= read -r line; do
    value="$(printf '%s\n' "$line" | grep -ioE -- "$secret_re" | grep -oE '[A-Za-z0-9+/_.=-]{20,}$' || true)"
    if printf '%s' "$value" | grep -qE '[0-9]' && printf '%s' "$value" | grep -qE '[A-Za-z]'; then
      printf '%s\n' "${line%%:*}"
    fi
  done | sort -u
)"
while IFS= read -r f; do
  if [ -n "$f" ]; then add "high-entropy secret assignment in $f"; fi
done <<<"$hits"

if [ "${#findings[@]}" -gt 0 ]; then
  echo "prepush-check: FAILED (${base}..HEAD + staged)" >&2
  printf '  - %s\n' "${findings[@]}" >&2
  exit 1
fi
echo "prepush-check: OK (${base}..HEAD + staged + tracked)"
