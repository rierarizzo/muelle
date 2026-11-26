import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const MODES = ['on', 'intelligent', 'off'];
const LABELS = [
    'Always',
    'When a window overlaps',
    'Never',
];

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
        page.add(group);
        window.add(page);
    }
}
