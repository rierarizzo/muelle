#!/usr/bin/env bash
set -euo pipefail

root=$(git rev-parse --show-toplevel)
cd "$root"

echo "==> Compiling schemas"
glib-compile-schemas --strict schemas

echo "==> Running tests"
gjs -m tests/run.js

echo "==> Packing extension"
rm -rf dist
mkdir -p dist
gnome-extensions pack --force \
  --out-dir=dist \
  --extra-source=LICENSE \
  --extra-source=windowPreview.js \
  --schema=schemas/org.gnome.shell.extensions.muelle.gschema.xml \
  .

bundle=$(find dist -maxdepth 1 -name '*.shell-extension.zip' -print -quit)
test -n "$bundle" || {
  echo "No bundle was created" >&2
  exit 1
}

for file in metadata.json extension.js prefs.js windowPreview.js stylesheet.css LICENSE; do
  unzip -Z1 "$bundle" | grep -qx "$file" || {
    echo "Bundle is missing $file" >&2
    exit 1
  }
done

echo "==> Testing install in a temporary profile"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/data/gnome-shell/extensions" \
  "$tmp/home/.local/share/gnome-shell/extensions"
HOME="$tmp/home" XDG_DATA_HOME="$tmp/data" \
  gnome-extensions install --force "$root/$bundle"

test -f "$tmp/data/gnome-shell/extensions/muelle@kenethriera/metadata.json"
test -f "$tmp/data/gnome-shell/extensions/muelle@kenethriera/schemas/gschemas.compiled"

echo "Bundle OK: $root/$bundle"
