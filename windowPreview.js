/*
    Window preview popup for Muelle.

    Ported and trimmed from Dock Window Preview, GPL-3.0:
    https://github.com/teerprah/dock-window-preview
    Copyright (C) Dock Window Preview contributors.

    Only shows a thumbnail row while hovering a dock icon; clicking a
    thumbnail activates that window.

    shortcut: open windows are read when the popup is shown only. Windows
    opened or closed while it is visible appear on the next hover.
*/

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const POINTER_POLL_MS = 90;
const SHOW_DELAY_MS = 250;
const HIDE_DELAY_MS = 240;
const THUMB_WIDTH = 200;
const THUMB_HEIGHT = 120;
const ITEM_PADDING = 6; // .dock-preview-item padding, per side
const POPUP_MARGIN = 16;
const ITEM_SPACING = 8;


export default class WindowPreview {
    constructor(dock) {
        this._dock = dock;
        this._pollId = 0;
        this._showId = 0;
        this._hideId = 0;
        this._keyId = 0;
        this._hovered = null;

        this._content = new St.BoxLayout({
            style_class: 'popup-menu-content dock-preview-content',
            orientation: Clutter.Orientation.VERTICAL,
        });

        // Same skin and arrow as native menus; the arrow points at the icon.
        this._popup = new BoxPointer.BoxPointer(St.Side.BOTTOM);
        this._popup.style_class = 'popup-menu-boxpointer';
        this._popup.add_style_class_name('popup-menu');
        this._popup.bin.set_child(this._content);
        Main.layoutManager.addTopChrome(this._popup);
        this._popup.hide();

        // The shell destroys chrome actors with the stage on shutdown; drop
        // our reference so teardown does not touch a disposed actor.
        this._popup.connect('destroy', () => {
            this._popup = null;
            this._content = null;
        });

        // The shell may destroy our dock before disable() runs.
        dock.connect('destroy', () => {
            this._dock = null;
        });
    }

    enable() {
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POINTER_POLL_MS, () => {
            this._poll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    destroy() {
        this._cancelShow();
        this._cancelHide();
        this._disconnectKey();

        if (this._pollId) {
            GLib.Source.remove(this._pollId);
            this._pollId = 0;
        }

        // The dock is destroyed right after this, or already gone on shutdown;
        // do not touch it here.
        this._dock = null;
        this._hovered = null;

        const popup = this._popup;
        this._popup = null;
        this._content = null;

        if (!popup)
            return;

        // On shell shutdown the popup may already be disposed with the stage.
        try {
            Main.layoutManager.removeChrome(popup);
            popup.destroy();
        } catch (_e) {
            // ignore teardown of an already disposed actor
        }
    }

    _poll() {
        if (!this._popup || !this._dock)
            return;

        // Nothing to pick while the dock is off screen and no preview is open.
        if (!this._popup.visible && !this._dock.visible)
            return;

        const [x, y] = global.get_pointer();
        const actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);

        if (this._popup.visible && actor && this._popup.contains(actor)) {
            this._cancelHide();
            return;
        }

        const icon = this._findIcon(actor);
        if (icon) {
            this._cancelHide();
            if (icon !== this._hovered) {
                this._hovered = icon;
                this._scheduleShow(icon);
            }
            return;
        }

        this._hovered = null;
        this._cancelShow();
        this._scheduleHide();
    }

    // Only icons that belong to our dock; the Trash item has no `.app`.
    _findIcon(actor) {
        for (let current = actor; current; current = current.get_parent()) {
            const delegate = current._delegate;
            if (delegate?.app && this._dock.contains(current))
                return delegate;
        }
        return null;
    }

    _scheduleShow(icon) {
        this._cancelShow();
        this._cancelHide();

        this._showId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SHOW_DELAY_MS, () => {
            this._showId = 0;
            if (this._hovered !== icon)
                return GLib.SOURCE_REMOVE;

            const windows = this._windowsFor(icon.app);
            if (windows.length > 0)
                this.show(icon, windows);

            return GLib.SOURCE_REMOVE;
        });
    }

    _windowsFor(app) {
        return app.get_windows()
            .filter(window => !window.is_skip_taskbar())
            .sort((left, right) => right.get_user_time() - left.get_user_time());
    }

    _scheduleHide() {
        if (this._hideId || !this._popup?.visible)
            return;

        this._hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HIDE_DELAY_MS, () => {
            this._hideId = 0;
            this.hide();
            return GLib.SOURCE_REMOVE;
        });
    }

    show(icon, windows) {
        if (!this._dock || !this._popup || !this._content)
            return;

        this._clearContent();

        this._content.add_child(new St.Label({
            style_class: 'dock-preview-header',
            text: icon.app.get_name(),
            x_align: Clutter.ActorAlign.START,
        }));

        const row = new St.BoxLayout({
            style_class: 'dock-preview-items',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });
        this._content.add_child(row);

        // Shrink thumbnails so the row stays inside the monitor. Each item also
        // adds its own padding, so subtract it; clamp so it never collapses.
        const monitor = Main.layoutManager.primaryMonitor;
        const count = windows.length;
        const available = monitor.width - 2 * POPUP_MARGIN -
            (count - 1) * ITEM_SPACING;
        const width = Math.max(96, Math.floor(Math.min(THUMB_WIDTH,
            available / count - 2 * ITEM_PADDING)));

        for (const window of windows)
            row.add_child(this._createItem(window, icon.app, width));

        this._popup.setPosition(icon, 0.5);
        if (this._popup.visible)
            this._popup.queue_relayout();
        else
            this._popup.open(BoxPointer.PopupAnimation.FULL);

        this._connectKey();
        this._dock.setPreviewOpen(true);
    }

    hide(immediate = false) {
        this._cancelShow();
        this._cancelHide();
        this._disconnectKey();
        this._dock?.setPreviewOpen(false);

        if (!this._popup)
            return;

        if (immediate || !this._popup.visible) {
            this._popup.remove_all_transitions();
            this._popup.close(false);
            this._clearContent();
        } else {
            this._popup.close(BoxPointer.PopupAnimation.FULL,
                () => this._clearContent());
        }
    }

    _createItem(window, app, width) {
        const button = new St.Button({
            style_class: 'dock-preview-item',
            reactive: true,
            can_focus: true,
            track_hover: true,
        });

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        box.add_child(this._createThumbnail(window, app, width));
        box.add_child(this._createTitle(window, app, width));

        button.set_child(box);
        button.connect('clicked', () => {
            this.hide(true);
            Main.activateWindow(window);
        });

        return button;
    }

    _createTitle(window, app, width) {
        const label = new St.Label({
            style_class: 'dock-preview-title',
            text: window.get_title() || app.get_name(),
        });
        label.set_width(width);

        const text = label.clutter_text;
        text.single_line_mode = true;
        text.line_wrap = false;
        text.ellipsize = Pango.EllipsizeMode.END;
        return label;
    }

    _createThumbnail(window, app, width) {
        const thumbnail = new St.Widget({
            style_class: 'dock-preview-thumb',
            layout_manager: new Clutter.BinLayout(),
        });
        thumbnail.set_size(width, THUMB_HEIGHT);

        const windowActor = window.get_compositor_private();
        if (windowActor) {
            const [sourceWidth, sourceHeight] = windowActor.get_size();
            const scale = Math.min(
                width / Math.max(1, sourceWidth),
                THUMB_HEIGHT / Math.max(1, sourceHeight),
                1
            );
            thumbnail.add_child(new Clutter.Clone({
                source: windowActor,
                reactive: false,
                width: Math.floor(sourceWidth * scale),
                height: Math.floor(sourceHeight * scale),
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        } else {
            const icon = app.create_icon_texture(72);
            icon.x_align = Clutter.ActorAlign.CENTER;
            icon.y_align = Clutter.ActorAlign.CENTER;
            thumbnail.add_child(icon);
        }

        return thumbnail;
    }

    _connectKey() {
        if (this._keyId)
            return;

        this._keyId = global.stage.connect('key-press-event', (_stage, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;

            this.hide();
            return Clutter.EVENT_STOP;
        });
    }

    _disconnectKey() {
        if (!this._keyId)
            return;
        global.stage.disconnect(this._keyId);
        this._keyId = 0;
    }

    _clearContent() {
        if (!this._content)
            return;
        for (const child of this._content.get_children())
            child.destroy();
    }

    _cancelShow() {
        if (!this._showId)
            return;
        GLib.Source.remove(this._showId);
        this._showId = 0;
    }

    _cancelHide() {
        if (!this._hideId)
            return;
        GLib.Source.remove(this._hideId);
        this._hideId = 0;
    }
}
