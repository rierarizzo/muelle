# Muelle

Lightweight GNOME Shell dock built on top of the native Dash.

Fork of [Dock from Dash](https://github.com/fthx/dock-from-dash) by
Francois Thirioux and contributors, licensed under GPLv3. See `LICENSE`.

## Differences from upstream

- `shell-version` includes 51.
- Fixed dock by default (`AUTO_HIDE = false`): no hot edge and no flicker.
- The native overview dash is hidden and `get_preferred_height()` is
  overridden so the overview reserves the dock height.
- Fixes `get_preferred_height()` array handling on GNOME 45+.
- Repositions on `icon-size-changed` and `notify::height`.
- Fixes the stuck `_dock_refreshing` guard, timer leaks in `_destroy()`,
  and invalid primary monitor index at startup.

## States

- `AUTO_HIDE = true` restores the original pressure-barrier auto-hide.
