# Random Group Gate

A Max for Live Audio Effect device. Sits on a Group track in Ableton Live and
randomly mutes/unmutes the tracks inside that group, on a tempo-synced clock,
based on per-channel 0-100 ranges.

## Files

- `Random group gate.amxd` — the device (Max patcher, saved by Max itself —
  see "File format" below before hand-editing it).
- `randomgroup.js` — all the logic. Must stay in the same folder as the
  `.amxd`. Edits to this file hot-reload automatically in Max (`autowatch = 1`
  is set), no need to resave the `.amxd`.
- `LEIAME.txt` — short user-facing quick-start guide, in Portuguese.

## What it does

- Up to 8 channels, each mapped to a track inside the group (by position,
  top to bottom).
- On a tempo-synced clock (1/32 note up to 2 bars, selectable), rolls a
  random number 0-100.
- Each channel has a Min/Max range (0-100). If the roll falls inside a
  channel's range, that channel's track unmutes; otherwise it mutes.
  Overlapping ranges let multiple channels be on at once.
- Auto Balance: splits 0-100 evenly across however many real tracks are
  currently in the group (runs automatically on load/refresh, or manually
  via the `autobalance` message box).
- On/Off toggle: defaults on, and automatically pauses the clock when
  Live's transport isn't playing (resumes when it starts again).
- Rate and On/Off are both exposed as Live-automatable parameters.

## Architecture (inside the patch)

```
[live.thisdevice] --(bang on Live API ready)--> [refresh message] -> js inlet 2
[toggle: On/Off]  --(int)--------------------------------------------> js inlet 0
[umenu: Rate]     --(int 0-6)------------------------------------------> js inlet 1
[autobalance message] ------------------------------------------------> js inlet 2
[pak <16 ints>]   <- 16 number boxes (min/max x 8 channels) -----------> js inlet 2
[metro] --(bang)--------------------------------------------------------> js inlet 0

js outlet 0  -> [metro] right inlet (sets ms period)
js outlet 1  -> "Last Roll" number box (display)
js outlets 2-9 -> 8 toggles (per-channel on/off indicator)
js outlet 10 -> [metro] left inlet (actual run state = On/Off AND transport playing)

[plugin~] <-> [plugout~]   (self-looped stereo pass-through; this device
                             does no audio processing, but an Audio Effect
                             device still needs its audio path connected or
                             it silences the chain)
```

All the real logic lives in `randomgroup.js`. The `.amxd` is mostly just UI
+ wiring + a `js` object.

### Number boxes and Scripting Names

The 16 min/max number boxes (and the Rate umenu, and the On/Off toggle) have
Scripting Names (`varname`) set: `rgg_min1`/`rgg_max1` ... `rgg_min8`/`rgg_max8`,
`rgg_rate`, `rgg_onoff`. `randomgroup.js` uses these to push values into the
UI programmatically (auto-balance writing new ranges, syncing the Rate menu
display, syncing the On/Off toggle on load) via:

```js
var box = this.patcher.getnamed("rgg_min1");
if (box) box.message(newValue);
```

**Important gotcha:** `messnamed()` does NOT work for this — it only targets
objects bound to a *global* symbol (like `[receive]`), not a patcher-local
Scripting Name. `this.patcher.getnamed()` is the correct API. This cost a lot
of back-and-forth to figure out; don't reintroduce `messnamed()` for UI sync.

## Known gotchas / lessons learned (read before changing things)

- **`loadbang` fires before Live's API is ready.** Don't do `LiveAPI` calls
  directly in `loadbang()`. The pattern used here: `loadbang()` does a
  best-effort `init()` call, but the *real* init happens via a `refresh`
  message wired from `[live.thisdevice]`'s outlet, which only bangs once
  Live's API is confirmed ready.
- **umenu `items` attribute format is picky.** It must be a JSON array with
  commas as their *own* array entries interleaved between items, e.g.
  `["1/32", ",", "1/16", ",", "1/4"]` — NOT `["1/32", "1/16", "1/4"]` (gets
  mangled) and NOT a single comma-joined string typed into the Inspector
  (Max splits on both spaces AND commas, shredding multi-word items). Item
  labels must have **no internal spaces** (`1bar` not `1 bar`) or they get
  split too.
- **Time values ("4n", "16n", etc.) on `[metro]` are not used here on
  purpose.** Instead, `randomgroup.js` reads `live_set`'s `tempo`,
  `signature_numerator`, and `signature_denominator` directly and computes
  the interval in ms itself, sending it to `[metro]`'s right inlet. This
  gives more control and was easier to get right than relying on Max's
  Time Value string parsing within a device.
- **Track mute changes always pollute Live's Undo history**, and there is
  no clean fix. `live.remote~` can control a parameter without touching
  undo, but track `mute` is a plain Track property, not a LOM "Parameter"
  object, so `live.remote~` can't target it. Confirmed via Cycling '74's
  own forums — multiple people have asked, no real solution exists short of
  restructuring every target track to live inside an Instrument/Audio
  Effect Rack chain and controlling the chain's Macro instead (not
  implemented here, probably not worth the structural cost).
- **CPU**: `setMute()` caches one `LiveAPI` object per track (built once in
  `collectChildren()`, not reconstructed every tick) and skips the
  `LiveAPI.set()` call entirely if a channel's on/off state didn't change
  from the previous roll. Don't reintroduce constructing `new LiveAPI(...)`
  inside the per-tick roll loop.
- **`plugin~`/`plugout~` must stay wired together** (outlet 0 -> inlet 0,
  outlet 1 -> inlet 1). Without that, the device silences the whole group's
  audio even though it does no DSP of its own — Live routes the chain's
  audio through whatever's between `plugin~` and `plugout~`, and if nothing
  connects them, nothing comes out the other side.

## File format of `.amxd` (if you ever need to hand-edit it)

This file was saved by Max itself, which wraps the JSON patcher content in
a small binary chunk header — it is **not** plain JSON like a `.maxpat`
exported by hand would be. Structure (reverse-engineered, confirmed working):

```
offset 0-11:  "ampf" chunk  (4-byte id "ampf", 4-byte LE size=4, 4 bytes "aaaa")
offset 12-23: "meta" chunk  (4-byte id "meta", 4-byte LE size=4, 4 bytes data)
offset 24-27: "ptch" chunk id ("ptch")
offset 28-31: 4-byte little-endian uint32 = byte length of everything that follows
offset 32-end: JSON text (UTF-8), followed by a single trailing 0x00 byte,
               total length must exactly match the uint32 at offset 28-31
```

To hand-edit: read the file as bytes, slice `data[32:32+size]`, strip the
trailing `\x00`, parse/modify the JSON, re-encode + re-append `\x00`,
recompute `size = len(new_bytes)`, write `data[:28] + struct.pack('<I',
size) + new_bytes`. Always validate afterward: JSON parses, every
`patchline`'s source/destination id exists among the boxes, and every
outlet/inlet index referenced is within that box's `numoutlets`/`numinlets`.
Keep a `.backup` copy before editing — Live does not hot-reload a changed
`.amxd` for a device already loaded in a session; you need to remove and
re-drag the device (or reopen the Live set) to pick up a file-level edit,
and if the device is still open in Max's own editor, saving from there will
overwrite any external edit with whatever's in Max's memory.

Prefer making changes through Max's own UI (Inspector, wiring by hand) when
the change is simple — it's slower but can't get the binary format wrong.
Hand-editing the file directly is faster for things like scripting names on
many objects at once, bulk rewiring, or fixing a specific known-bad
attribute value, but always re-validate structurally afterward.

## Possible future improvements

- Support more than 8 channels (would need a dynamic/scrollable UI instead
  of the fixed 8-column grid).
- Per-channel probability weighting instead of (or in addition to) the
  range-based approach.
- A "lock" per channel to exclude it from auto-balance.
- Investigate whether wrapping target tracks in Audio Effect Racks and
  controlling Macros via `live.remote~` is worth it to avoid polluting
  Live's undo history (see gotcha above) — would be a bigger redesign.
- Single-file distribution via embedding `randomgroup.js` inside the
  `.amxd` (Max supports this for `js` objects via an "Embed" option, not
  yet confirmed to exist/work in this Max version — see `js` object's
  Inspector if revisiting this).

## Development notes

No way to open Ableton/Max directly from an agent session — all testing of
`.amxd` changes has to happen by the user reloading the device in their own
Live session and reporting back console output (Window > Max Console) and
screenshots. When changing `randomgroup.js`, check syntax with `node --check
randomgroup.js` before handing it off — catches basic errors for free, but
won't catch Max/Live-API-specific issues.
