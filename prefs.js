// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SWITCHES = [
    ['remember-state', 'Remember mute state across logins', 'When off, every login starts unmuted'],
    ['show-indicator', 'Show panel indicator', 'Click the icon to toggle mute'],
    ['show-osd', 'Show on-screen display', 'When a shortcut or click changes the state'],
];

const UNMUTE_SCOPES = [
    ['all', 'All microphones', 'Microphones that appear later also follow the unmute'],
    ['active', 'Active microphone only', 'Only the microphone selected in Sound settings'],
];

const SHORTCUTS = [
    ['toggle-shortcut', 'Toggle'],
    ['mute-shortcut', 'Mute'],
    ['unmute-shortcut', 'Unmute'],
];

// Opens a dialog that captures the next key combination. Calls done(accel),
// where accel is a GTK accelerator string, '' to clear, or null on cancel.
function captureShortcut(parent, title, done) {
    const page = new Adw.StatusPage({
        icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
        title: `Press a shortcut for “${title}”`,
        description: 'Esc to cancel · Backspace to disable this shortcut',
    });
    const dialog = new Adw.Dialog({
        title: 'Set Shortcut',
        content_width: 420,
        child: page,
    });

    let finished = false;
    const finish = accel => {
        if (finished)
            return;
        finished = true;
        dialog.close();
        done(accel);
    };

    const keys = new Gtk.EventControllerKey();
    keys.connect('key-pressed', (_c, keyval, _keycode, state) => {
        const mods = state & Gtk.accelerator_get_default_mod_mask();
        const key = Gdk.keyval_to_lower(keyval);

        if (mods === 0 && key === Gdk.KEY_Escape) {
            finish(null);
            return Gdk.EVENT_STOP;
        }
        if (mods === 0 && key === Gdk.KEY_BackSpace) {
            finish('');
            return Gdk.EVENT_STOP;
        }
        // Wait for a real key: modifier-only presses and invalid combos are
        // ignored, and a bare printable key would hijack normal typing.
        if (!Gtk.accelerator_valid(key, mods))
            return Gdk.EVENT_STOP;
        if (mods === 0 && Gdk.keyval_to_unicode(key) !== 0)
            return Gdk.EVENT_STOP;

        finish(Gtk.accelerator_name(key, mods));
        return Gdk.EVENT_STOP;
    });
    dialog.add_controller(keys);
    dialog.connect('closed', () => finish(null));
    dialog.present(parent);
}

export default class GlobalMicMutePrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const settingsIds = [];
        const page = new Adw.PreferencesPage();

        // --- behavior ------------------------------------------------------
        const behavior = new Adw.PreferencesGroup({ title: 'Behavior' });

        const scopeRow = new Adw.ComboRow({
            title: 'Unmute applies to',
            subtitle: 'Mute always applies to every microphone',
            model: Gtk.StringList.new(UNMUTE_SCOPES.map(([, label]) => label)),
        });
        const syncScope = () => {
            const i = UNMUTE_SCOPES.findIndex(([v]) => v === settings.get_string('unmute-scope'));
            scopeRow.selected = Math.max(0, i);
            scopeRow.subtitle = UNMUTE_SCOPES[scopeRow.selected][2];
        };
        syncScope();
        scopeRow.connect('notify::selected', () => {
            const value = UNMUTE_SCOPES[scopeRow.selected][0];
            if (settings.get_string('unmute-scope') !== value)
                settings.set_string('unmute-scope', value);
            scopeRow.subtitle = UNMUTE_SCOPES[scopeRow.selected][2];
        });
        settingsIds.push(settings.connect('changed::unmute-scope', syncScope));
        behavior.add(scopeRow);

        for (const [key, title, subtitle] of SWITCHES) {
            const row = new Adw.SwitchRow({ title, subtitle });
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            behavior.add(row);
        }
        page.add(behavior);

        // --- shortcuts -----------------------------------------------------
        const shortcuts = new Adw.PreferencesGroup({
            title: 'Shortcuts',
            description: 'Click a shortcut to change it. Use any combination; a disabled shortcut does nothing.',
        });
        for (const [key, title] of SHORTCUTS) {
            const label = new Gtk.ShortcutLabel({
                disabled_text: 'Disabled',
                valign: Gtk.Align.CENTER,
            });
            const sync = () => {
                label.accelerator = settings.get_strv(key)[0] ?? '';
            };
            sync();
            settingsIds.push(settings.connect(`changed::${key}`, sync));

            const row = new Adw.ActionRow({ title, activatable: true });
            row.add_suffix(label);
            row.connect('activated', () => {
                captureShortcut(window, title, accel => {
                    if (accel !== null)
                        settings.set_strv(key, accel ? [accel] : []);
                });
            });
            shortcuts.add(row);
        }
        page.add(shortcuts);

        window.add(page);
        window.connect('close-request', () => {
            for (const id of settingsIds)
                settings.disconnect(id);
            return false;
        });
    }
}
