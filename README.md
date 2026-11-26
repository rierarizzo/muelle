# Muelle

Lightweight GNOME Shell dock built on top of the native Dash.

Fork of [Dock from Dash](https://github.com/fthx/dock-from-dash) by
Francois Thirioux and contributors, licensed under GPLv3. See `LICENSE`.

## Auto-hide modes

Configure with `gnome-extensions prefs muelle@kenethriera`:

- **Always** — always hidden, revealed by hovering the bottom edge.
- **When a window overlaps** (default) — hidden only while a window overlaps the dock.
- **Never** — always visible.

## Differences from upstream

- Supports GNOME Shell 51.
- Three auto-hide modes backed by GSettings (see above).
- The native overview dash is hidden and `get_preferred_height()` is
  overridden so the overview reserves the dock height.
- Fixes `get_preferred_height()` array handling on GNOME 45+.
- Repositions on `icon-size-changed` and `notify::height`.
- Fixes the stuck `_dock_refreshing` guard, timer leaks in `_destroy()`,
  and invalid primary monitor index at startup.

## Development

After editing the schema, compile it in place:

```sh
glib-compile-schemas schemas
```
