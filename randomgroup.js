// randomgroup.js
// Logic for "Random Group Gate" Max for Live device.
// Place this file in the SAME folder as "Random Group Gate.amxd".
//
// What it does:
//  - Finds the Group Track that this device is sitting on.
//  - Collects up to 16 child tracks inside that group, in order.
//  - Rolls a random number 0-100. Every channel whose [min,max] range
//    contains the roll "wins" and opens for its own Length (1/32 ... 4
//    bars) - or, if "to" is set, a random length between Len and "to",
//    picked from the menu steps on every win. The next roll happens when
//    the longest winner has finished.
//    If nothing wins, the group rests (all closed) for the Rest length.
//  - Channels are opened/closed by riding each track's VOLUME fader through
//    [live.remote~] with an Attack/Release envelope, between that channel's
//    Level and the global Floor. Unlike track mute, live.remote~ does not
//    write anything to Live's Undo history.
//  - Clock: a transport-synced [metro 32n @quantize 32n] bangs this script
//    on every 32nd note. Each tick reads Live's song position, so all
//    timing is locked to Live's grid (no ms drift), and jumps/loops are
//    handled by re-rolling.
//  - When Live's transport stops or the device is switched off (Live's own
//    device on/off button, via [live.thisdevice]'s middle outlet), every
//    channel opens back up to its Level.
//
// Inlet 0 receives everything:
//   bang                     - from the metro (one per 32nd note)
//   setparam <name> <ch> <v> - from the UI, via [prepend setparam ...]:
//                              min/max/len/lenmax/level (ch 1-16), and
//                              rest/attack/release/floor/manual/input
//                              (ch 0), and
//                              onoff (from live.thisdevice's device state)
//   refresh                  - rescan the group (also sent by live.thisdevice)
//   autobalance              - split 0-100 evenly across the found tracks
//                              (also run by the Auto Balance toggle, see
//                              setparam "autobal")
//
// Outlets:
//   0      - int, last roll value (0-100) -> display number box
//   1-16   - int (0/1), per-channel open state -> indicator toggles
//   17     - int (0/1), metro on/off
//   18-33  - list <target> <ms> -> [line~] for channels 1-16
//   34-49  - "id <n>" -> right inlet of [live.remote~] for channels 1-16

inlets = 1;
outlets = 50; // 2 + 3 per channel - keep in sync with NUM_CHANNELS

autowatch = 1;

var NUM_CHANNELS = 16;
var OUT_ROLL = 0;
var OUT_INDICATOR = 1;
var OUT_METRO = OUT_INDICATOR + NUM_CHANNELS;
var OUT_ENV = OUT_METRO + 1;
var OUT_REMOTE = OUT_ENV + NUM_CHANNELS;

// Length menu index -> length in 32nd notes. null = depends on the time
// signature, see lengthTicks().
var LENGTH_TICKS = [1, 2, 4, 8, 16, null, null, null]; // 1/32 .. 1/2, 1bar, 2bars, 4bars
var BAR_MULTIPLES = { 5: 1, 6: 2, 7: 4 };

var FLOOR_SILENT_DB = -69.5; // at or below this, the Floor means -inf
var MIN_RAMP_MS = 2; // never jump instantly - avoids clicks

var channels = [];
for (var i = 0; i < NUM_CHANNELS; i++) {
	channels.push({
		minRaw: 0, maxRaw: 0, // as typed (in either order)
		min: 0, max: 0, // normalized, clamped 0-100
		len: 3, // index into the Length menu (1/4)
		lenMax: 0, // index into the "to" menu: 0 = "=" (fixed Len), else Length index + 1
		levelDb: 0
	});
}

var restIndex = 3; // Length used when a roll hits no channel
var masterEnabled = 1;
var attackMs = 10;
var releaseMs = 80;
var floorDb = -70;
var autoBalanceOn = 0; // Auto Balance toggle: re-balance on every group change
var manualMode = 0; // 1 = rolls use manualInput instead of a random number
var manualInput = 50; // 1-100, automatable / MIDI-mappable

var groupTrackId = null;
var tracks = []; // { id, volumeId } per channel, in group order

var gateOpen = []; // per channel: true = at Level, false = at Floor
var rampEndsAt = []; // per channel: Date.now() when its current ramp finishes
var channelEndsAt = []; // per channel: song position (32nds) where it closes
var nextRollAt = 0; // song position (32nds) of the next roll
var lastPos = -1; // song position of the last tick handled, -1 = reset

var beatsPerBar = 4; // fallback until the time signature is read

var songAPI = null;
var sigNumAPI = null;
var sigDenAPI = null;
var playAPI = null;
var tracksAPI = null;
var scanAPI = null;
var rescanTask = null;
var pollTask = null;
var boundIds = []; // volume parameter id each live.remote~ is bound to
var MEMBERSHIP_POLL_MS = 2000;

// dB -> fader value lookup, built from Live's own volume parameter
// (see buildVolumeTable). Empty = use the approximation in dbToFader().
var volTable = [];

function post_safe(msg) {
	try {
		post(msg + "\n");
	} catch (e) {}
}

// ---------------------------------------------------------------------
// Setup / group detection
// ---------------------------------------------------------------------

function loadbang() {
	// Live's API is usually NOT ready yet when this fires. Real
	// initialization happens via the "refresh" message, which is wired to
	// [live.thisdevice] so it fires once Live's API is actually ready.
}

function init() {
	readAllParams();
	findGroupTrack();
	collectChildren(true);
	setupSignatureWatch();
	setupTransportWatch();
	setupMembershipWatch();
	// Auto Balance on, or a fresh device (every range still 0-0): spread
	// the ranges across the tracks that were found. Otherwise saved ranges
	// are kept.
	if (autoBalanceOn || rangesUnset()) autobalance(true);
	openAll();
	updateMetroState();
}

// Sent automatically by [live.thisdevice] once Live's API is ready.
// Changes to the group are picked up automatically after that (see
// setupMembershipWatch); this is also kept as a manual message.
// Does NOT overwrite your ranges - use autobalance.
function refresh() {
	init();
	post_safe("randomgroup: refreshed, found " + tracks.length + " channel(s)");
}

// Pulls every parameter's current value straight from the UI objects, so
// the script is in sync even if it was reloaded (autowatch) after the
// parameters had already sent their values.
function readAllParams() {
	for (var i = 0; i < NUM_CHANNELS; i++) {
		var ch = i + 1;
		var v;
		if ((v = readParam("rgg_min" + ch)) !== null) channels[i].minRaw = v;
		if ((v = readParam("rgg_max" + ch)) !== null) channels[i].maxRaw = v;
		normalizeRange(i);
		if ((v = readParam("rgg_len" + ch)) !== null) channels[i].len = clampLength(v);
		if ((v = readParam("rgg_lenmax" + ch)) !== null) channels[i].lenMax = clampLenMax(v);
		if ((v = readParam("rgg_level" + ch)) !== null) channels[i].levelDb = v;
	}
	if ((v = readParam("rgg_rate")) !== null) restIndex = clampLength(v);
	if ((v = readParam("rgg_attack")) !== null) attackMs = Math.max(0, v);
	if ((v = readParam("rgg_release")) !== null) releaseMs = Math.max(0, v);
	if ((v = readParam("rgg_floor")) !== null) floorDb = v;
	if ((v = readParam("rgg_autobal")) !== null) autoBalanceOn = v ? 1 : 0;
	if ((v = readParam("rgg_manual")) !== null) manualMode = v ? 1 : 0;
	if ((v = readParam("rgg_input")) !== null) manualInput = clampInput(v);
}

function readParam(name) {
	try {
		var box = this.patcher.getnamed(name);
		if (!box) return null;
		var v = box.getvalueof();
		if (v instanceof Array) v = v[0];
		v = Number(v);
		return isNaN(v) ? null : v;
	} catch (e) {
		return null;
	}
}

function rangesUnset() {
	if (tracks.length == 0) return false;
	for (var i = 0; i < tracks.length; i++) {
		if (channels[i].max > 0) return false;
	}
	return true;
}

// Run when the Auto Balance toggle is switched on, and on every group
// change while it stays on (quiet = no console noise when there's nothing
// to balance yet). Splits 0-100 evenly (no overlap) across however many
// real tracks are in the group, and pushes the new values into the
// Min/Max boxes by Scripting Name. Channels beyond the track count are set
// to 0-0 (disabled).
function autobalance(quiet) {
	var count = Math.min(tracks.length, NUM_CHANNELS);
	if (count <= 0) {
		if (!quiet) post_safe("randomgroup: no channels found in the group yet " +
			"(make sure this device is on the Group track).");
		return;
	}
	var summary = "randomgroup: auto-balanced " + count + " channel(s) -";
	for (var i = 0; i < NUM_CHANNELS; i++) {
		var lo = 0, hi = 0;
		if (i < count) {
			lo = (i == 0) ? 0 : Math.round((i * 100) / count) + 1;
			hi = Math.round(((i + 1) * 100) / count);
			summary += " Ch" + (i + 1) + ":" + lo + "-" + hi;
		}
		// already there: don't touch the boxes (each write is a parameter
		// change, which can land in Live's Undo history)
		if (channels[i].minRaw == lo && channels[i].maxRaw == hi) continue;
		channels[i].minRaw = lo;
		channels[i].maxRaw = hi;
		normalizeRange(i);
		// Note: messnamed() does NOT work here - it only targets objects
		// bound to a GLOBAL symbol (like [receive]), not a patcher-local
		// Scripting Name. this.patcher.getnamed() is the correct API.
		try {
			var minBox = this.patcher.getnamed("rgg_min" + (i + 1));
			if (minBox) minBox.message(lo);
			var maxBox = this.patcher.getnamed("rgg_max" + (i + 1));
			if (maxBox) maxBox.message(hi);
		} catch (e) {
			post_safe("randomgroup: could not update box for channel " + (i + 1) + " - " + e);
		}
	}
	post_safe(summary);
}

function findGroupTrack() {
	try {
		var here = new LiveAPI("this_device canonical_parent");
		if (here.id == 0) {
			post_safe("randomgroup: could not find the track this device lives on");
			return;
		}
		var isFoldable = here.get("is_foldable");
		if (isFoldable && isFoldable[0] == 1) {
			// device is sitting directly on the group track - correct setup
			groupTrackId = here.id;
		} else {
			// device is on a plain track; try to find its parent group instead
			var gt = here.get("group_track");
			if (gt && gt.length > 1 && gt[1] != 0) {
				groupTrackId = gt[1];
				post_safe("randomgroup: device is not on the group track itself; " +
					"using its parent group instead. For best results, move this " +
					"device onto the Group track.");
			} else {
				post_safe("randomgroup: this device is not on a Group track and has " +
					"no parent group. Place it directly on the Group track.");
				groupTrackId = null;
			}
		}
	} catch (e) {
		post_safe("randomgroup: error finding group track - " + e);
	}
}

// Child tracks of the group, in order: [{ id, index }] (index = position
// in live_set tracks). Reuses one LiveAPI object - cheap enough to run on
// the membership poll.
function scanChildren() {
	var found = [];
	if (groupTrackId === null) return found;
	if (scanAPI === null) scanAPI = new LiveAPI("live_set");
	scanAPI.path = "live_set";
	var numTracks = scanAPI.getcount("tracks");
	for (var i = 0; i < numTracks && found.length < NUM_CHANNELS; i++) {
		scanAPI.path = "live_set tracks " + i;
		var gt = scanAPI.get("group_track");
		var parentId = (gt && gt.length > 1) ? gt[1] : 0;
		if (parentId == groupTrackId) found.push({ id: scanAPI.id, index: i });
	}
	return found;
}

// startOpen: open every new channel (device load) instead of closing the
// ones that join mid-playback.
function collectChildren(startOpen) {
	var previous = {}; // track id -> was open, to carry state across a rescan
	var leaving = []; // tracks that may have left the group
	for (var p = 0; p < tracks.length; p++) {
		previous[tracks[p].id] = gateOpen[p];
		leaving.push({ id: tracks[p].id, volumeId: tracks[p].volumeId, levelDb: channels[p].levelDb });
	}
	var running = masterEnabled && isPlaying() && !startOpen;

	var found = [];
	try {
		found = scanChildren();
	} catch (e) {
		post_safe("randomgroup: error collecting child tracks - " + e);
	}
	tracks = [];
	gateOpen = [];
	rampEndsAt = [];
	channelEndsAt = [];
	var now = Date.now();
	for (var j = 0; j < found.length; j++) {
		var vol = new LiveAPI("live_set tracks " + found[j].index + " mixer_device volume");
		if (volTable.length == 0) buildVolumeTable(vol);
		tracks.push({ id: found[j].id, volumeId: vol.id });
		// tracks that were already here keep their state; new ones start
		// open when idle, closed while playing (the next roll opens them)
		gateOpen[j] = previous.hasOwnProperty(found[j].id) ? previous[found[j].id] : !running;
		rampEndsAt[j] = now;
		channelEndsAt[j] = 0;
	}
	// hand each fader to live.remote~ - only where the track changed.
	// Two passes: Live lets only one live.remote~ hold a parameter, so every
	// slot that changes must let go BEFORE any slot grabs a new fader (when
	// a track leaves, the ones below it shift up into the freed slots).
	var wanted = [];
	for (var r = 0; r < NUM_CHANNELS; r++) {
		wanted[r] = (r < tracks.length) ? tracks[r].volumeId : 0;
		if (boundIds[r] !== wanted[r] && boundIds[r]) {
			outlet(OUT_REMOTE + r, "id", 0);
			boundIds[r] = 0;
		}
	}
	// line~ is set first so a newly bound fader never dips
	for (var q = 0; q < NUM_CHANNELS; q++) {
		if (q < tracks.length) {
			outlet(OUT_ENV + q, dbToFader(gateOpen[q] ? channels[q].levelDb : floorDb), 0);
		}
		if (boundIds[q] !== wanted[q]) {
			outlet(OUT_REMOTE + q, "id", wanted[q]);
			boundIds[q] = wanted[q];
		}
	}
	// a track that left the group (but still exists) would otherwise be
	// stranded at whatever volume the envelope left it - put it back at its
	// channel's Level. This one write does land in Live's Undo history.
	for (var k = 0; k < leaving.length; k++) {
		var stillHere = false;
		for (var n = 0; n < tracks.length; n++) {
			if (tracks[n].id == leaving[k].id) stillHere = true;
		}
		if (stillHere) continue;
		try {
			var gone = new LiveAPI("id " + leaving[k].volumeId);
			if (gone.id != 0) gone.set("value", dbToFader(leaving[k].levelDb));
		} catch (e) {}
	}
	if (running) lastPos = -1; // re-roll on the next tick with the new lineup
	updateIndicators();
}

// ---------------------------------------------------------------------
// Watching the group for added / removed / moved tracks
// ---------------------------------------------------------------------

// Live notifies when the set's track list changes (add, delete, reorder).
// Dragging an existing track into or out of the group doesn't always
// change that list, so a light poll covers that case too. Observer
// callbacks may not change the Live set, so the rescan is deferred.
function setupMembershipWatch() {
	try {
		tracksAPI = new LiveAPI(onTracksChanged, "live_set");
		tracksAPI.property = "tracks";
	} catch (e) {
		post_safe("randomgroup: error watching tracks - " + e);
	}
	if (rescanTask === null) rescanTask = new Task(rescanIfChanged, this);
	if (pollTask === null) {
		pollTask = new Task(rescanIfChanged, this);
		pollTask.interval = MEMBERSHIP_POLL_MS;
		pollTask.repeat();
	}
}

function onTracksChanged(args) {
	if (rescanTask !== null) rescanTask.schedule(50);
}

function rescanIfChanged() {
	if (groupTrackId === null) return;
	var found;
	try {
		found = scanChildren();
	} catch (e) {
		return;
	}
	var same = (found.length == tracks.length);
	for (var i = 0; same && i < found.length; i++) {
		if (found[i].id != tracks[i].id) same = false;
	}
	if (same) return;
	collectChildren();
	post_safe("randomgroup: group changed, now " + tracks.length + " channel(s)");
	if (autoBalanceOn || rangesUnset()) autobalance(true);
}

function isPlaying() {
	try {
		if (songAPI === null) songAPI = new LiveAPI("live_set");
		var p = songAPI.get("is_playing");
		return p && p[0] ? true : false;
	} catch (e) {
		return false;
	}
}

// ---------------------------------------------------------------------
// dB <-> Live's volume fader (0.0-1.0, 0.85 = 0 dB, not linear)
// ---------------------------------------------------------------------

// Asks Live itself what each fader position means in dB, so the dB values
// on the device match the mixer exactly. Done once.
function buildVolumeTable(volAPI) {
	var STEPS = 200;
	var table = [];
	try {
		for (var k = 0; k <= STEPS; k++) {
			var v = k / STEPS;
			var db = parseDb(volAPI.call("str_for_value", v));
			if (!isNaN(db)) table.push({ v: v, db: db });
		}
	} catch (e) {
		table = [];
	}
	var finite = 0;
	for (var n = 0; n < table.length; n++) {
		if (isFinite(table[n].db)) finite++;
	}
	if (finite >= 20) {
		volTable = table;
	} else {
		post_safe("randomgroup: could not read Live's volume curve, using an approximation");
	}
}

function parseDb(s) {
	var str = (s instanceof Array) ? s.join(" ") : String(s);
	if (/inf/i.test(str)) return -Infinity;
	var m = str.match(/-?\d+(\.\d+)?/);
	return m ? parseFloat(m[0]) : NaN;
}

function dbToFader(db) {
	if (db <= FLOOR_SILENT_DB) return 0;
	if (volTable.length) {
		var prev = null;
		for (var k = 0; k < volTable.length; k++) {
			var e = volTable[k];
			if (!isFinite(e.db)) continue;
			if (e.db >= db) {
				if (prev === null || e.db == prev.db) return e.v;
				return prev.v + (e.v - prev.v) * (db - prev.db) / (e.db - prev.db);
			}
			prev = e;
		}
		return prev ? prev.v : 1;
	}
	// rough fallback: ~40 dB per unit above -30 dB, steeper below
	var v = (db >= -30) ? 0.85 + db / 40 : 0.1 * (db + 70) / 40;
	return Math.max(0, Math.min(1, v));
}

// ---------------------------------------------------------------------
// Time signature / transport
// ---------------------------------------------------------------------

function setupSignatureWatch() {
	try {
		songAPI = new LiveAPI("live_set");
		sigNumAPI = new LiveAPI(onSignatureChanged, "live_set");
		sigNumAPI.property = "signature_numerator";
		sigDenAPI = new LiveAPI(onSignatureChanged, "live_set");
		sigDenAPI.property = "signature_denominator";
		onSignatureChanged();
	} catch (e) {
		post_safe("randomgroup: error watching time signature - " + e);
	}
}

function onSignatureChanged(args) {
	try {
		var num = songAPI.get("signature_numerator");
		var den = songAPI.get("signature_denominator");
		if (num && den && num[0] && den[0]) {
			beatsPerBar = num[0] * (4.0 / den[0]);
		}
	} catch (e) {}
}

function setupTransportWatch() {
	try {
		playAPI = new LiveAPI(onPlayingChanged, "live_set");
		playAPI.property = "is_playing";
	} catch (e) {
		post_safe("randomgroup: error watching transport - " + e);
	}
}

function onPlayingChanged(args) {
	// args is like ["is_playing", 1]
	if (args && args.length > 1 && !args[1]) {
		openAll();
	}
}

function updateMetroState() {
	outlet(OUT_METRO, masterEnabled ? 1 : 0);
}

function lengthTicks(idx) {
	if (LENGTH_TICKS[idx] != null) return LENGTH_TICKS[idx];
	var bars = BAR_MULTIPLES[idx] || 1;
	return Math.max(1, Math.round(beatsPerBar * 8 * bars));
}

function clampLength(v) {
	return Math.max(0, Math.min(LENGTH_TICKS.length - 1, Math.round(v)));
}

// "to" menu: 0 = "=", 1-8 = Length index + 1
function clampLenMax(v) {
	return Math.max(0, Math.min(LENGTH_TICKS.length, Math.round(v)));
}

// ---------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------

function bang() {
	// one per 32nd note, from [metro 32n @quantize 32n]
	if (!masterEnabled || songAPI === null) return;
	var pos;
	try {
		var playing = songAPI.get("is_playing");
		if (!playing || !playing[0]) return;
		var t = songAPI.get("current_song_time"); // in beats
		pos = Math.round(t[0] * 8); // in 32nd notes
	} catch (e) {
		return;
	}
	if (pos == lastPos) return; // duplicate tick
	if (lastPos < 0 || pos < lastPos) {
		// (re)start, loop or jump backwards: roll right away
		nextRollAt = pos;
		for (var c = 0; c < channelEndsAt.length; c++) channelEndsAt[c] = pos;
	}
	lastPos = pos;

	if (pos >= nextRollAt) doRoll(pos);
	for (var i = 0; i < tracks.length; i++) {
		setGate(i, pos < channelEndsAt[i]);
	}
}

function setparam(name, ch, v) {
	var i = Math.round(ch) - 1;
	var hasChannel = (i >= 0 && i < NUM_CHANNELS);
	if (name == "min" && hasChannel) {
		channels[i].minRaw = v;
		normalizeRange(i);
	} else if (name == "max" && hasChannel) {
		channels[i].maxRaw = v;
		normalizeRange(i);
	} else if (name == "len" && hasChannel) {
		channels[i].len = clampLength(v);
	} else if (name == "lenmax" && hasChannel) {
		channels[i].lenMax = clampLenMax(v);
	} else if (name == "level" && hasChannel) {
		channels[i].levelDb = v;
		if (gateOpen[i]) followParam(i);
	} else if (name == "rest") {
		restIndex = clampLength(v);
	} else if (name == "onoff") {
		masterEnabled = v ? 1 : 0;
		if (!masterEnabled) openAll();
		lastPos = -1;
		updateMetroState();
	} else if (name == "attack") {
		attackMs = Math.max(0, v);
	} else if (name == "release") {
		releaseMs = Math.max(0, v);
	} else if (name == "autobal") {
		autoBalanceOn = v ? 1 : 0;
		if (autoBalanceOn) autobalance(true);
	} else if (name == "manual") {
		manualMode = v ? 1 : 0;
	} else if (name == "input") {
		manualInput = clampInput(v);
	} else if (name == "floor") {
		floorDb = v;
		for (var c = 0; c < tracks.length; c++) {
			if (gateOpen[c] === false) followParam(c);
		}
	}
}

function clampInput(v) {
	return Math.max(1, Math.min(100, Math.round(v)));
}

function normalizeRange(i) {
	var c = channels[i];
	var lower = Math.min(c.minRaw, c.maxRaw);
	var upper = Math.max(c.minRaw, c.maxRaw);
	// clamp to 0-100 no matter what the boxes display
	c.min = Math.max(0, Math.min(100, lower));
	c.max = Math.max(0, Math.min(100, upper));
}

// ---------------------------------------------------------------------
// Rolling / gating
// ---------------------------------------------------------------------

function doRoll(pos) {
	// Manual: use the Input value, read at roll time so lengths and the
	// grid still apply. Otherwise random, 0-100 inclusive.
	var roll = manualMode ? manualInput : Math.floor(Math.random() * 101);
	outlet(OUT_ROLL, roll);
	var longest = 0;
	for (var i = 0; i < tracks.length; i++) {
		var c = channels[i];
		// a 0-0 range means "disabled"
		var hit = c.max > 0 && roll >= c.min && roll <= c.max;
		if (hit) {
			var len = lengthTicks(pickLength(c));
			channelEndsAt[i] = pos + len;
			if (len > longest) longest = len;
		}
	}
	if (longest == 0) longest = lengthTicks(restIndex); // nothing won: rest
	nextRollAt = pos + longest;
}

// Length menu index for this win: Len itself, or a random step between
// Len and "to" (either order works).
function pickLength(c) {
	if (c.lenMax <= 0) return c.len;
	var lo = Math.min(c.len, c.lenMax - 1);
	var hi = Math.max(c.len, c.lenMax - 1);
	return lo + Math.floor(Math.random() * (hi - lo + 1));
}

// Opens/closes one channel with the Attack/Release envelope. Does nothing
// if the channel is already in that state, so a channel that wins twice in
// a row just keeps playing.
function setGate(i, open) {
	if (i >= tracks.length || gateOpen[i] === open) return;
	gateOpen[i] = open;
	outlet(OUT_INDICATOR + i, open ? 1 : 0);
	ramp(i, open ? attackMs : releaseMs);
}

function ramp(i, ms) {
	ms = Math.max(MIN_RAMP_MS, ms);
	var db = gateOpen[i] ? channels[i].levelDb : floorDb;
	rampEndsAt[i] = Date.now() + ms;
	outlet(OUT_ENV + i, dbToFader(db), ms);
}

// Level/Floor changed (by hand, automation or an LFO): glide to the new
// value over whatever is left of the current ramp, so a moving Floor does
// not cut a long release short.
function followParam(i) {
	var left = (rampEndsAt[i] || 0) - Date.now();
	ramp(i, Math.max(15, left));
}

function openAll() {
	lastPos = -1;
	for (var i = 0; i < tracks.length; i++) {
		setGate(i, true);
	}
}

function updateIndicators() {
	for (var i = 0; i < NUM_CHANNELS; i++) {
		outlet(OUT_INDICATOR + i, (i < tracks.length && gateOpen[i]) ? 1 : 0);
	}
}
