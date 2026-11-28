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
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Dash from 'resource:///org/gnome/shell/ui/dash.js';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import WindowPreview from './windowPreview.js';


// Dock settings
const DASH_MAX_HEIGHT_RATIO = 15; // %
const ANIMATION_TIME = 150; // ms
const HIDE_DELAY = 300; // ms
const ICON_GEOMETRY_DELAY = 50; // ms
const REVEAL_STRIP_HEIGHT = 3; // px
const SHOW_OVERVIEW_AT_STARTUP = false;

const Mode = Object.freeze({
    ON: 'on',
    INTELLIGENT: 'intelligent',
    OFF: 'off',
});

const TRASH_URI = 'trash:///';
const TRASH_UPDATE_DELAY = 300; // ms


const TrashItem = GObject.registerClass(
class TrashItem extends Dash.DashItemContainer {
    _init(iconSize) {
        super._init();

        this._icon = new St.Icon({
            icon_name: 'user-trash',
            icon_size: iconSize,
            style_class: 'show-apps-icon',
        });

        const iconBox = new St.Bin({
            style_class: 'overview-icon',
            x_expand: true,
            y_expand: true,
        });
        iconBox.set_child(this._icon);

        this.button = new St.Button({
            style_class: 'show-apps',
            track_hover: true,
            can_focus: true,
        });
        this.button.child = iconBox;

        this.setChild(this.button);
        this.setLabelText('Trash');
    }

    setIconSize(size) {
        if (this._icon.icon_size === size)
            return;
        this._icon.icon_size = size;
    }

    setIconName(name) {
        if (this._icon.icon_name === name)
            return;
        this._icon.icon_name = name;
    }
});


const Dock = GObject.registerClass(
class Dock extends Dash.Dash {
    _init(settings) {
        super._init();

        this._settings = settings;
        this._hidden = false;
        this._modeInitialized = false;
        this._stripHover = false;
        this._previewOpen = false;
        this._updateTimeoutId = 0;
        this._iconGeometryTimeoutId = 0;
        this._strutTimeoutId = 0;
        this._dockAllocated = false;
        this._windowActors = new Set();
        this._iconGeometry = new Map();

        Main.layoutManager.addTopChrome(this);
        this._strutEnabled = false;

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
            () => {
                this._dragging = false;
                this._scheduleUpdate();
            }, this);
        global.display.connectObject('workareas-changed',
            this._dock_refresh.bind(this), this);
        Main.layoutManager.connectObject('monitors-changed',
            this._dock_refresh.bind(this), this);

        // The native Dash adjusts icon size lazily; reposition the dock and
        // recompute overlap because its height can change.
        const onSizeChanged = () => {
            this._dock_reposition();
            this._scheduleUpdate();
        };
        this.connectObject('icon-size-changed', onSizeChanged,
            'notify::height', onSizeChanged,
            'notify::allocation', () => {
                this._dockAllocated = true;
                this._scheduleStruts();
                this._scheduleMinimizeGeometryUpdate();
            }, this);

        Main.layoutManager.connectObject('startup-complete', () => {
            this._scheduleStruts();
            this._scheduleMinimizeGeometryUpdate();
        }, this);

        // Like Dash to Dock: keep our dock visible in the overview and hide
        // the native dash instead. The same actor serves both states, so
        // there is nothing to swap and no flicker.
        this._oldDash = Main.overview.dash;
        if (this._oldDash) {
            this._oldDash.connectObject('destroy', () => {
                this._oldDash = null;
            }, this);
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
        global.workspace_manager.connectObject(
            'active-workspace-changed', () => this._scheduleUpdate(),
            'showing-desktop-changed', () => this._scheduleUpdate(), this);

        this._settings.connectObject('changed::autohide-mode',
            () => this._onModeChanged(), this);
        this._settings.connectObject('changed::dock-icon-size',
            () => this._adjustIconSize(), this);
        this._settings.connectObject('changed::show-trash',
            () => this._updateTrashVisibility(), this);

        this._initTrash();

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
                this._iconGeometry.delete(actor.meta_window);
                this._windowActors.delete(actor);
                this._scheduleUpdate();
            }, this);
    }

    _scheduleMinimizeGeometryUpdate() {
        if (!this._dockAllocated || this._iconGeometryTimeoutId ||
            Main.layoutManager._startingUp)
            return;

        this._iconGeometryTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, ICON_GEOMETRY_DELAY, () => {
                this._iconGeometryTimeoutId = 0;
                this._updateMinimizeGeometry();
                return GLib.SOURCE_REMOVE;
            });
    }

    _updateMinimizeGeometry() {
        if (!this._box || !this.mapped)
            return;
        if (this._box.get_width?.() === 0 || this._box.get_height?.() === 0)
            return;

        const hiddenOffset = this._hidden ? this.translation_y : 0;
        const targets = new Map();
        for (const item of this._box.get_children()) {
            const appIcon = item.child;
            const icon = appIcon?.icon?.icon;
            if (!appIcon?.app || !icon || item.animatingOut)
                continue;
            if (!icon.mapped || icon.get_width() === 0 ||
                icon.get_height() === 0)
                continue;

            const [x, y] = icon.get_transformed_position();
            const [width, height] = icon.get_transformed_size();
            if (!width || !height)
                continue;

            targets.set(appIcon.app.get_id(), new Mtk.Rectangle({
                x: Math.round(x),
                y: Math.round(y - hiddenOffset),
                width: Math.round(width),
                height: Math.round(height),
            }));
        }

        const tracker = Shell.WindowTracker.get_default();
        for (const actor of global.get_window_actors()) {
            const window = actor.meta_window;
            const app = window && tracker.get_window_app(window);
            const geometry = app && targets.get(app.get_id());
            if (!geometry)
                continue;

            if (!this._iconGeometry.has(window)) {
                const [success, original] = window.get_icon_geometry();
                this._iconGeometry.set(window, success ? {
                    x: original.x,
                    y: original.y,
                    width: original.width,
                    height: original.height,
                } : null);
            }
            window.set_icon_geometry(geometry);
        }
    }

    _redisplay() {
        const box = this._box;
        const oldWidth = box?.get_width?.() ?? 0;
        const animate = oldWidth > 0 && box?.set_width && !Main.overview.visible;

        // The dash container and its background follow the box width, so
        // animating the box alone resizes the whole dock smoothly.
        if (animate) {
            box.remove_all_transitions();
            box.set_width(oldWidth);
        }

        super._redisplay();

        if (animate) {
            box.set_width(-1);
            const [, target] = box.get_preferred_width(-1);
            this._animateDockWidth(oldWidth, target);
        }

        this._scheduleMinimizeGeometryUpdate();
    }

    _animateDockWidth(oldWidth, newWidth) {
        const box = this._box;
        if (!box || oldWidth <= 0 || newWidth <= 0 || newWidth === oldWidth) {
            box?.set_width(-1);
            return;
        }

        box.set_width(oldWidth);
        box.ease({
            width: newWidth,
            duration: ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                box.set_width(-1);
                this._scheduleMinimizeGeometryUpdate();
            },
        });
    }

    // The native Dash derives the icon size from the dock height and stops at
    // 64 px. A fixed setting bypasses that ceiling; 0 falls back to native sizing.
    _adjustIconSize() {
        const size = this._settings.get_int('dock-icon-size');
        if (size < 8) {
            super._adjustIconSize();
            return;
        }

        if (size === this.iconSize)
            return;

        this.iconSize = size;
        for (const item of this._box.get_children()) {
            item.child?._delegate?.icon?.setIconSize(size);
        }
        this._showAppsIcon?.icon?.setIconSize(size);
        this._trashItem?.setIconSize(size);
        if (this._trashSeparator)
            this._trashSeparator.height = size;
        if (this._separator)
            this._separator.height = size;

        this.emit('icon-size-changed');
    }

    _createAppItem(app) {
        const item = super._createAppItem(app);
        // Like Dash to Dock: horizontal dock items must not expand, or the
        // width animation stretches their cells and the icons slide over
        // each other while the dock shrinks.
        item.x_expand = false;
        return item;
    }

    _initTrash() {
        this._trashItem = new TrashItem(this.iconSize);
        this._trashItem.button.connect('clicked', () => this._openTrash());
        this._trashItem.button.connect('popup-menu', () => this._trashMenu.toggle());
        this._hookUpLabel(this._trashItem);

        this._trashSeparator = new St.Widget({
            style_class: 'dash-separator',
            y_align: Clutter.ActorAlign.CENTER,
            height: this.iconSize,
        });
        this._trashSeparator.set_style('margin-bottom: 0;');

        this._dashContainer.add_child(this._trashSeparator);
        this._dashContainer.add_child(this._trashItem);
        this._trashItem.show(false);
        // Keep Show Apps as the last icon; utilities sit just before it.
        this._dashContainer.set_child_at_index(
            this._showAppsIcon,
            this._dashContainer.get_children().length - 1);

        this._trashMenu = new PopupMenu.PopupMenu(
            this._trashItem.button, 0.5, St.Side.BOTTOM);
        this._trashMenu.actor.hide();
        Main.uiGroup.add_child(this._trashMenu.actor);

        this._trashMenuManager =
            new PopupMenu.PopupMenuManager(this._trashItem.button);
        this._trashMenuManager.addMenu(this._trashMenu);

        const openItem = new PopupMenu.PopupMenuItem('Open Trash');
        openItem.connect('activate', () => this._openTrash());
        this._trashMenu.addMenuItem(openItem);

        this._emptyTrashMenuItem = new PopupMenu.PopupMenuItem('Empty Trash');
        this._emptyTrashMenuItem.connect('activate', () => this._emptyTrash());
        this._trashMenu.addMenuItem(this._emptyTrashMenuItem);

        this._trashMenu.connect('open-state-changed', (menu, open) =>
            this._itemMenuStateChanged(this._trashItem, open));

        const rightClick = new Clutter.ClickGesture({
            required_button: Clutter.BUTTON_SECONDARY,
            recognize_on_press: true,
        });
        rightClick.connect('recognize', () => this._trashMenu.toggle());
        this._trashItem.button.add_action(rightClick);

        this._trash = Gio.File.new_for_uri(TRASH_URI);
        this._trashMonitor = null;
        this._trashMonitorChangedId = 0;
        this._trashUpdateTimeoutId = 0;
        this._emptyTrashDialog = null;
        try {
            this._trashMonitor = this._trash.monitor_directory(
                Gio.FileMonitorFlags.NONE, null);
            this._trashMonitorChangedId = this._trashMonitor.connect(
                'changed', () => this._scheduleTrashUpdate());
        } catch (e) {
            logError(e, 'Unable to monitor the Trash');
        }

        this._updateTrash();
        this._updateTrashVisibility();
    }

    _updateTrashVisibility() {
        const visible = this._settings.get_boolean('show-trash');
        this._trashItem.visible = visible;
        this._trashSeparator.visible = visible;
        if (!visible)
            this._trashMenu.close();
    }

    _scheduleTrashUpdate() {
        if (!this._trashItem || this._trashUpdateTimeoutId)
            return;

        this._trashUpdateTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, TRASH_UPDATE_DELAY, () => {
                this._trashUpdateTimeoutId = 0;
                this._updateTrash();
                return GLib.SOURCE_REMOVE;
            });
    }

    _updateTrash() {
        if (!this._trashItem)
            return;

        let count = 0;
        try {
            const info = this._trash.query_info(
                Gio.FILE_ATTRIBUTE_TRASH_ITEM_COUNT,
                Gio.FileQueryInfoFlags.NONE, null);
            count = info.get_attribute_uint32(
                Gio.FILE_ATTRIBUTE_TRASH_ITEM_COUNT);
        } catch (e) {
            logError(e, 'Unable to read the Trash');
        }

        this._trashItem.setIconName(
            count > 0 ? 'user-trash-full' : 'user-trash');
        this._emptyTrashMenuItem.setSensitive(count > 0);
    }

    _openTrash() {
        if (Main.overview.visible)
            Main.overview.hide();
        Gio.AppInfo.launch_default_for_uri(TRASH_URI,
            global.create_app_launch_context(0, -1));
    }

    _emptyTrash() {
        if (this._emptyTrashDialog)
            return;

        const dialog = new ModalDialog.ModalDialog();
        this._emptyTrashDialog = dialog;
        dialog.connect('closed', () => {
            if (this._emptyTrashDialog === dialog)
                this._emptyTrashDialog = null;
        });

        dialog.contentLayout.add_child(new St.Label({
            text: 'Permanently delete all items in the Trash?',
            style_class: 'message-dialog-description',
        }));

        dialog.addButton({
            label: 'Cancel',
            default: true,
            action: () => dialog.close(),
        });
        dialog.addButton({
            label: 'Empty Trash',
            action: () => {
                dialog.close();
                this._doEmptyTrash();
            },
        });
        dialog.open();
    }

    _doEmptyTrash() {
        try {
            const proc = Gio.Subprocess.new(
                ['gio', 'trash', '--empty'], Gio.SubprocessFlags.NONE);
            proc.wait_check_async(null, (p, result) => {
                try {
                    p.wait_check_finish(result);
                } catch (e) {
                    logError(e, 'Unable to empty the Trash');
                    Main.notify('Could not empty the Trash',
                        'Open it and empty it manually.');
                }
                this._scheduleTrashUpdate();
            });
        } catch (e) {
            logError(e, 'Unable to empty the Trash');
            Main.notify('Could not empty the Trash',
                'Open it and empty it manually.');
        }
    }

    _currentMode() {
        return this._settings.get_string('autohide-mode');
    }

    _scheduleStruts() {
        if (!this._dockAllocated || this._strutTimeoutId ||
            Main.layoutManager._startingUp)
            return;

        this._strutTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, ICON_GEOMETRY_DELAY, () => {
                this._strutTimeoutId = 0;
                this._syncStruts();
                return GLib.SOURCE_REMOVE;
            });
    }

    _syncStruts() {
        if (!this._dockAllocated)
            return;

        const affectsStruts = this._currentMode() === Mode.OFF;
        if (this._strutEnabled === affectsStruts)
            return;

        Main.layoutManager.untrackChrome(this);
        Main.layoutManager.trackChrome(this, {affectsStruts});
        this._strutEnabled = affectsStruts;
    }

    _onModeChanged() {
        this._scheduleStruts();

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
            this._previewOpen || this._keep_dock_shown || this._dragging)
            return true;

        if (mode === Mode.INTELLIGENT)
            return !this._hasOverlap();

        return false; // Mode.ON
    }

    // Keeps the dock on screen while a window preview is open, so the
    // popup is not left floating over an empty edge.
    setPreviewOpen(open) {
        if (this._previewOpen === open)
            return;

        this._previewOpen = open;
        if (open) {
            this._cancelUpdate();
            this._updateVisibility(true);
        } else {
            this._scheduleUpdate();
        }
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

        this.show();
        this._hidden = false;
        this.remove_all_transitions();

        if (animate && this.get_stage()) {
            this.ease({
                translation_y: 0,
                duration: ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => this._scheduleMinimizeGeometryUpdate(),
            });
        } else {
            this.translation_y = 0;
            this._scheduleMinimizeGeometryUpdate();
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
                onStopped: () => {
                    if (this._hidden)
                        this.hide();
                },
            });
        } else {
            this.translation_y = height + 8;
            this.hide();
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
            if (!window)
                continue;

            const type = window.get_window_type();
            if (type !== Meta.WindowType.NORMAL &&
                type !== Meta.WindowType.DIALOG &&
                type !== Meta.WindowType.MODAL_DIALOG)
                continue;
            if (!window.showing_on_its_workspace() || window.is_skip_taskbar())
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

        this._scheduleMinimizeGeometryUpdate();
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
        if (this._dragging && !this._dragCancelled)
            this._endItemDrag();
        this._dragging = false;

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

        if (this._iconGeometryTimeoutId) {
            GLib.source_remove(this._iconGeometryTimeoutId);
            this._iconGeometryTimeoutId = 0;
        }
        if (this._strutTimeoutId) {
            GLib.source_remove(this._strutTimeoutId);
            this._strutTimeoutId = 0;
        }

        for (const [window, geometry] of this._iconGeometry) {
            window.set_icon_geometry(
                geometry ? new Mtk.Rectangle(geometry) : null);
        }
        this._iconGeometry.clear();

        this._cancelUpdate();

        if (this._showLabelTimeoutId > 0) {
            GLib.source_remove(this._showLabelTimeoutId);
            this._showLabelTimeoutId = 0;
        }
        if (this._resetHoverTimeoutId > 0) {
            GLib.source_remove(this._resetHoverTimeoutId);
            this._resetHoverTimeoutId = 0;
        }

        if (this._trashUpdateTimeoutId) {
            GLib.source_remove(this._trashUpdateTimeoutId);
            this._trashUpdateTimeoutId = 0;
        }
        if (this._trashMonitor) {
            if (this._trashMonitorChangedId)
                this._trashMonitor.disconnect(this._trashMonitorChangedId);
            this._trashMonitor.cancel();
            this._trashMonitor = null;
            this._trashMonitorChangedId = 0;
        }
        this._trashMenu?.destroy();
        this._trashMenu = null;
        this._trashMenuManager = null;
        this._emptyTrashDialog?.destroy();
        this._emptyTrashDialog = null;
        this._trashItem?.destroy();
        this._trashItem = null;
        this._trashSeparator?.destroy();
        this._trashSeparator = null;

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
            } else if (Main.overview.visible) {
                this.app.activate();
                Main.overview.hide();
            } else {
                const activeWorkspace = global.workspace_manager.get_active_workspace();
                let app_windows = this.app
                    .get_windows()
                    .filter(window => !window.is_override_redirect() && !window.is_attached_dialog() && window.located_on_workspace(activeWorkspace))
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
                    default: {
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

    // The Dash shows the app name under a hovered icon; with a preview popup
    // that label would sit behind it.
    _modify_native_tooltip_behavior() {
        this.original_should_show_tooltip =
            AppDisplay.AppIcon.prototype.shouldShowTooltip;
        const original = this.original_should_show_tooltip;

        AppDisplay.AppIcon.prototype.shouldShowTooltip = function() {
            if (this instanceof Dash.DashIcon &&
                this.app.get_windows().some(window => !window.is_skip_taskbar()))
                return false;
            return original.call(this);
        };
    }

    enable() {
        this._settings = this.getSettings();
        this._modify_native_click_behavior();
        this._modify_native_tooltip_behavior();

        this._dock = new Dock(this._settings);
        this._dock.connectObject('destroy', () => {
            this._dock = null;
        }, this);

        this._preview = new WindowPreview(this._dock);
        this._preview.enable();

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
        AppDisplay.AppIcon.prototype.shouldShowTooltip =
            this.original_should_show_tooltip;

        Main.layoutManager.disconnectObject(this);

        this._preview?.destroy();
        this._preview = null;

        this._dock?.destroy();
        this._dock = null;
        this._settings = null;
    }
}
