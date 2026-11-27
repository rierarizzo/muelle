# Muelle

Lightweight GNOME Shell dock built on top of the native Dash.

Fork of [Dock from Dash](https://github.com/fthx/dock-from-dash) by
Francois Thirioux and contributors, licensed under GPLv3. See `LICENSE`.

## Auto-hide modes

Configure with `gnome-extensions prefs muelle@kenethriera`:

- **Always** — always hidden, revealed by hovering the bottom edge.
- **When a window overlaps** (default) — hidden only while a window overlaps the dock.
- **Never** — always visible.

## Dock icon size

Set it with the slider in the preferences window
(`gnome-extensions prefs muelle@kenethriera`). Defaults to 64 px; the range
is 8–128 px, with marks at the standard icon sizes.

A fixed size replaces the native Dash sizing, so the dock no longer shrinks
automatically when many apps are pinned.

## Trash

**Show Trash** in the preferences adds a Trash item at the end of the dock.
The icon switches between empty and full; clicking it opens the Trash and the
right-click menu offers **Open Trash** and **Empty Trash**. Emptying asks for
confirmation first.

## Window previews

Hovering a dock icon for a moment opens a native popover with the app name and
thumbnails of its open windows. Clicking a thumbnail activates that window;
**Esc** closes the preview. The dock stays visible while the preview is open,
in every auto-hide mode.

Tune the hover delay, hide delay and thumbnail size with the constants at the
top of `windowPreview.js`. Ported and trimmed from
[Dock Window Preview](https://github.com/teerprah/dock-window-preview) (GPLv3);
no close buttons, peek, enriched overview or preferences.

## Differences from upstream

- Supports GNOME Shell 51.
- Three auto-hide modes backed by GSettings (see above).
- The native overview dash is hidden and `get_preferred_height()` is
  overridden so the overview reserves the dock height.
- Fixes `get_preferred_height()` array handling on GNOME 45+.
- Repositions on `icon-size-changed` and `notify::height`.
- Optional Trash item with empty/full state and native empty confirmation.
- Window previews on icon hover (ported from Dock Window Preview), built in.
- Fixes the stuck `_dock_refreshing` guard, timer leaks in `_destroy()`,
  and invalid primary monitor index at startup.

## Development

After editing the schema, compile it in place:

```sh
glib-compile-schemas schemas
```

Run the regression tests:

```sh
gjs -m tests/run.js
```
