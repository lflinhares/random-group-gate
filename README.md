# Random Group Gate

A Max for Live Audio Effect device. Sits on a Group track in Ableton Live and
randomly gates the tracks inside that group, tempo-synced, by riding each
track's volume fader with an attack/release envelope.

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
- Rolls a random number 0-100. Every channel whose Min/Max range contains
  the roll wins and opens for its own **Length** (1/32 ... 4 bars). The
  next roll happens when the longest winner has finished. If nothing wins,
  every channel stays closed for the **Rest** length.
  Overlapping ranges still let several channels open together. A 0-0 range
  disables a channel.
- Gating is done on each track's **volume fader** through `live.remote~`,
  with a global **Attack** / **Release** envelope (ms), between the
  channel's **Level** (dB) and the global **Floor** (dB; -70 = -inf, a
  higher Floor makes it a ducker instead of a gate). `live.remote~` does
  not touch Live's Undo history. While the device is loaded those faders
  are owned by the device (greyed out in the mixer); set levels with the
  per-channel Level instead.
- Timing is locked to Live's grid: the clock ticks every 32nd note and
  reads Live's song position, so there is no drift, and loops/jumps simply
  trigger a new roll.
- Auto Balance: splits 0-100 evenly (no overlap) across however many real
  tracks are in the group. Runs automatically only on a fresh device
  (every range still 0-0); after that, ranges are saved with the set and
  only change when you click `autobalance`.
- On/Off toggle: defaults on. When it's off or Live's transport stops,
  every channel opens back up to its Level.
- **Every control is a Live parameter**: automatable, saved with the set
  and presets, and mappable to Live's LFO / Envelope Follower / macros.

## Architecture (inside the patch)

```
[live.thisdevice] --(bang on Live API ready)--> [refresh message] --> js
[autobalance message] ------------------------------------------------> js
[metro 32n @quantize 32n] --(bang every 32nd, only while playing)----> js
every parameter --> [prepend setparam <name> <ch>] -------------------> js
   (min/max/len/level x 8 channels; rest, onoff, attack, release, floor)

js outlet 0      -> "Last Roll" number box (display)
js outlets 1-8   -> 8 toggles (per-channel open indicator)
js outlet 9      -> [metro] left inlet (On/Off)
js outlets 10-17 -> [line~] per channel ("<fader value> <ms>")
                      -> [live.remote~] left inlet (the envelope signal)
js outlets 18-25 -> [live.remote~] RIGHT inlet ("id <track volume id>")

[plugin~] <-> [plugout~]   (self-looped stereo pass-through; this device
                             does no audio processing, but an Audio Effect
                             device still needs its audio path connected or
                             it silences the chain)
```

All the real logic lives in `randomgroup.js`. The `.amxd` is mostly just UI
+ wiring + a `js` object.

### Number boxes and Scripting Names

Every parameter object has a Scripting Name (`varname`): `rgg_min1..8`,
`rgg_max1..8`, `rgg_len1..8`, `rgg_level1..8`, `rgg_rate` (the Rest menu;
its Live parameter is still called `rate` so old automation keeps working),
`rgg_onoff`, `rgg_attack`, `rgg_release`, `rgg_floor`. On `refresh` the
script reads them all with `getvalueof()`, so it is in sync even after an
autowatch reload. `randomgroup.js` uses these to push values into the
UI programmatically (auto-balance writing new ranges) via:

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
- **Track mute changes always pollute Live's Undo history** - that's why
  the device no longer uses mute. Track volume *is* a LOM DeviceParameter,
  so `live.remote~` can drive it without touching Undo. The one-time
  "unmute tracks left muted by the old version" on refresh does make an
  Undo entry, but only if a track was actually muted.
- **`live.remote~` takes the `id` on its RIGHT inlet**; the left inlet is
  the value (float or signal). Before binding, the script sets the
  channel's `line~` to the right level first so the fader never dips to 0.
- **dB values**: Live's fader (0.0-1.0, 0.85 = 0 dB) isn't linear in dB.
  On refresh the script asks Live for `str_for_value` at 201 positions and
  builds a lookup table, so device dB values match the mixer; it falls back
  to an approximation if that fails (posts a message).
- **CPU**: the script runs once per 32nd note but only does real work
  (outlets to `line~`) when a channel changes state; envelopes run at
  audio rate in `line~`, not in JS.
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
- Tempo-synced (note value) Attack/Release as an alternative to ms.
- Option to release the faders (`id 0`) while Off, for manual mixing.
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
