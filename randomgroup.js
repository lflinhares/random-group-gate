// randomgroup.js
// Logic for "Random Group Gate" Max for Live device.
// Place this file in the SAME folder as "Random Group Gate.amxd".
//
// What it does:
//  - Finds the Group Track that this device is sitting on.
//  - Collects up to 8 child tracks inside that group, in order.
//  - On every clock tick (from the device's metro, tempo-synced), rolls a
//    random number 0-100 and compares it against each channel's [min,max]
//    range. If the roll falls inside a channel's range, that channel's
//    track is unmuted; otherwise it is muted. Overlapping ranges simply
//    mean more than one channel can be "on" for the same roll.
//
// Inlets:
//   0 - bang (from metro) -> triggers a roll, OR int (from the On/Off
//       toggle) -> enables/disables the clock
//   1 - int  (from the rate umenu, 0-6) -> selects note-value multiplier
//   2 - list (16 ints: min1 max1 min2 max2 ... min8 max8) from [pak], OR
//       the symbol "refresh" (from the Refresh message box) -> rescans the group
//
// Outlets:
//   0 - int, ms interval -> feed directly into [metro]'s right inlet
//   1 - int, last roll value (0-100) -> display number box
//   2-9 - int (0/1), per-channel enabled state -> indicator toggles for
//         channels 1-8
//   10 - int (0/1), the metro's actual run state -> feed into [metro]'s
//        left inlet. This is (On/Off toggle) AND (Live's transport is
//        playing), so the random rolling automatically stops when
//        playback stops, and resumes when it starts again.

inlets = 3;
outlets = 11;

autowatch = 1;

var NUM_CHANNELS = 8;
var ranges = [];
for (var i = 0; i < NUM_CHANNELS; i++) {
	ranges.push({ min: 0, max: 100 });
}

var groupTrackId = null;
var trackIds = []; // ids of tracks living inside the group, in order
var trackAPIs = []; // cached LiveAPI objects, one per track (built once, reused)
var lastMuteState = []; // last mute value actually sent per channel, or
                         // undefined if never sent yet - used to skip
                         // redundant LiveAPI calls when nothing changed

var msPerBeat = 500; // fallback until tempo is read (120 bpm)
var beatsPerBar = 4; // fallback until time signature is read
var rateIndex = 3; // default to 1/4 note
// multiplier expresses the rate as a fraction/multiple of ONE BEAT
var RATE_BEAT_MULTIPLIERS = [0.125, 0.25, 0.5, 1, 2, null, null];
// indices 5 and 6 ("1 bar", "2 bars") are resolved using beatsPerBar instead,
// see rateToBeats() below.

var tempoAPI = null;
var sigNumAPI = null;
var sigDenAPI = null;
var playAPI = null;

var masterEnabled = 1; // mirrors the On/Off toggle (inlet 0, int) - defaults on
var transportPlaying = 0; // mirrors live_set's is_playing

function post_safe(msg) {
	try {
		post(msg + "\n");
	} catch (e) {}
}

// ---------------------------------------------------------------------
// Setup / group detection
// ---------------------------------------------------------------------

function loadbang() {
	// NOTE: Live's API is usually NOT ready yet when this fires - that's
	// expected. Real initialization happens via the "refresh" message,
	// which should be wired to a [live.thisdevice] object's outlet so it
	// fires again once Live's API is actually ready. This first call is
	// just a best-effort attempt in case the API happens to be ready.
	init();
}

function init() {
	syncRateMenu();
	syncOnOffToggle();
	findGroupTrack();
	collectChildren();
	setupTempoWatch();
	setupTransportWatch();
	updateInterval();
	// auto-balance the ranges across whatever tracks were just found, and
	// it also does one immediate roll so the channels start in a defined
	// state (even if no tracks were found yet, in which case it just rolls
	// without touching any track).
	autobalance();
}

// Makes the Rate dropdown actually display whatever rateIndex is really
// running, instead of just showing whatever item happens to be first in
// its list. Uses umenu's "set" message, which changes the display without
// triggering output (so this can't cause a feedback loop with msg_int()).
function syncRateMenu() {
	try {
		var rateMenu = this.patcher.getnamed("rgg_rate");
		if (rateMenu) rateMenu.message("set", rateIndex);
	} catch (e) {}
}

// Same idea as syncRateMenu(), but for the On/Off toggle: makes it visually
// show masterEnabled's real value (defaults on) instead of the toggle's own
// default appearance.
function syncOnOffToggle() {
	try {
		var toggle = this.patcher.getnamed("rgg_onoff");
		if (toggle) toggle.message(masterEnabled);
	} catch (e) {}
}

// Called by clicking the "refresh" message box, OR automatically by
// [live.thisdevice] once Live's API is confirmed ready (see loadbang note
// above). Fully reinitializes: group detection, tempo sync, and one roll.
function refresh() {
	init();
	post_safe("randomgroup: refreshed, found " + trackIds.length + " channel(s)");
}

// Called by clicking the "autobalance" message box in the device UI.
// Splits 0-100 evenly across however many real tracks are in the group
// (up to NUM_CHANNELS), and pushes the new values into the min/max number
// boxes by name (no patch cords needed for this). Channels beyond the
// actual track count are set to 0-0 (always off) since there's no track
// for them to control.
function autobalance() {
	var count = Math.min(trackIds.length, NUM_CHANNELS);
	if (count <= 0) {
		post_safe("randomgroup: no channels found in the group yet - click " +
			"refresh first (and make sure this device is on the Group track).");
		doRoll(); // still roll once so the UI is in a defined state
		return;
	}
	var summary = "randomgroup: auto-balanced " + count + " channel(s) -";
	for (var i = 0; i < NUM_CHANNELS; i++) {
		var lo, hi;
		if (i < count) {
			lo = Math.round((i * 100) / count);
			hi = Math.round(((i + 1) * 100) / count);
			summary += " Ch" + (i + 1) + ":" + lo + "-" + hi;
		} else {
			lo = 0;
			hi = 0;
		}
		ranges[i].min = lo;
		ranges[i].max = hi;
		// Update the visible number boxes by their Scripting Name. Note:
		// messnamed() does NOT work here - it only targets objects bound to
		// a GLOBAL symbol (like [receive]), not a patcher-local Scripting
		// Name. The correct API for that is this.patcher.getnamed(), which
		// returns the box itself so we can send it a message directly.
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
	doRoll();
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

function collectChildren() {
	trackIds = [];
	trackAPIs = [];
	lastMuteState = [];
	if (groupTrackId === null) return;
	try {
		var liveSet = new LiveAPI("live_set");
		var numTracks = liveSet.getcount("tracks");
		for (var i = 0; i < numTracks; i++) {
			var t = new LiveAPI("live_set tracks " + i);
			var gt = t.get("group_track");
			var parentId = (gt && gt.length > 1) ? gt[1] : 0;
			if (parentId == groupTrackId) {
				trackIds.push(t.id);
			}
			if (trackIds.length >= NUM_CHANNELS) break;
		}
		// build one cached LiveAPI object per track now, instead of
		// constructing a new one on every single metro tick later
		for (var j = 0; j < trackIds.length; j++) {
			trackAPIs[j] = new LiveAPI("id " + trackIds[j]);
			lastMuteState[j] = undefined; // force the first roll to apply
		}
	} catch (e) {
		post_safe("randomgroup: error collecting child tracks - " + e);
	}
}

// ---------------------------------------------------------------------
// Tempo / time-signature sync
// ---------------------------------------------------------------------

function setupTempoWatch() {
	try {
		tempoAPI = new LiveAPI(onTempoChanged, "live_set");
		tempoAPI.property = "tempo";
		var t = tempoAPI.get("tempo");
		if (t && t.length) msPerBeat = 60000.0 / t[0];

		sigNumAPI = new LiveAPI(onSignatureChanged, "live_set");
		sigNumAPI.property = "signature_numerator";
		sigDenAPI = new LiveAPI(function(){}, "live_set");
		sigDenAPI.property = "signature_denominator";

		var num = sigNumAPI.get("signature_numerator");
		var den = sigDenAPI.get("signature_denominator");
		if (num && den && num[0] && den[0]) {
			beatsPerBar = num[0] * (4.0 / den[0]);
		}
	} catch (e) {
		post_safe("randomgroup: error watching tempo/signature - " + e);
	}
}

function onTempoChanged(args) {
	// args is like ["tempo", 128]
	if (args && args.length > 1) {
		msPerBeat = 60000.0 / args[1];
		updateInterval();
	}
}

function onSignatureChanged(args) {
	try {
		var num = sigNumAPI.get("signature_numerator");
		var den = sigDenAPI.get("signature_denominator");
		if (num && den && num[0] && den[0]) {
			beatsPerBar = num[0] * (4.0 / den[0]);
			updateInterval();
		}
	} catch (e) {}
}

// ---------------------------------------------------------------------
// Transport (play/stop) sync - stops the metro when playback stops
// ---------------------------------------------------------------------

function setupTransportWatch() {
	try {
		playAPI = new LiveAPI(onPlayingChanged, "live_set");
		playAPI.property = "is_playing";
		var p = playAPI.get("is_playing");
		if (p && p.length) transportPlaying = p[0] ? 1 : 0;
	} catch (e) {
		post_safe("randomgroup: error watching transport - " + e);
	}
	updateMetroState();
}

function onPlayingChanged(args) {
	// args is like ["is_playing", 1]
	if (args && args.length > 1) {
		transportPlaying = args[1] ? 1 : 0;
		updateMetroState();
	}
}

// Combines the On/Off toggle with Live's transport state and pushes the
// result out to [metro]'s left inlet, so the random rolling only ever
// runs while both are true: the user has it enabled AND playback is
// actually running.
function updateMetroState() {
	var shouldRun = (masterEnabled && transportPlaying) ? 1 : 0;
	outlet(10, shouldRun);
}

function rateToBeats(idx) {
	if (idx == 5) return beatsPerBar; // 1 bar
	if (idx == 6) return beatsPerBar * 2; // 2 bars
	if (RATE_BEAT_MULTIPLIERS[idx] != null) return RATE_BEAT_MULTIPLIERS[idx];
	return 1; // fallback: quarter note
}

function updateInterval() {
	var beats = rateToBeats(rateIndex);
	var ms = Math.max(1, Math.round(beats * msPerBeat));
	outlet(0, ms);
}

// ---------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------

function bang() {
	// arrives on inlet 0, from metro
	doRoll();
}

function msg_int(v) {
	if (inlet == 0) {
		// from the On/Off toggle
		masterEnabled = v ? 1 : 0;
		updateMetroState();
	} else if (inlet == 1) {
		rateIndex = Math.max(0, Math.min(6, Math.round(v)));
		updateInterval();
	}
}

function list() {
	// arrives on inlet 2, from [pak]: min1 max1 min2 max2 ... min8 max8
	if (inlet != 2) return;
	var a = arrayfromargs(arguments);
	for (var i = 0; i < NUM_CHANNELS; i++) {
		var lo = a[i * 2];
		var hi = a[i * 2 + 1];
		if (lo === undefined || hi === undefined) continue;
		var lower = Math.min(lo, hi);
		var upper = Math.max(lo, hi);
		// clamp to 0-100 no matter what the number boxes display, so a
		// stray/garbled value never breaks the comparison against the roll
		ranges[i].min = Math.max(0, Math.min(100, lower));
		ranges[i].max = Math.max(0, Math.min(100, upper));
	}
}

function doRoll() {
	var roll = Math.floor(Math.random() * 101); // 0-100 inclusive
	outlet(1, roll);
	for (var i = 0; i < NUM_CHANNELS; i++) {
		var r = ranges[i];
		var enabled = (roll >= r.min && roll <= r.max) ? 1 : 0;
		outlet(2 + i, enabled);
		setMute(i, enabled ? 0 : 1);
	}
}

function setMute(i, muteVal) {
	if (trackAPIs[i] === undefined) return;
	// skip the LiveAPI call entirely if this channel's mute state didn't
	// actually change from the last roll - this is the main CPU saving,
	// since most ticks leave most channels' state unchanged
	if (lastMuteState[i] === muteVal) return;
	try {
		trackAPIs[i].set("mute", muteVal);
		lastMuteState[i] = muteVal;
	} catch (e) {
		post_safe("randomgroup: could not set mute for channel " + (i + 1) + " - " + e);
	}
}