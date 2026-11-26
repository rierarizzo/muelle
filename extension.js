/*
    Muelle - GNOME Shell dock. Fork of Dock from Dash.
    Original: Dock from Dash - GNOME Shell 46+ extension
    Copyright Francois Thirioux 2025
    GitHub contributors: @fthx, @rastersoft, @underlinejakez, @lucaxvi, @subpop
    Some ideas picked from GNOME Shell native code
    Bottom edge code adapted from @jdoda's Hot Edge extension
    License GPL v3
*/

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Dash from 'resource:///org/gnome/shell/ui/dash.js';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';


// Dock settings
const DASH_MAX_HEIGHT_RATIO = 15; // %
const ANIMATION_TIME = 150; // ms
const HIDE_DELAY = 300; // ms
const REVEAL_STRIP_HEIGHT = 3; // px
const SHOW_OVERVIEW_AT_STARTUP = false;

const Mode = Object.freeze({
    ON: 'on',
    INTELLIGENT: 'intelligent',
    OFF: 'off',
});


const Dock = GObject.registerClass(
class Dock extends Dash.Dash {
    _init(settings) {
        super._init();

        this._settings = settings;
        this._hidden = false;
        this._modeInitialized = false;
        this._stripHover = false;
        this._updateTimeoutId = 0;
        this._windowActors = new Set();

        Main.layoutManager.addTopChrome(this, {
            affectsStruts: this._currentMode() === Mode.OFF,
        });

        this._dashContainer.set_track_hover(true);
        this._dashContainer.set_reactive(true);
        this.show();

        this._keep_dock_shown = false;
        this._dragging = false;

        this._dashContainer.connectObject('notify::hover',
            () => this._onHoverChanged(), this);
        this._dashContainer.connectObject('scroll-event',
            (actor, event) => Main.wm.handleWorkspaceScroll(event), this);
        this.showAppsButton.connectObject('notify::checked', () => {
            if (Main.overview.visible)
                this._oldDash.showAppsButton.checked =
                    this.showAppsButton.checked;
            else
                Main.overview.showApps();
        }, this);

        // Thin strip at the bottom edge to reveal the dock in on/intelligent
        // mode, even when a maximized window covers the bottom of the screen.
        this._revealStrip = new St.Widget({
            name: 'muelle-reveal',
            reactive: true,
            opacity: 0,
        });
        Main.layoutManager.addTopChrome(this._revealStrip);
        this._revealStrip.connectObject('enter-event', () => {
            this._stripHover = true;
            this._cancelUpdate();
            this._updateVisibility(true);
        }, this);
        this._revealStrip.connectObject('leave-event', () => {
            this._stripHover = false;
            this._scheduleUpdate();
        }, this);

        Main.overview.connectObject('item-drag-begin',
            () => { this._dragging = true; }, this);
        Main.overview.connectObject('item-drag-end',
            () => { this._dragging = false; }, this);
        global.display.connectObject('workareas-changed',
            this._dock_refresh.bind(this), this);
        Main.layoutManager.connectObject('monitors-changed',
            this._dock_refresh.bind(this), this);

        // The native Dash adjusts icon size lazily; reposition the dock when
        // that happens or it can end up off-screen.
        this.connectObject('icon-size-changed',
            () => this._dock_reposition(), this);
        this.connectObject('notify::height',
            () => this._dock_reposition(), this);

        // Like Dash to Dock: keep our dock visible in the overview and hide
        // the native dash instead. The same actor serves both states, so
        // there is nothing to swap and no flicker.
        this._oldDash = Main.overview.dash;
        if (this._oldDash) {
            this._oldDash.showAppsButton.bind_property('checked',
                this.showAppsButton, 'checked', GObject.BindingFlags.SYNC_CREATE);
            this._oldDash.hide();
            this._oldDash.set_height(1);
            this._oldDash.connectObject('notify::visible',
                () => this._oldDash.hide(), this);
            this._oldDash.connectObject('notify::height',
                () => this._oldDash.set_height(1), this);

            // The overview layout reserves space using the dash's
            // get_preferred_height(). Since the native dash is hidden, return
            // the dock height so the workspace area stops above it.
            this._oldDashOrigGetPreferredHeight =
                this._oldDash.get_preferred_height;
            this._oldDash.get_preferred_height = (...args) =>
                this.get_preferred_height(...args);
        }

        // Sources that can change the auto-hide/intellihide decision.
        for (const actor of global.get_window_actors())
            this._trackWindow(actor);

        global.display.connectObject('restacked',
            () => this._scheduleUpdate(), this);
        global.display.connectObject('window-created',
            () => this._scheduleUpdate(), this);
        global.window_manager.connectObject(
            'map', (wm, actor) => {
                this._trackWindow(actor);
                this._scheduleUpdate();
            },
            'minimize', () => this._scheduleUpdate(),
            'unminimize', () => this._scheduleUpdate(), this);
        global.workspace_manager.connectObject('active-workspace-changed',
            () => this._scheduleUpdate(), this);

        this._settings.connectObject('changed::autohide-mode',
            () => this._onModeChanged(), this);

        Main.overview.connectObject('showing', () => {
            this._cancelUpdate();
            this._revealStrip.hide();
            this._slideIn(false);
        }, this);
        Main.overview.connectObject('hidden', () => {
            this._updateStripVisibility();
            this._updateVisibility(false);
        }, this);

        this.connectObject('destroy', this._destroy.bind(this), this);

        this._dock_refresh();
    }

    _trackWindow(actor) {
        if (this._windowActors.has(actor))
            return;

        this._windowActors.add(actor);
        actor.connectObject(
            'notify::allocation', () => this._scheduleUpdate(),
            'destroy', () => {
                this._windowActors.delete(actor);
                this._scheduleUpdate();
            }, this);
    }

    _currentMode() {
        return this._settings.get_string('autohide-mode');
    }

    _onModeChanged() {
        Main.layoutManager.untrackChrome(this);
        Main.layoutManager.trackChrome(this, {
            affectsStruts: this._currentMode() === Mode.OFF,
        });

        this._modeInitialized = false;
        this._dock_reposition();
        this._updateStripVisibility();
        this._updateVisibility(true);
    }

    _onHoverChanged() {
        if (this._dashContainer.get_hover()) {
            this._cancelUpdate();
            this._updateVisibility(true);
        } else {
            this._scheduleUpdate();
        }
    }

    _updateStripVisibility() {
        this._revealStrip.visible =
            this._currentMode() !== Mode.OFF && !Main.overview.visible;
    }

    _shouldShow() {
        if (Main.overview.visible)
            return true;

        const mode = this._currentMode();
        if (mode === Mode.OFF)
            return true;

        if (this._dashContainer.get_hover() || this._stripHover ||
            this._keep_dock_shown || this._dragging)
            return true;

        if (mode === Mode.INTELLIGENT)
            return !this._hasOverlap();

        return false; // Mode.ON
    }

    _updateVisibility(animate) {
        if (!this._modeInitialized) {
            animate = false;
            this._modeInitialized = true;
        }

        if (this._shouldShow())
            this._slideIn(animate);
        else
            this._slideOut(animate);
    }

    _scheduleUpdate(delay = HIDE_DELAY) {
        if (this._updateTimeoutId)
            return;

        this._updateTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._updateTimeoutId = 0;
            this._updateVisibility(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelUpdate() {
        if (this._updateTimeoutId) {
            GLib.source_remove(this._updateTimeoutId);
            this._updateTimeoutId = 0;
        }
    }

    _dockHeight() {
        const pref = this.get_preferred_height(this.work_area?.width ?? 0);
        const height = Array.isArray(pref) ? pref[1] : pref;
        return Math.max(this.height, height || 0);
    }

    _slideIn(animate) {
        if (!this._hidden)
            return;

        this._hidden = false;
        this.remove_all_transitions();

        if (animate && this.get_stage()) {
            this.ease({
                translation_y: 0,
                duration: ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            this.translation_y = 0;
        }
    }

    _slideOut(animate) {
        if (this._hidden)
            return;

        const height = this._dockHeight();
        if (!height)
            return;

        this._hidden = true;
        this.remove_all_transitions();

        if (animate && this.get_stage()) {
            this.ease({
                translation_y: height + 8,
                duration: ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
            });
        } else {
            this.translation_y = height + 8;
        }
    }

    _hasOverlap() {
        const area = this.work_area;
        if (!area)
            return false;

        const height = this._dockHeight();
        if (!height)
            return false;

        const dockTop = area.y + area.height - height;
        const dockRight = area.x + area.width;
        const workspace = global.workspace_manager.get_active_workspace();

        for (const actor of global.get_window_actors()) {
            const window = actor.meta_window;
            if (!window || window.get_window_type() !== Meta.WindowType.NORMAL)
                continue;
            if (window.minimized || window.is_skip_taskbar())
                continue;
            if (!window.located_on_workspace(workspace))
                continue;

            const rect = window.get_frame_rect();
            const overlaps =
                rect.x < dockRight &&
                rect.x + rect.width > area.x &&
                rect.y < area.y + area.height &&
                rect.y + rect.height > dockTop;

            if (overlaps)
                return true;
        }

        return false;
    }

    _itemMenuStateChanged(item, opened) {
        if (opened) {
            if (this._showLabelTimeoutId > 0) {
                GLib.source_remove(this._showLabelTimeoutId);
                this._showLabelTimeoutId = 0;
            }
            item.hideLabel();

            this._last_appicon_with_menu = item;
            this._keep_dock_shown = true;
        } else {
            if (item == this._last_appicon_with_menu) {
                this._last_appicon_with_menu = null;
                this._keep_dock_shown = false;
            }
        }

        this._updateVisibility(false);
    }

    _queueRedisplay() {
        if (this._workId)
            Main.queueDeferredWork(this._workId);
    }

    _dock_reposition() {
        if (!this.work_area)
            return;

        // get_preferred_height() returns [min, natural] on GNOME 45+.
        // Do not fix our own height: let the Dash compute it.
        const pref = this.get_preferred_height(this.work_area.width);
        const height = Array.isArray(pref) ? pref[1] : pref;
        if (!height)
            return;

        // A fixed dock must use the monitor bottom to avoid a strut/work-area loop.
        const monitor = Main.layoutManager.primaryMonitor;
        const bottom = monitor && this._currentMode() === Mode.OFF
            ? monitor.y + monitor.height
            : this.work_area.y + this.work_area.height;

        this.set_position(this.work_area.x, bottom - height);

        if (this._hidden)
            this.translation_y = height + 8;

        this._revealStrip.set_position(this.work_area.x,
            bottom - REVEAL_STRIP_HEIGHT);
        this._revealStrip.set_size(this.work_area.width, REVEAL_STRIP_HEIGHT);
    }

    _dock_refresh() {
        if (this._dock_refreshing)
            return;
        this._dock_refreshing = true;

        const primaryIndex = Main.layoutManager.primaryIndex;
        if (primaryIndex < 0) {
            this._dock_refreshing = false;
            return;
        }

        const workArea = Main.layoutManager.getWorkAreaForMonitor(primaryIndex);
        if (!workArea) {
            this._dock_refreshing = false;
            return;
        }
        this.work_area = workArea;

        this.max_dock_height = Math.round(
            workArea.height * DASH_MAX_HEIGHT_RATIO / 100);
        this.set_width(workArea.width);
        this.setMaxSize(workArea.width, this.max_dock_height);
        this._dock_reposition();
        this._updateStripVisibility();
        this._updateVisibility(false);

        this._dock_refreshing = false;
    }

    _destroy() {
        Main.overview.disconnectObject(this);
        this._dashContainer.disconnectObject(this);
        this.showAppsButton.disconnectObject(this);
        global.display.disconnectObject(this);
        global.window_manager.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._settings.disconnectObject(this);

        for (const actor of this._windowActors)
            actor.disconnectObject(this);
        this._windowActors.clear();

        this._cancelUpdate();

        if (this._revealStrip) {
            Main.layoutManager.removeChrome(this._revealStrip);
            this._revealStrip.destroy();
            this._revealStrip = null;
        }

        if (this._oldDash) {
            this._oldDash.disconnectObject(this);
            if (this._oldDashOrigGetPreferredHeight) {
                this._oldDash.get_preferred_height =
                    this._oldDashOrigGetPreferredHeight;
                this._oldDashOrigGetPreferredHeight = null;
            }
            this._oldDash.show();
            this._oldDash.set_height(-1);
            this._oldDash._maxHeight = -1;
            this._oldDash = null;
        }

        this.disconnectObject(this);
        this._workId = null;
        super.destroy();
    }
});


export default class MuelleExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._settings = null;
    }

    _modify_native_click_behavior() {
        this.original_click_function = AppDisplay.AppIcon.prototype.activate;
        AppDisplay.AppIcon.prototype.activate = function(button) {
            let event = Clutter.get_current_event();
            let modifiers = event ? event.get_state() : 0;
            let isMiddleButton = button && button == Clutter.BUTTON_MIDDLE;
            let isCtrlPressed = (modifiers & Clutter.ModifierType.CONTROL_MASK) != 0;
            let openNewWindow = this.app.can_open_new_window() && this.app.state == Shell.AppState.RUNNING && (isCtrlPressed || isMiddleButton);
            if (this.app.state == Shell.AppState.STOPPED || openNewWindow)
                this.animateLaunch();

            if (openNewWindow) {
                this.app.open_new_window(-1);
                Main.overview.hide();
            } else {
                let app_windows = this.app
                    .get_windows()
                    .filter(window => !window.is_override_redirect() && !window.is_attached_dialog() && window.located_on_workspace(global.workspace_manager.get_active_workspace()))
                    .sort((w1, w2) => w1.get_id() - w2.get_id());

                switch (app_windows.length) {
                    case 0:
                        this.app.activate();
                        Main.overview.hide();
                    break;
                    case 1:
                        if (app_windows[0].has_focus() && app_windows[0].can_minimize()) {
                            app_windows[0].minimize();
                            Main.overview.hide();
                        } else {
                            if (!app_windows[0].has_focus()) {
                                app_windows[0].activate(global.get_current_time());
                                Main.overview.hide();
                            }
                        }
                    break;
                    default:
                        if (Main.overview.visible) {
                            this.app.activate();
                            Main.overview.hide();
                        } else {
                            let app_has_focus = false;
                            let app_focused_window_index = 0;
                            for (var index = 0; index < app_windows.length; index++) {
                                if (app_windows[index].has_focus()) {
                                    app_has_focus = true;
                                    app_focused_window_index = index;
                                }
                            }

                            if (app_has_focus) {
                                let next_index = (app_focused_window_index + 1) % app_windows.length;
                                this.app.activate_window(app_windows[next_index], global.get_current_time());
                            } else
                                this.app.activate();
                        }
                }
            }
        };
    }

    enable() {
        this._settings = this.getSettings();
        this._modify_native_click_behavior();

        this._dock = new Dock(this._settings);

        // Disable before the shell tears down actors, otherwise restoring the
        // native dash touches an already disposed object. Same workaround as
        // Dash to Dock until extensions are disabled on shutdown upstream.
        this._shutdownId = global.connect('shutdown', () => this.disable());

        Main.layoutManager.connectObject('startup-complete', () => {
            if (!SHOW_OVERVIEW_AT_STARTUP)
                Main.overview.hide();
        }, this);
    }

    disable() {
        if (this._shutdownId) {
            global.disconnect(this._shutdownId);
            this._shutdownId = null;
        }

        AppDisplay.AppIcon.prototype.activate = this.original_click_function;

        Main.layoutManager.disconnectObject(this);

        this._dock?.destroy();
        this._dock = null;
        this._settings = null;
    }
}
