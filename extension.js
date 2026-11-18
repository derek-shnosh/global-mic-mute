// SPDX-License-Identifier: GPL-2.0-or-later
// Global Mic Mute: mute every microphone at once and keep it that way.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
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

// How long a newly appeared source keeps following an unmute. WirePlumber
// restores a route's saved mute state shortly after the node appears, so the
// unmute is re-applied for this window rather than only once.
const APPEAR_WINDOW_US = 3 * GLib.USEC_PER_SEC;

export default class GlobalMicMuteExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._muted = this._settings.get_boolean('remember-state') &&
            this._settings.get_boolean('muted');
        this._settings.set_boolean('muted', this._muted);

        // Map<Gvc.MixerSource, handlerId[]>
        this._sources = new Map();
        // Map<Gvc.MixerSource, monotonic time it appeared>, only for sources
        // that appeared after the initial sync (never those present at login).
        this._appearedAt = new Map();
        this._settled = false;

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
        this._appearedAt = null;

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

    _unmuteAll() {
        return this._settings.get_string('unmute-scope') === 'all';
    }

    _setMuted(muted) {
        this._muted = muted;
        this._settings.set_boolean('muted', muted);
        if (muted || this._unmuteAll()) {
            for (const s of this._usableSources()) {
                if (s.is_muted !== muted)
                    s.change_is_muted(muted);
            }
        } else {
            // Unmute scope 'active': only the default (selected) microphone.
            const active = this._mixer.get_default_source();
            if (active && this._sources.has(active) &&
                this._hasUsablePort(active) && active.is_muted)
                active.change_is_muted(false);
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
        const known = new Set(this._sources.keys());
        const now = GLib.get_monotonic_time();
        const appearedAt = new Map();

        this._disconnectSources();
        for (const s of this._mixer.get_sources()) {
            if (isMonitor(s))
                continue;
            if (known.has(s)) {
                if (this._appearedAt.has(s))
                    appearedAt.set(s, this._appearedAt.get(s));
            } else if (this._settled) {
                appearedAt.set(s, now);
            }
            const onChange = () => {
                this._applyIntent(s);
                this._updateIcon();
            };
            this._sources.set(s, [
                s.connect('notify::is-muted', onChange),
                s.connect('notify::port', onChange),
            ]);
        }
        this._appearedAt = appearedAt;

        for (const s of this._sources.keys())
            this._applyIntent(s);

        if (this._mixer.get_state() === Gvc.MixerControlState.READY)
            this._settled = true;
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

    _justAppeared(stream) {
        const t = this._appearedAt.get(stream);
        return t !== undefined && GLib.get_monotonic_time() - t < APPEAR_WINDOW_US;
    }

    // While mute is on, any usable source that is (or becomes) live is muted
    // again: new devices, profile switches, or an app unmuting it.
    // While mute is off with unmute scope 'all', a source that just appeared
    // (hotplug, profile switch) is unmuted to follow the others; sources are
    // otherwise left alone, so a single mic can still be muted by hand.
    _applyIntent(stream) {
        if (!this._hasUsablePort(stream))
            return;
        if (this._muted) {
            if (!stream.is_muted)
                stream.change_is_muted(true);
        } else if (stream.is_muted && this._unmuteAll() && this._justAppeared(stream)) {
            stream.change_is_muted(false);
        }
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
        const icon = Gio.ThemedIcon.new(this._muted ? ICON_MUTED : ICON_LIVE);
        const mgr = Main.osdWindowManager;
        // GNOME 49 renamed show(monitorIndex, ...) to showAll(...).
        if (typeof mgr.showAll === 'function')
            mgr.showAll(icon, null, null, -1);
        else
            mgr.show(-1, icon, null, null, -1);
    }
}
