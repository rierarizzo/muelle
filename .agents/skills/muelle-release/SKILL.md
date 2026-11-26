---
name: Muelle Release
description: Prepare, validate, tag, and publish a Muelle GitHub release with the GNOME extension bundle.
---

# Muelle Release

Use this skill when the user asks to prepare or publish a Muelle release.

## Ground rules

- Get explicit confirmation before committing, tagging, pushing, or publishing.
- Never force-push or move an already published tag.
- Do not publish if the working tree is dirty, tests fail, or the bundle does not install.
- Reply to the user in their language; keep project files in English.

## Versioning

- Tags use `vMAJOR.MINOR.PATCH`; the first public release is `v0.1.0`.
- `metadata.json` uses an integer `version`: 1 for 0.1.0, then increment by 1 for each release.
- Tags `v16` through `v73` are inherited from upstream Dock from Dash. Ignore them; do not continue that series.
- Read `references/release-policy.md` for the full policy and rollback notes.

## Workflow

1. Preflight:

   ```sh
   git status --short
   git branch --show-current
   git fetch origin
   git status -sb
   gh auth status
   ```

   Require a clean tree, branch `main`, and `origin/main` up to date.

2. Confirm the version and tag with the user. Check the tag does not exist:

   ```sh
   git tag --list "vX.Y.Z"
   ```

3. Update the integer `version` in `metadata.json`.

4. Build and verify:

   ```sh
   .agents/skills/muelle-release/scripts/build-bundle.sh
   ```

   The script compiles the schema, runs the tests, packs the extension, and
   installs the bundle in a temporary `XDG_DATA_HOME` to verify it.

5. Inspect the bundle:

   ```sh
   unzip -l dist/muelle@kenethriera.shell-extension.zip
   ```

   It must contain `metadata.json` at the root, `extension.js`, `prefs.js`,
   `LICENSE`, and `schemas/` with the XML. `gnome-extensions install` compiles
   `gschemas.compiled` during installation.

6. Commit the version bump only after approval:

   ```sh
   git add metadata.json
   git commit -m "chore: release X.Y.Z"
   ```

7. Create and push the tag only after approval:

   ```sh
   git tag -a vX.Y.Z -m "Muelle X.Y.Z"
   git push origin main
   git push origin vX.Y.Z
   ```

8. Publish the release:

   - If `.github/workflows/release.yml` exists, pushing the tag publishes it.
     Wait for the workflow, then verify the asset. Do not also run
     `gh release create`.
   - Otherwise, fill `references/release-notes.md`, then:

     ```sh
     cp .agents/skills/muelle-release/references/release-notes.md \
       /tmp/opencode/muelle-X.Y.Z.md
     # Edit the placeholders before running this.
     gh release create vX.Y.Z \
       dist/muelle@kenethriera.shell-extension.zip \
       --title "Muelle X.Y.Z" \
       --notes-file /tmp/opencode/muelle-X.Y.Z.md
     ```

9. Verify and report:

   ```sh
   gh release view vX.Y.Z --json url,assets
   ```

   Report the release URL and the install command. Remind users on Wayland that
   a freshly installed zip needs a logout/login before enabling.

## Notes

- `dist/` is build output and must never be committed.
- EGO upload is manual: upload the same zip at https://extensions.gnome.org/upload/.
  EGO installs through the Shell D-Bus and avoids the Wayland restart that the
  local zip + `gnome-extensions install` flow needs.
- Keep release notes user-facing: features, install steps, known limitations.
