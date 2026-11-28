import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const MODES = ['on', 'intelligent', 'off'];
const LABELS = [
    'Always',
    'When a window overlaps',
    'Never',
];
// Standard icon sizes, same ladder Dash to Dock marks on its slider.
const ICON_SIZE_MARKS = [8, 16, 24, 32, 48, 64, 96, 128];
const SCALE_UPDATE_TIMEOUT = 250;

export default class MuellePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        const group = new Adw.PreferencesGroup({
            title: 'Dock Behavior',
        });

        const model = new Gtk.StringList();
        for (const label of LABELS)
            model.append(label);

        const row = new Adw.ComboRow({
            title: 'Auto-hide',
            model,
        });

        row.selected = Math.max(0, MODES.indexOf(settings.get_string('autohide-mode')));
        row.connect('notify::selected', () => {
            settings.set_string('autohide-mode', MODES[row.selected]);
        });

        group.add(row);

        const sizeRow = new Adw.ActionRow({
            title: 'Dock icon size',
            subtitle: 'Drag to resize the dock icons',
        });
        const sizeScale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: new Gtk.Adjustment({
                lower: ICON_SIZE_MARKS[0],
                upper: ICON_SIZE_MARKS[ICON_SIZE_MARKS.length - 1],
                step_increment: 1,
                page_increment: 10,
                value: settings.get_int('dock-icon-size'),
            }),
            hexpand: true,
            width_request: 340,
            valign: Gtk.Align.CENTER,
        });
        for (const size of ICON_SIZE_MARKS)
            sizeScale.add_mark(size, Gtk.PositionType.TOP, `${size}`);

        // Debounce like Dash to Dock: resizing every icon on each pixel of
        // drag spams relayouts and floods the log with Clutter warnings.
        let sizeTimeout = 0;
        sizeScale.connect('value-changed', () => {
            if (sizeTimeout)
                GLib.source_remove(sizeTimeout);
            sizeTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SCALE_UPDATE_TIMEOUT, () => {
                settings.set_int('dock-icon-size', Math.round(sizeScale.get_value()));
                sizeTimeout = 0;
                return GLib.SOURCE_REMOVE;
            });
        });
        sizeScale.connect('destroy', () => {
            if (sizeTimeout) {
                GLib.source_remove(sizeTimeout);
                sizeTimeout = 0;
            }
        });

        sizeRow.add_suffix(sizeScale);
        group.add(sizeRow);

        const previewsRow = new Adw.SwitchRow({
            title: 'Window previews',
            subtitle: 'Show window thumbnails when hovering a dock icon',
        });
        previewsRow.active = settings.get_boolean('show-window-previews');
        previewsRow.connect('notify::active', () => {
            settings.set_boolean('show-window-previews', previewsRow.active);
        });
        group.add(previewsRow);

        page.add(group);

        const itemsGroup = new Adw.PreferencesGroup({
            title: 'Dock Items',
        });
        const trashRow = new Adw.SwitchRow({
            title: 'Show Trash',
            subtitle: 'Add a Trash item at the end of the dock',
        });
        trashRow.active = settings.get_boolean('show-trash');
        trashRow.connect('notify::active', () => {
            settings.set_boolean('show-trash', trashRow.active);
        });
        itemsGroup.add(trashRow);
        page.add(itemsGroup);

        window.add(page);
    }
}
