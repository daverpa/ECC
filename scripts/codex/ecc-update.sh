#!/usr/bin/env bash
set -euo pipefail

MARKETPLACE="ecc"
PLUGIN="ecc@ecc"
MARKETPLACE_ROOT="${ECC_MARKETPLACE_ROOT:-$HOME/.codex/.tmp/marketplaces/ecc}"

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    echo "ERROR: a SHA-256 utility is required (shasum or sha256sum)" >&2
    return 1
  fi
}

printf '\n=== ECC UPDATE ===\n'
printf '\n[1/4] Refreshing Git marketplace...\n'
codex plugin marketplace upgrade "$MARKETPLACE"

printf '\n[2/4] Reinstalling plugin...\n'
codex plugin remove "$PLUGIN" >/dev/null 2>&1 || true
install_output="$(codex plugin add "$PLUGIN")"
printf '%s\n' "$install_output"

plugin_root="$(printf '%s\n' "$install_output" | sed -n 's/^Installed plugin root: //p' | tail -n 1)"
if [ -z "$plugin_root" ] || [ ! -d "$plugin_root" ]; then
  echo "ERROR: unable to determine installed ECC plugin root" >&2
  exit 1
fi

printf '\n[3/4] Verifying critical CLv2 files...\n'
files=(
  "skills/continuous-learning-v2/agents/observer-loop.sh"
  "skills/continuous-learning-v2/agents/start-observer.sh"
)

for file in "${files[@]}"; do
  source_file="$MARKETPLACE_ROOT/$file"
  installed_file="$plugin_root/$file"
  [ -f "$source_file" ] || { echo "ERROR: marketplace file missing: $source_file" >&2; exit 1; }
  [ -f "$installed_file" ] || { echo "ERROR: installed file missing: $installed_file" >&2; exit 1; }
  source_hash="$(sha256_file "$source_file")"
  installed_hash="$(sha256_file "$installed_file")"
  if [ "$source_hash" != "$installed_hash" ]; then
    echo "ERROR: hash mismatch: $file" >&2
    echo "  marketplace: $source_hash" >&2
    echo "  installed:   $installed_hash" >&2
    exit 1
  fi
  printf 'OK  %s\n' "$file"
done

version="unknown"
[ -f "$plugin_root/VERSION" ] && version="$(tr -d '[:space:]' < "$plugin_root/VERSION")"
commit="unknown"; ref="unknown"; remote="unknown"
if git -C "$MARKETPLACE_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  commit="$(git -C "$MARKETPLACE_ROOT" rev-parse HEAD)"
  ref="$(git -C "$MARKETPLACE_ROOT" symbolic-ref --short -q HEAD || printf '%s' '<detached>')"
  remote="$(git -C "$MARKETPLACE_ROOT" remote get-url origin 2>/dev/null || printf '%s' 'unknown')"
fi

printf '\n[4/4] Result\n'
printf 'Marketplace: %s\nRemote:      %s\nRef:         %s\nCommit:      %s\nPlugin root: %s\nVersion:     %s\nCLv2:        verified\n' \
  "$MARKETPLACE" "$remote" "$ref" "$commit" "$plugin_root" "$version"
printf '\nECC update completed successfully.\n'
