# Muelle release policy

## Version mapping

| Release | Git tag | `metadata.json` version |
| ------- | ------- | ----------------------- |
| First public | `v0.1.0` | 1 |
| Next | `vX.Y.Z` | previous + 1 |

`metadata.json` version is an integer for GNOME tooling; it does not have to
match the semantic version. Increment it once per published release.

## Tag history

Tags `v16` through `v73` come from the upstream Dock from Dash fork and are
kept for history. Do not reuse or continue them. Start the Muelle series at
`v0.1.0`.

## Preconditions

- `main` is clean and equal to `origin/main`.
- `glib-compile-schemas --strict schemas` succeeds.
- `gjs -m tests/run.js` passes.
- The temporary install creates
  `schemas/gschemas.compiled` in the installed extension.
- `gh auth status` shows the expected GitHub account.

## Approval gates

Ask before:

1. committing the version bump,
2. creating and pushing the tag,
3. publishing the GitHub release.

An explicit request such as "publish 0.2.0" approves the version, but still show
the exact tag and release title before pushing.

## Rollback

If the release is wrong and not yet announced:

```sh
gh release delete vX.Y.Z --yes
git push origin :refs/tags/vX.Y.Z
git tag -d vX.Y.Z
```

Never move a tag that users may already have fetched. Publish a new patch
release instead.

## Install caveat

The local zip flow (`gnome-extensions install`) does not notify the running
Shell. On Wayland the user must log out and back in before enabling a new
extension. On X11, `Alt+F2` then `r` restarts the Shell.

EGO installs use the Shell's D-Bus installer, which loads and enables the
extension at runtime, so that flow avoids the restart.
