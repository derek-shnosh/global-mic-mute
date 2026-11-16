# Global Mic Mute

A GNOME Shell extension that mutes every microphone at once, not just the default one, and keeps them muted.

- **All sources:** every input is muted, not only the default.
- **Enforced:** while mute is on, sources that appear later (hotplugged mics, a device switched to another profile such as S/PDIF) or that an app unmutes are muted again immediately.
- **Dead inputs ignored:** inputs whose active port is unavailable (an empty mic jack) can't capture or hold a mute state, so they don't count.
- **Unmute scope:** unmute either *all microphones* (default; microphones that appear afterwards follow the unmute) or *the active microphone only*. Mute always applies to every microphone.
- **Shortcuts:** separate Toggle, Mute and Unmute shortcuts, set by pressing the keys in the preferences dialog. Use any combination; a disabled shortcut does nothing. Defaults: `Super+M` mutes, `Super+Alt+M` unmutes.
- **Remember state** (optional): restore and enforce the last state at login. Off by default, so each login starts unmuted.
- **Panel indicator and OSD** (optional): click the icon to toggle; the icon turns red when any usable microphone is live.
- **Lock screen:** keeps running while the screen is locked, so microphones stay muted while you are away.

Uses Gvc (GNOME's own mixer library) directly; no external commands.

## Install (development)

```sh
make install          # compiles schemas, symlinks into ~/.local/share/gnome-shell/extensions
# log out and back in (Wayland), then:
gnome-extensions enable global-mic-mute@derek-shnosh.github.com
```

## Settings

```sh
gnome-extensions prefs global-mic-mute@derek-shnosh.github.com
```

## License

GPL-2.0-or-later
