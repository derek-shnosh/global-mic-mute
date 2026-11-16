// SPDX-License-Identifier: GPL-2.0-or-later
// Global Mic Mute: mute every microphone at once and keep it that way.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Gvc from 'gi://Gvc';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const SHORTCUTS = ['toggle-shortcut', 'mute-shortcut', 'unmute-shortcut'];
const ICON_MUTED = 'microphone-sensitivity-muted-symbolic';
const ICON_LIVE = 'microphone-sensitivity-high-symbolic';
const LIVE_STYLE = 'color: #ff6b6b;';

function isMonitor(stream) {
    return (stream.get_name() ?? '').endsWith('.monitor');
}

// pa_port_available_t: 0 = unknown, 1 = no, 2 = yes.
const PORT_AVAILABLE_NO = 1;

export default class GlobalMicMuteExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._muted = this._settings.get_boolean('remember-state') &&
            this._settings.get_boolean('muted');
        this._settings.set_boolean('muted', this._muted);

        // Map<Gvc.MixerSource, handlerId[]>
        this._sources = new Map();

        this._mixer = new Gvc.MixerControl({ name: this.metadata.name });
        this._mixerIds = [
            this._mixer.connect('state-changed', (_c, state) => {
                if (state === Gvc.MixerControlState.READY)
                    this._syncSources();
            }),
            this._mixer.connect('stream-added', () => this._syncSources()),
            this._mixer.connect('stream-removed', () => this._syncSources()),
        ];
        this._mixer.open();

        for (const name of SHORTCUTS) {
            Main.wm.addKeybinding(
                name,
                this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.ALL,
                () => this._onShortcut(name));
        }

        this._settingsIds = [
            this._settings.connect('changed::show-indicator', () => this._syncIndicator()),
        ];
        this._sessionId = Main.sessionMode.connect('updated', () => this._syncIndicator());

        this._indicator = null;
        this._syncIndicator();
        this._syncSources();
    }

    disable() {
        // Mute state is deliberately left as-is: disabling the extension while
        // muted must not suddenly make microphones live.
        for (const name of SHORTCUTS)
            Main.wm.removeKeybinding(name);

        Main.sessionMode.disconnect(this._sessionId);
        this._sessionId = 0;

        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = null;

        this._disconnectSources();
        this._sources = null;

        for (const id of this._mixerIds)
            this._mixer.disconnect(id);
        this._mixerIds = null;
        this._mixer.close();
        this._mixer = null;

        this._destroyIndicator();
        this._settings = null;
    }

    // --- intent ------------------------------------------------------------

    _onShortcut(name) {
        if (name === 'toggle-shortcut')
            this._setMuted(!this._muted);
        else
            this._setMuted(name === 'mute-shortcut');
    }

    _setMuted(muted) {
        this._muted = muted;
        this._settings.set_boolean('muted', muted);
        for (const s of this._usableSources()) {
            if (s.is_muted !== muted)
                s.change_is_muted(muted);
        }
        this._updateIcon();
        if (this._settings.get_boolean('show-osd'))
            this._showOsd();
    }

    // --- sources -----------------------------------------------------------

    // A source whose active port is "not available" (e.g. an empty mic jack)
    // cannot capture and cannot hold a mute state, so it is ignored everywhere.
    // The stream port's own 'available' flag folds "unknown" into false, so
    // the raw three-state value is read from the card's port list instead.
    _hasUsablePort(stream) {
        try {
            const port = stream.get_port();
            if (!port)
                return true;
            const card = this._mixer.lookup_card_id(stream.get_card_index());
            const cardPort = card?.get_ports().find(cp => cp.port === port.port);
            return cardPort?.available !== PORT_AVAILABLE_NO;
        } catch {
            return true;
        }
    }

    _usableSources() {
        return [...this._sources.keys()].filter(s => this._hasUsablePort(s));
    }

    _syncSources() {
        this._disconnectSources();
        for (const s of this._mixer.get_sources()) {
            if (isMonitor(s))
                continue;
            const onChange = () => {
                this._enforce(s);
                this._updateIcon();
            };
            this._sources.set(s, [
                s.connect('notify::is-muted', onChange),
                s.connect('notify::port', onChange),
            ]);
            this._enforce(s);
        }
        this._updateIcon();
    }

    _disconnectSources() {
        for (const [s, ids] of this._sources) {
            for (const id of ids) {
                try {
                    s.disconnect(id);
                } catch { }
            }
        }
        this._sources.clear();
    }

    // While mute is on, any usable source that is (or becomes) live is
    // muted again: new devices, profile switches, or an app unmuting it.
    _enforce(stream) {
        if (this._muted && !stream.is_muted && this._hasUsablePort(stream))
            stream.change_is_muted(true);
    }

    _allMuted() {
        const usable = this._usableSources();
        return usable.length ? usable.every(s => s.is_muted) : this._muted;
    }

    // --- UI ----------------------------------------------------------------

    _syncIndicator() {
        const want = this._settings.get_boolean('show-indicator') &&
            !Main.sessionMode.isLocked;
        if (want && !this._indicator)
            this._createIndicator();
        else if (!want && this._indicator)
            this._destroyIndicator();
    }

    _createIndicator() {
        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, true);
        this._icon = new St.Icon({ style_class: 'system-status-icon' });
        this._indicator.add_child(this._icon);
        this._indicator.connect('button-press-event', () => {
            this._setMuted(!this._muted);
            return Clutter.EVENT_STOP;
        });
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._updateIcon();
    }

    _destroyIndicator() {
        this._indicator?.destroy();
        this._indicator = null;
        this._icon = null;
    }

    _updateIcon() {
        if (!this._icon)
            return;
        const allMuted = this._allMuted();
        this._icon.icon_name = allMuted ? ICON_MUTED : ICON_LIVE;
        this._icon.set_style(allMuted ? '' : LIVE_STYLE);
    }

    _showOsd() {
        const icon = Gio.ThemedIcon.new(this._allMuted() ? ICON_MUTED : ICON_LIVE);
        const mgr = Main.osdWindowManager;
        // GNOME 49 renamed show(monitorIndex, ...) to showAll(...).
        if (typeof mgr.showAll === 'function')
            mgr.showAll(icon, null, null, -1);
        else
            mgr.show(-1, icon, null, null, -1);
    }
}
