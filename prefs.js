// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SWITCHES = [
    ['remember-state', 'Remember mute state across logins', 'When off, every login starts unmuted'],
    ['show-indicator', 'Show panel indicator', 'Click the icon to toggle mute'],
    ['show-osd', 'Show on-screen display', 'When a shortcut or click changes the state'],
];

const SHORTCUTS = [
    ['toggle-shortcut', 'Toggle'],
    ['mute-shortcut', 'Mute'],
    ['unmute-shortcut', 'Unmute'],
];

export default class GlobalMicMutePrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();

        const behavior = new Adw.PreferencesGroup({ title: 'Behavior' });
        for (const [key, title, subtitle] of SWITCHES) {
            const row = new Adw.SwitchRow({ title, subtitle });
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            behavior.add(row);
        }
        page.add(behavior);

        const shortcuts = new Adw.PreferencesGroup({
            title: 'Shortcuts',
            description: 'GTK accelerator syntax, e.g. <Super>m. Leave a field empty to disable it, then press Enter or the apply button.',
        });
        for (const [key, title] of SHORTCUTS) {
            const row = new Adw.EntryRow({
                title,
                show_apply_button: true,
                text: settings.get_strv(key)[0] ?? '',
            });
            row.connect('apply', () => {
                const text = row.text.trim();
                if (text === '') {
                    row.remove_css_class('error');
                    settings.set_strv(key, []);
                    return;
                }
                const [ok, keyval, mods] = Gtk.accelerator_parse(text);
                if (!ok || keyval === 0) {
                    row.add_css_class('error');
                    return;
                }
                row.remove_css_class('error');
                const accel = Gtk.accelerator_name(keyval, mods);
                row.text = accel;
                settings.set_strv(key, [accel]);
            });
            shortcuts.add(row);
        }
        page.add(shortcuts);

        window.add(page);
    }
}
