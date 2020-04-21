/* (c) 2020 by Marius Burkard <mails@timesaving.de>
 * Script for mower control using the smartgarden adapter
 * This script will always use PARKED_PARK_SELECTED instead of PARKED_TIMER to override the mowing schedule set by the app/service
 *
 * States
 * ------
 * DATA_BASE_ID.stop_mowing - manual trigger for locking the mowing process and park until further notice
 *
 * DATA_BASE_ID.cmd_mowing_until - the end time of the current "manual mowing" command sent by the script (mowing end time)
 * DATA_BASE_ID.current_schedule_state - current desired state of the mower from schedule, MOWING or PARK
 * DATA_BASE_ID.current_schedule_reason - reason for current state (SCHEDULE, LOCKED - due to MOWING_LOCKS trigger, PAUSE - due to pause setting in schedule, COMPLETE - mowing time for current day reached)
 * DATA_BASE_ID.locked_until - time until the current lock trigger is locking the mowing state
 * DATA_BASE_ID.next_start - timestamp of the estimated next start (from schedule, charging or locking)
 * DATA_BASE_ID.next_stop - timestamp of the estimated next stop (from schedule or charging)
 * DATA_BASE_ID.remaining_charge_time - if charging this contains the estimated seconds until fully charged
 * DATA_BASE_ID.remaining_charge_time_str - the estimated charging time in mm:ss format
 * DATA_BASE_ID.remaining_mowing_time - if mowing this contains the estimated seconds until mowing end (for charging, schedule)
 * DATA_BASE_ID.remaining_mowing_time_str - the estimated mowing time in mm:ss format
 *
 * DATA_BASE_ID.charging_history - helper state for storing last charging values (duration and percentage)
 * DATA_BASE_ID.mowing_history - helper state for storing last mowing values (duration and end-of-mowing state of charge)
 * DATA_BASE_ID.mowing_lock_states - helper state for storing the current lock trigger states
 * DATA_BASE_ID.mowing_time_day - helper state for storing the current day's mowing time
 */

const DEBUG_LOG = true;

const DATA_BASE_ID = 'javascript.0.HomeControl.garden.mower'; // base id for the states this script uses
const SG_LOCATION_ID = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'; // location id of your smartgarden location
const SG_DEVICE_ID = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'; // device id of the mower

// ids of alexa devices to send warning on "out of area" events to
const ALEXA_SPEAK_IDS = [
	'G0XXXXXXXXXXXXXX',
	'G0XXXXXXXXXXXXXX'
];

// mowing locks (devices that shall suspend mowing)
const MOWING_LOCKS = [
	{
		triggerStateId: 'javascript.0.HomeControl.garden.mower.stop_mowing', // state to check
		triggerStateValue: true, // value the state will be treated as locking
		triggerStateRange: false, // trigger will be active if triggerStateValue is "lower/greater" than, "equal to" if absent of false/null
		releaseDelay: 0, // release delay after value change in minutes,
		releaseDelayMultiplier: false // if set the releaseDelay will be the multiplier of the lock active state time, e. g. the lock was active for 30 minutes, releaseDelay is set to 12, the delay will be 360 minutes
	},
	{
		triggerStateId: 'rainbird.0.device.sensors.rain', // state to check
		triggerStateValue: true, // value the state will be treated as locking
		triggerStateRange: false, // trigger will be active if triggerStateValue is "lower/greater" than, "equal to" if absent of false/null
		releaseDelay: 360, // release delay after value change in minutes,
		releaseDelayMultiplier: false // if set the releaseDelay will be the multiplier of the lock active state time, e. g. the lock was active for 30 minutes, releaseDelay is set to 12, the delay will be 360 minutes
	},
	{
		triggerStateId: 'netatmo.0.Hellweather.Draußen.Temperature.Temperature', // state to check
		triggerStateValue: 6, // value the state will be treated as locking
		triggerStateRange: 'lower', // trigger will be active if triggerStateValue is "lower/greater" than, "equal to" if absent of false/null
		releaseDelay: 0, // release delay after value change in minutes,
		releaseDelayMultiplier: false // if set the releaseDelay will be the multiplier of the lock active state time, e. g. the lock was active for 30 minutes, releaseDelay is set to 12, the delay will be 360 minutes
	},
	{
		triggerStateId: 'rainbird.0.device.stations.2.irrigation', // state to check
		triggerStateValue: true, // value the state will be treated as locking
		triggerStateRange: false, // trigger will be active if triggerStateValue is "lower/greater" than, "equal to" if absent of false/null
		releaseDelay: 40, // release delay after value change in minutes,
		releaseDelayMultiplier: true // if set the releaseDelay will be the multiplier of the lock active state time, e. g. the lock was active for 30 minutes, releaseDelay is set to 12, the delay will be 360 minutes
	},
	{
		triggerStateId: 'rainbird.0.device.stations.3.irrigation', // state to check
		triggerStateValue: true, // value the state will be treated as locking
		triggerStateRange: false, // trigger will be active if triggerStateValue is "lower/greater" than, "equal to" if absent of false/null
		releaseDelay: 40, // release delay after value change in minutes,
		releaseDelayMultiplier: true // if set the releaseDelay will be the multiplier of the lock active state time, e. g. the lock was active for 30 minutes, releaseDelay is set to 12, the delay will be 360 minutes
	}
];

// enable scheduled mowing (override app etc)
// IMPORTANT: ALL TIME VALUES ARE IN SERVER'S LOCAL TIME, SO THIS MIGHT BE UTC OR SOMETHING DIFFERENT
const MOWING_SCHEDULE_ACTIVE = true;
const MOWING_SCHEDULE = {
	'mo': { //monday
		mowing: true, // mowing enabled on this day
		mowingTime: 450, // day's mowing time in minutes
		earliestStart: 'sunrise', // either sunrise or hour:minute, e.g. 9:20
		latestStop: 'sunset', // either sunset or hour:minute. e.g. 20:10
		pause: { // pause mowing during above time frame
			from: null, // pause from (hour:minute, e.g. 12:15)
			to: null // pause until (hour:minute, e.g. 14:35)
		}
	},
	'tu': {
		mowing: true,
		mowingTime: 450,
		earliestStart: 'sunrise',
		latestStop: 'sunset',
		pause: {
			from: '9:50',
			to: '10:20'
		}
	},
	'we': {
		mowing: false,
		mowingTime: 450,
		earliestStart: 'sunrise',
		latestStop: 'sunset',
		pause: {
			from: null,
			to: null
		}
	},
	'th': {
		mowing: true,
		mowingTime: 450,
		earliestStart: 'sunrise',
		latestStop: 'sunset',
		pause: {
			from: null,
			to: null
		}
	},
	'fr': {
		mowing: true,
		mowingTime: 450,
		earliestStart: 'sunrise',
		latestStop: 'sunset',
		pause: {
			from: null,
			to: null
		}
	},
	'sa': {
		mowing: false,
		mowingTime: 450,
		earliestStart: 'sunrise',
		latestStop: 'sunset',
		pause: {
			from: null,
			to: null
		}
	},
	'su': {
		mowing: false,
		mowingTime: 450,
		earliestStart: 'sunrise',
		latestStop: 'sunset',
		pause: {
			from: null,
			to: null
		}
	}
};

/* ### CHANGES SHOULD NOT BE NECCESSARY BELOW ### */

if(existsState(DATA_BASE_ID + '.stop_mowing') === false) {
    createState(DATA_BASE_ID + '.stop_mowing', false, {name: 'Do not start mowing and stop if currently running', unit: '', type: 'boolean', role: 'switch'});
}

if(existsState(DATA_BASE_ID + '.charging_history') === false) {
    createState(DATA_BASE_ID + '.charging_history', '[]', {name: 'Charging time history', unit: '', type: 'string', role: 'array'});
}
if(existsState(DATA_BASE_ID + '.mowing_history') === false) {
    createState(DATA_BASE_ID + '.mowing_history', '[]', {name: 'Mowing data history', unit: '', type: 'string', role: 'array'});
}
if(existsState(DATA_BASE_ID + '.mowing_time_day') === false) {
    createState(DATA_BASE_ID + '.mowing_time_day', '{}', {name: 'Mowing time history', unit: '', type: 'string', role: 'object'});
}
if(existsState(DATA_BASE_ID + '.mowing_lock_states') === false) {
    createState(DATA_BASE_ID + '.mowing_lock_states', '{}', {name: 'Mowing lock states', unit: '', type: 'string', role: 'object'});
}

if(existsState(DATA_BASE_ID + '.current_schedule_state') === false) {
    createState(DATA_BASE_ID + '.current_schedule_state', '', {name: 'Current mowing state from plan', unit: '', type: 'string', role: 'text'});
}
if(existsState(DATA_BASE_ID + '.current_schedule_reason') === false) {
    createState(DATA_BASE_ID + '.current_schedule_reason', '', {name: 'Current mowing state reason', unit: '', type: 'string', role: 'text'});
}


if(existsState(DATA_BASE_ID + '.next_start') === false) {
    createState(DATA_BASE_ID + '.next_start', null, {name: 'Estimated next start time', unit: '', type: 'number', role: 'date'});
}
if(existsState(DATA_BASE_ID + '.next_stop') === false) {
    createState(DATA_BASE_ID + '.next_stop', null, {name: 'Estimated next stop time', unit: '', type: 'number', role: 'date'});
}
if(existsState(DATA_BASE_ID + '.locked_until') === false) {
    createState(DATA_BASE_ID + '.locked_until', null, {name: 'Lock time set by trigger', unit: '', type: 'number', role: 'date'});
}
if(existsState(DATA_BASE_ID + '.cmd_mowing_until') === false) {
    createState(DATA_BASE_ID + '.cmd_mowing_until', null, {name: 'Next planned stop time because of manual mowing command', unit: '', type: 'number', role: 'date'});
}

if(existsState(DATA_BASE_ID + '.remaining_charge_time') === false) {
    createState(DATA_BASE_ID + '.remaining_charge_time', null, {name: 'Estimated remaining charge time', unit: 's', type: 'number', role: 'value'});
}
if(existsState(DATA_BASE_ID + '.remaining_mowing_time') === false) {
    createState(DATA_BASE_ID + '.remaining_mowing_time', null, {name: 'Estimated remaining mowing time', unit: 's', type: 'number', role: 'value'});
}
if(existsState(DATA_BASE_ID + '.remaining_charge_time_str') === false) {
    createState(DATA_BASE_ID + '.remaining_charge_time_str', null, {name: 'Estimated remaining charge time', unit: '', type: 'string', role: 'text'});
}
if(existsState(DATA_BASE_ID + '.remaining_mowing_time_str') === false) {
    createState(DATA_BASE_ID + '.remaining_mowing_time_str', null, {name: 'Estimated remaining mowing time', unit: '', type: 'string', role: 'text'});
}

on({id: 'smartgarden.0.LOCATION_' + SG_LOCATION_ID + '.DEVICE_' + SG_DEVICE_ID + '.SERVICE_MOWER_' + SG_DEVICE_ID + '.state_value', change: 'ne'}, function(obj) {
    let status = obj.state.val;
	if(status === 'ERROR') {
		if(ALEXA_SPEAK_IDS.length) {
			status = getState('smartgarden.0.LOCATION_' + SG_LOCATION_ID + '.DEVICE_' + SG_DEVICE_ID + '.SERVICE_MOWER_' + SG_DEVICE_ID + '.lastErrorCode_value').val;
			if(status === 'OUTSIDE_WORKING_AREA') {
				mowerLog('Mower is out of working area.');
				let text = '<speak>Achtung! Der Rasenmäher befindet sich außerhalb des Mähbereichs.</speak>';

				for(let i = 0; i < ALEXA_SPEAK_IDS.length; i++) {
					setState('alexa2.0.Echo-Devices.' + ALEXA_SPEAK_IDS[i] + '.Commands.ssml', text);
				}
			}
		}
	}
});

on({id: DATA_BASE_ID + '.stop_mowing', change: 'ne', ack: false}, function(obj) {
	setState(obj.id, obj.state.val, true);
});

function mowerLog(message, ondebug) {
	if(!ondebug || DEBUG_LOG) {
		log(message);
	}
}

function getArrayCleanAvg(arr) {
	if(typeof arr === 'object' && Array.isArray(arr) !== true) {
		let tmp = [];
		for(let idx in arr) {
			tmp.push(arr[idx]);
		}
		arr = tmp;
	}

	if(!arr.length) {
		return null;
	}

	let tmp_average = getArrayAvg(arr);
	let tmp_max = getArrayMax(arr);
	let tmp_min = getArrayMin(arr);

	let tmp_values = [];

	let spread = tmp_max - tmp_min;
	for(let i = 0; i < arr.length; i++) {
		if(Math.abs(arr[i] - tmp_average) < (spread * 0.4) + 0.001) {
			tmp_values.push(arr[i]);
		}
	}
	arr = tmp_values;
	if(arr.length < 1) {
		return tmp_average; // fallback on low-quality values
	}
	
	return getArrayAvg(arr);
}

function getArrayAvg(arr) {
	if(typeof arr === 'object' && Array.isArray(arr) !== true) {
		let tmp = [];
		for(let idx in arr) {
			tmp.push(arr[idx]);
		}
		arr = tmp;
	}

	if(!arr.length) {
		return null;
	}

	return arr.reduce((a,b) => (a ? a : 0) + (b ? b : 0), 0) / arr.length;
}

function getArrayMin(arr) {
	if(typeof arr === 'object' && Array.isArray(arr) !== true) {
		let tmp = [];
		for(let idx in arr) {
			tmp.push(arr[idx]);
		}
		arr = tmp;
	}

	if(!arr.length) {
		return null;
	}

	return arr.reduce((acc, cur) => ((acc === null || cur < acc) && cur !== null ? cur : acc));
}

function getArrayMax(arr) {
	if(typeof arr === 'object' && Array.isArray(arr) !== true) {
		let tmp = [];
		for(let idx in arr) {
			tmp.push(arr[idx]);
		}
		arr = tmp;
	}

	if(!arr.length) {
		return null;
	}

	return arr.reduce((acc, cur) => ((cur > acc || acc === null) && cur !== null ? cur : acc));
}

function getMinuteString(seconds) {
	let min = Math.floor(seconds / 60);
	seconds = seconds - (min * 60);
	seconds = Math.floor(seconds);

	return min + ':' + (seconds < 10 ? '0' : '') + seconds;
}

function getTimeInMinutes(timestring) {
	if(!timestring) {
		return 0;
	}

	if(timestring === 'sunrise' || timestring === 'sunset') {
		let tmp = getAstroDate(timestring);
		let now = new Date();

		if(tmp.getDate() != now.getDate()) {
			return getTimeInMinutes((tmp.getHours() + 24) + ':' + tmp.getMinutes());
		} else {
			return getTimeInMinutes(tmp.getHours() + ':' + tmp.getMinutes());
		}
	}

	timestring = timestring + '';

	let parts = timestring.split(':');
	let minutes = parseInt(parts[0]) * 60;
	if(parts.length > 1) {
		minutes = minutes + parseInt(parts[1]);
	}

	return minutes;
}

let countDownTimer;
let countDownTimerMowing;

/* mowing history data */
function calcRemainingChargingTime(neededSoC) {
	if(countDownTimer) {
		clearInterval(countDownTimer);
	}
	if(chargingHistory.length < 1) {
		mowerLog('Cannot calc charging time, no history.', true);
		return;
	}

	let times = [];

	let hist;
	for(let i = 0; i < chargingHistory.length; i++) {
		hist = chargingHistory[i];
		times.push(hist.time / hist.percentage);
	}

	let avgTime = getArrayCleanAvg(times);
	if(!avgTime) {
		mowerLog('No clean average for ' + JSON.stringify(times) + ' found.', true);
		return;
	}
	let chargeTime = (neededSoC + 1.5) * avgTime;
	mowerLog('Charge time calculated is ' + chargeTime + ' seconds (avg ' + avgTime + ').', true);

	setState(DATA_BASE_ID + '.remaining_charge_time', chargeTime, true);
	setState(DATA_BASE_ID + '.remaining_charge_time_str', getMinuteString(chargeTime), true);
	let countDown = chargeTime;
	countDownTimer = setInterval(function() {
		countDown--;
		if(countDown <= 0) {
			countDown = 0;
			if(countDownTimer) {
				clearInterval(countDownTimer);
			}
		}
		setState(DATA_BASE_ID + '.remaining_charge_time', countDown, true);
		setState(DATA_BASE_ID + '.remaining_charge_time_str', getMinuteString(countDown), true);
	}, 1000);

	let chargeEnd = new Date();
	chargeEnd.setUTCSeconds(chargeEnd.getUTCSeconds() + chargeTime);

	nextStartValues.charge = chargeEnd.getTime();
	calcNextStartTime();
}

function calcNextStartTime() {
	let nextStart = 0;

	let now = (new Date()).getTime();

	if(nextStartValues.charge && nextStartValues.charge >= now && (!nextStopValues.plan || nextStopValues.plan > nextStartValues.charge || nextStopValues.plan < now - 120000)) {
		if(!nextStart) {
			mowerLog('Next start from charge: ' + (new Date(nextStartValues.charge)), true);
			nextStart = nextStartValues.charge;
		}
	}
	if(nextStartValues.plan && nextStartValues.plan >= now && (!nextStopValues.plan || nextStopValues.plan > nextStartValues.plan || nextStopValues.plan < now - 120000)) {
		if(!nextStart || nextStartValues.plan > nextStart) {
			mowerLog('Next start from plan: ' + (new Date(nextStartValues.plan)), true);
			nextStart = nextStartValues.plan;
		}
	}
	if(nextStartValues.lock && nextStartValues.lock >= now && nextStartValues.lock !== true && (!nextStopValues.plan || nextStopValues.plan > nextStartValues.lock || nextStopValues.plan < now - 120000)) {
		if(!nextStart || nextStartValues.lock > nextStart) {
			mowerLog('Next start from lock: ' + (new Date(nextStartValues.lock)), true);
			nextStart = nextStartValues.lock;
		}
	}
	if(mowingIsLocked && mowingLockedUntil === true) {
		nextStart = 0;
	}

	setState(DATA_BASE_ID + '.next_start', nextStart, true);
}

function calcNextStopTime(isMowing) {
	let nextStop = 0;
	let setUntil = false;
	if(!isMowing) {
		isMowing = false;
	}

	let now = (new Date()).getTime();

	mowerLog('calcNextStopTime starting: ' + JSON.stringify(nextStopValues), true);
	if(nextStopValues.charge && nextStopValues.charge >= now) {
		if(!nextStop || nextStopValues.charge < nextStop) {
			mowerLog('Next stop from charge: ' + (new Date(nextStopValues.charge)), true);
			nextStop = nextStopValues.charge;
		}
	}
	if(nextStopValues.plan && nextStopValues.plan >= now) {
		if(!nextStop || nextStopValues.plan < nextStop) {
			mowerLog('Next stop from plan: ' + (new Date(nextStopValues.plan)), true);
			nextStop = nextStopValues.plan;
			setUntil = nextStop;
		}
	}

	// calc minutes until mowing end and return it only if it differs significantly


	setState(DATA_BASE_ID + '.next_stop', nextStop, true);
	if(setUntil) {
		let now = (new Date()).getTime();
		let secs = (mowingPlannedEnd - now) / 1000;
		let nextSecs = (nextStop - now) / 1000;
		if(!isMowing || secs > 0 && Math.abs(secs - nextSecs) > 300) {
			// resend command
			return Math.floor(nextSecs / 60);
		} else {
			return;
		}
	} else {
		return;
	}
	return;
}

function calcRemainingMowingTime() {
	if(countDownTimerMowing) {
		clearInterval(countDownTimerMowing);
	}
	if(mowingHistory.length < 1 || !mowingStarted) {
		return;
	}

	let now = new Date();

	let times = [];
	let socs = [];
	let hist;
	for(let i = 0; i < mowingHistory.length; i++) {
		hist = mowingHistory[i];
		times.push(hist.time / (100 - hist.soc));
		if(!hist.stopped) {
			socs.push(hist.soc);
		}
	}

	let avgMowingTime = getArrayCleanAvg(times);
	let avgEndSoC = getArrayCleanAvg(socs);

	if(!avgMowingTime) {
		mowerLog('Could not get clean avgMowingTime: ' + JSON.stringify(times), true);
		return;
	} else if(!avgEndSoC) {
		mowerLog('Could not get clean avgEndSoC: ' + JSON.stringify(socs), true);
		return;
	} else {
		mowerLog('avgMowingTime: ' + avgMowingTime + ', avgEndSoC: ' + avgEndSoC, true);
	}

	let mowingTime = (now.getTime() - mowingStarted) / 1000;
	mowerLog('Mowing since ' + mowingTime + ' seconds.', true);

	let curSoC = getState('smartgarden.0.LOCATION_' + SG_LOCATION_ID + '.DEVICE_' + SG_DEVICE_ID + '.SERVICE_COMMON_' + SG_DEVICE_ID + '.batteryLevel_value').val;

	let remainingSoC = curSoC - avgEndSoC;
	let remainingTime = remainingSoC * avgMowingTime;
	if(remainingTime < 0) {
		remainingTime = 0;
	}

	let mowingEndTime = new Date();
	mowingEndTime.setUTCSeconds(mowingEndTime.getUTCSeconds() + remainingTime);
	if(mowingPlannedEnd && mowingEndTime.getTime() > mowingPlannedEnd) {
		mowerLog('Planned mowing end is before next charging is needed.', true);
		mowingEndTime.setTime(mowingPlannedEnd);
		remainingTime = 0;
	}

	setState(DATA_BASE_ID + '.remaining_mowing_time', remainingTime, true);
	setState(DATA_BASE_ID + '.remaining_mowing_time_str', getMinuteString(remainingTime), true);

	nextStopValues.charge = mowingEndTime.getTime();
	calcNextStopTime();

	let countDown = remainingTime;
	countDownTimerMowing = setInterval(function() {
		countDown--;
		if(countDown <= 0) {
			countDown = 0;
			if(countDownTimerMowing) {
				clearInterval(countDownTimerMowing);
			}
		}
		setState(DATA_BASE_ID + '.remaining_mowing_time', countDown, true);
		setState(DATA_BASE_ID + '.remaining_mowing_time_str', getMinuteString(countDown), true);
	}, 1000);
}

function getWeekDayIdent(weekDay) {
	let weekDayId;

	switch(weekDay) {
		case 0:
			weekDayId = 'su';
			break;
		case 1:
			weekDayId = 'mo';
			break;
		case 2:
			weekDayId = 'tu';
			break;
		case 3:
			weekDayId = 'we';
			break;
		case 4:
			weekDayId = 'th';
			break;
		case 5:
			weekDayId = 'fr';
			break;
		case 6:
			weekDayId = 'sa';
			break;
		default:
			weekDayId = 'su';
			break;
	}

	return weekDayId;
}

let now = new Date();

let nextStartValues = {
	plan: 0,
	charge: 0,
	lock: 0
};

let nextStopValues = {
	plan: 0,
	charge: 0
};

let mowingStarted;
let mowingEndSoC;
let mowingStopCommand = false;
let mowingIsLocked = false;
let mowingLockedUntil = 0;

let mowingLockStates;
try {
	mowingLockStates = JSON.parse(getState(DATA_BASE_ID + '.mowing_lock_states').val);
} catch(e) {
	mowingLockStates = null;
}
if(!mowingLockStates) {
	mowingLockStates = {};
}

let mowingTimeToday;
try {
	mowingTimeToday = JSON.parse(getState(DATA_BASE_ID + '.mowing_time_day').val);
} catch(e) {
	mowingTimeToday = null;
}
if(!mowingTimeToday || !mowingTimeToday.date) {
	mowingTimeToday = {
		date: now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate(),
		time: 0,
		lastchange: now.getTime()
	};
}

let mowingPlannedEnd = getState(DATA_BASE_ID + '.cmd_mowing_until').val;
if(mowingPlannedEnd && mowingPlannedEnd <= now.getTime()) {
	mowingPlannedEnd = null;
	setState(DATA_BASE_ID + '.cmd_mowing_until', 0, true);
}

let chargingStarted;
let chargingStartSoC;

let chargingHistory;
try {
	chargingHistory = JSON.parse(getState(DATA_BASE_ID + '.charging_history').val);
} catch(e) {
	chargingHistory = null;
}
if(!chargingHistory) {
	chargingHistory = [];
} else {
	mowerLog('Charging history read. Has ' + chargingHistory.length + ' entries.', true);
}

let mowingHistory;
try {
	mowingHistory = JSON.parse(getState(DATA_BASE_ID + '.mowing_history').val);
} catch(e) {
	mowingHistory = null;
}

if(!mowingHistory) {
	mowingHistory = [];
} else {
	if(mowingHistory.mowingTimes && mowingHistory.mowingTimes.length) {
		let tmpHistory = [];
		let tmpHist;
		for(let i = 0; i < mowingHistory.mowingTimes.length; i++) {
			tmpHist = {
				time: mowingHistory.mowingTimes[i],
				soc: mowingHistory.mowingEndSoC[i],
				stopped: false
			};
			tmpHistory.push(tmpHist);
		}
		mowingHistory = tmpHistory;
	}
	mowerLog('Mowing history read. Has ' + mowingHistory.length + ' entries.', true);
}

function checkMowingPlans() {
	let now = new Date();
	let sqldate = now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate();
	if(!mowingTimeToday || !mowingTimeToday.date || mowingTimeToday.date != sqldate) {
		mowingTimeToday = {
			date: sqldate,
			time: 0,
			lastchange: now.getTime()
		};
	}

	let weekDay = now.getDay();
	let weekDayId = getWeekDayIdent(weekDay);


	let currentPlan = MOWING_SCHEDULE[weekDayId];
	let currentMinutes = getTimeInMinutes(now.getHours() + ':' + now.getMinutes());

	// get current mowing state
	let curState = getState('smartgarden.0.LOCATION_' + SG_LOCATION_ID + '.DEVICE_' + SG_DEVICE_ID + '.SERVICE_MOWER_' + SG_DEVICE_ID + '.activity_value').val;
	let curStateCheck = '';
	switch(curState) {
		case 'PAUSED':
		case 'PARKED_TIMER':
		case 'PARKED_PARK_SELECTED':
		case 'PARKED_AUTOTIMER':
		case 'OK_SEARCHING':
			curStateCheck = 'PARK';
			break;
		case 'OK_CUTTING':
		case 'OK_CUTTING_TIMER_OVERRIDDEN':
		case 'OK_LEAVING':
		case 'OK_CHARGING':
			curStateCheck = 'MOWING';
			break;
		case 'NONE':
		default:
			curStateCheck = 'UNKNOWN';
			break;
	}

	if(curStateCheck === 'MOWING') {
		mowingTimeToday.lastchange = sqldate;
		mowingTimeToday.time = mowingTimeToday.time + ((now.getTime() - mowingTimeToday.lastchange) / 60000);
		setState(DATA_BASE_ID + '.mowing_time_day', JSON.stringify(mowingTimeToday), true);
	}0

	let desiredState = null;
	let reason = '';
	if(currentPlan) {
		desiredState = 'MOWING';
		reason = 'SCHEDULE';

		let pausefrom;
		let pauseto;
		let earliest = getTimeInMinutes(currentPlan.earliestStart);
		let latest = getTimeInMinutes(currentPlan.latestStop);

		if(currentPlan.pause && currentPlan.pause.from && currentPlan.pause.to) {
			pausefrom = getTimeInMinutes(currentPlan.pause.from);
			pauseto = getTimeInMinutes(currentPlan.pause.to);
		}

		let nextMowingEnd = currentMinutes;
		if(currentPlan.mowingTime) {
			nextMowingEnd = nextMowingEnd + currentPlan.mowingTime - mowingTimeToday.time;
		}
		if(pausefrom && pauseto && pausefrom > currentMinutes && pauseto > currentMinutes) {
			if(!nextMowingEnd || pausefrom < nextMowingEnd) {
				nextMowingEnd = pausefrom;
			}
		}
		if(latest) {
			if(!nextMowingEnd || latest < nextMowingEnd) {
				nextMowingEnd = latest;
			}
		}

		if(nextMowingEnd) {
			let tmpDate = new Date();
			tmpDate.setHours(0, nextMowingEnd, 0, 0); // is in minutes since current day's start

			nextStopValues.plan = tmpDate.getTime();
		} else {
			nextStopValues.plan = 0;
		}
		calcNextStopTime();

		let plansToCheck = [];
		for(let i = 0; i < 7; i++) {
			let tmpDay = getWeekDayIdent((weekDay + i) % 7);
			if(MOWING_SCHEDULE[tmpDay]) {
				plansToCheck.push(MOWING_SCHEDULE[tmpDay]);
			}
		}

		let nextMowingStart = 0;
		for(let i = 0; i < plansToCheck.length; i++) {
			let chkPauseFrom;
			let chkPauseTo;
			let chkPlan = plansToCheck[i];
			let chkEarliest;
			let chkLatest;

			let addMinutes = 60 * 24 * i;

			if(!chkPlan.mowing) {
				continue;
			}

			if(chkPlan.pause && chkPlan.pause.from && chkPlan.pause.to) {
				chkPauseFrom = getTimeInMinutes(chkPlan.pause.from) + addMinutes;
				chkPauseTo = getTimeInMinutes(chkPlan.pause.to) + addMinutes;
			}
			chkEarliest = getTimeInMinutes(chkPlan.earliestStart) + addMinutes;
			chkLatest = getTimeInMinutes(chkPlan.latestStop) + addMinutes;

			if(chkPauseFrom && chkPauseTo && chkPauseFrom <= currentMinutes && chkPauseTo > currentMinutes) {
				nextMowingStart = chkPauseTo;
			}
			if(chkEarliest && chkEarliest > currentMinutes) {
				if(!nextMowingStart || chkEarliest < nextMowingStart) {
					nextMowingStart = chkEarliest;
				}
			}

			if(nextMowingStart) {
				break; // found next plan
			}
		}

		if(nextMowingStart) {
			let tmpDate = new Date();
			tmpDate.setHours(0, nextMowingStart, 0, 0); // is in minutes since current day's start
			nextStartValues.plan = tmpDate.getTime();
		} else {
			nextStartValues.plan = 0;
		}
		calcNextStartTime();

		if(!currentPlan.mowing) {
			desiredState = 'PARK';
			reason = 'SCHEDULE';
		} else if(currentPlan.mowingTime && currentPlan.mowingTime <= mowingTimeToday.time) {
			desiredState = 'PARK';
			reason = 'COMPLETE';
		} else if(mowingIsLocked) {
			desiredState = 'PARK';
			reason = 'LOCKED';
		} else {
			// check if after earliestStart
			if(currentMinutes < earliest || currentMinutes > latest) {
				desiredState = 'PARK';
				reason = 'SCHEDULE';
			} else {
				// check pause time
				if(pausefrom && pauseto) {
					if(currentMinutes >= pausefrom && currentMinutes <= pauseto) {
						desiredState = 'PARK';
						reason = 'PAUSE';
					}
				}
			}
		}

		setState(DATA_BASE_ID + '.current_schedule_state', desiredState, true);
		setState(DATA_BASE_ID + '.current_schedule_reason', reason, true);

		if(curStateCheck === 'UNKNOWN') {
			mowerLog('Cannot get current state (maybe ERROR?), so not changing anything.', true);
		} else {
			mowerLog('Plan: current state: ' + curStateCheck + ', desired state: ' + desiredState, true);
			if(desiredState === 'MOWING') {
				// we should start mowing now
				let minsUntilStop = calcNextStopTime((curStateCheck === 'MOWING'));
				if(curStateCheck !== 'MOWING' && minsUntilStop) {
					mowerLog('Sending / correcting command for mowing to ' + minsUntilStop, true);
					setState('smartgarden.0.LOCATION_' + SG_LOCATION_ID + '.DEVICE_' + SG_DEVICE_ID + '.SERVICE_MOWER_' + SG_DEVICE_ID + '.activity_control_i', minsUntilStop * 60, false); // command with ack=false
				}
			} else if(desiredState === 'PARK') {
				// we should park now
				calcNextStartTime();
				if(curStateCheck !== 'PARK') {
					// send park command
					mowerLog('Sending stop command because of reason ' + reason, true);
					setState('smartgarden.0.LOCATION_' + SG_LOCATION_ID + '.DEVICE_' + SG_DEVICE_ID + '.SERVICE_MOWER_' + SG_DEVICE_ID + '.activity_control_i', 'PARK_UNTIL_FURTHER_NOTICE', false); // command with ack=false
				}
			}
		}
	} else {
		mowerLog('Missing plan for ' + weekDayId);
		setState(DATA_BASE_ID + '.current_schedule_state', '', true);
		setState(DATA_BASE_ID + '.current_schedule_reason', '', true);
	}
}

let lockTriggerTimeout;
function checkLockTriggerStates() {
	if(lockTriggerTimeout) {
		clearTimeout(lockTriggerTimeout);
	}
	let now = new Date();

	// check and listen for locks
	for(let i = 0; i < MOWING_LOCKS.length; i++) {
		let lck = MOWING_LOCKS[i];
		let curState = getState(lck.triggerStateId);
		let curValue = curState.val;
		let curSince = curState.lc;

		let triggerRange = lck.triggerStateRange;
		let triggerActive = false;
		if(triggerRange === 'lower' && curValue < lck.triggerStateValue) {
			triggerActive = true;
		} else if(triggerRange === 'greater' && curValue > lck.triggerStateValue) {
			triggerActive = true;
		} else if(triggerRange !== 'lower' && triggerRange !== 'greater' && curValue == lck.triggerStateValue) {
			triggerActive = true;
		}

		if(!(lck.triggerStateId in mowingLockStates)) {
			mowingLockStates[lck.triggerStateId] = {
				state: false,
				since: 0
			};
		}

		mowerLog('LockTrigger ' + lck.triggerStateId + ' is ' + curValue + ' -> ' + triggerActive, true);
		if(triggerActive === true) {
			mowingLockStates[lck.triggerStateId].state = true;
			mowingLockStates[lck.triggerStateId].since = curSince;
			mowerLog('LockTrigger ' + lck.triggerStateId + ' is now active since ' + (new Date(curSince)) + '.');
		} else {
			if(mowingLockStates[lck.triggerStateId].state === true) {
				if(lck.releaseDelay) {
					let release;
					if(lck.releaseDelayMultiplier) {
						let stateDuration = (now.getTime() - mowingLockStates[lck.triggerStateId].since);
						release = curSince + (parseFloat(lck.releaseDelay) * stateDuration);
					} else {
						release = curSince + (parseInt(lck.releaseDelay) * 60 * 1000);
					}
					mowingLockStates[lck.triggerStateId].state = release;
					mowerLog('LockTrigger will release at ' + (new Date(release)));
				} else {
					mowingLockStates[lck.triggerStateId].state = false;
					mowerLog('LockTrigger will release now.');
				}
			}
		}
	}

	mowingLockedUntil = 0;
	for(let trigId in mowingLockStates) {
		if(mowingLockStates[trigId] && mowingLockStates[trigId].state && (mowingLockStates[trigId].state === true || mowingLockStates[trigId].state > now.getTime())) {
			if(mowingLockedUntil !== true && mowingLockStates[trigId].state > mowingLockedUntil) {
				mowingLockedUntil = mowingLockStates[trigId].state;
			} else if(mowingLockStates[trigId].state === true) {
				mowingLockedUntil = true;
			}
		} else {
			mowingLockStates[trigId].state = false;
			mowingLockStates[trigId].since = now.getTime();
		}
	}

	setState(DATA_BASE_ID + '.mowing_lock_states', JSON.stringify(mowingLockStates), true);

	if(mowingLockedUntil) {
		mowingIsLocked = true;
		nextStartValues.lock = mowingLockedUntil;
	} else {
		mowingIsLocked = false;
		nextStartValues.lock = 0;
	}
	calcNextStartTime();

	if(MOWING_SCHEDULE_ACTIVE) {
		checkMowingPlans();
	}

	now.setHours(23, 59, 59);
	setState(DATA_BASE_ID + '.locked_until', (mowingLockedUntil === true ? now.getTime() : mowingLockedUntil), true);

	lockTriggerTimeout = setTimeout(function() {
		checkLockTriggerStates();
	}, 60000);
}

for(let i = 0; i < MOWING_LOCKS.length; i++) {
	let lck = MOWING_LOCKS[i];
	on({id: lck.triggerStateId, change: 'ne', ack: true}, function(obj) {
		checkLockTriggerStates();
	});
}
checkLockTriggerStates();

setState(DATA_BASE_ID + '.remaining_charge_time', 0, true);
setState(DATA_BASE_ID + '.remaining_charge_time_str', '', true);
setState(DATA_BASE_ID + '.remaining_mowing_time', 0, true);
setState(DATA_BASE_ID + '.remaining_mowing_time_str', '', true);

onStop(function (callback) {
	setState(DATA_BASE_ID + '.charging_history', JSON.stringify(chargingHistory), true);
	setState(DATA_BASE_ID + '.mowing_history', JSON.stringify(mowingHistory), true);
	setTimeout(callback, 1000);
}, 3000);

on({id: 'smartgarden.0.LOCATION_' + SG_LOCATION_ID + '.DEVICE_' + SG_DEVICE_ID + '.SERVICE_MOWER_' + SG_DEVICE_ID + '.activity_control_i', change: 'ne'}, function(obj) {
	if(obj.state.ack !== false) {
		// we need the commands only!
		return;
	}

	mowingPlannedEnd = null;

	let cmd = obj.state.val;

	switch (cmd) {
		case 'PARK_UNTIL_NEXT_TASK' :
		case 'PARK_UNTIL_FURTHER_NOTICE' :
			mowerLog('Manual parking command', true);
			break;
		case 'START_DONT_OVERRIDE' :
			//ignore
			break;
		default:
			let value = parseInt(cmd);
			if (value === NaN) value = 60; // seconds
			value = value - (value % 60);  // make sure that we have multiples of 60 seconds

			let plannedEndTime = new Date();
			plannedEndTime.setUTCSeconds(plannedEndTime.getUTCSeconds() + value);
			mowingPlannedEnd = plannedEndTime.getTime();
			mowerLog('Manual mowing. Planned end is at ' + plannedEndTime, true);
			setState(DATA_BASE_ID + '.cmd_mowing_until', mowingPlannedEnd, true);

			break;
	}
});

let stateChangeTimer;
on({id: 'smartgarden.0.LOCATION_' + SG_LOCATION_ID + '.DEVICE_' + SG_DEVICE_ID + '.SERVICE_MOWER_' + SG_DEVICE_ID + '.activity_value', change: 'ne'}, function(obj) {
	if(obj.state.ack !== true) {
		return;
	}

	if(stateChangeTimer) {
		clearTimeout(stateChangeTimer);
	}

	let newState = obj.state.val;
	if(newState === 'OK_LEAVING') {
		// leaving station start mowing time measure
		mowerLog('Mower is leaving the station', true);
		if(countDownTimer) {
			clearInterval(countDownTimer);
		}
		mowingStarted = (new Date()).getTime();
		mowingStopCommand = false;
		setState(DATA_BASE_ID + '.next_start', 0, true);
		setState(DATA_BASE_ID + '.remaining_charge_time', 0, true);
		setState(DATA_BASE_ID + '.remaining_charge_time_str', '', true);
		nextStartValues.charge = 0;
		calcRemainingMowingTime();
		calcNextStopTime();
	} else if(newState === 'PARKED_TIMER') {
		if(MOWING_SCHEDULE_ACTIVE) {
			// override this mode to park selected
			stateChangeTimer = setTimeout(function() {
				setState('smartgarden.0.LOCATION_' + SG_LOCATION_ID + '.DEVICE_' + SG_DEVICE_ID + '.SERVICE_MOWER_' + SG_DEVICE_ID + '.activity_control_i', 'PARK_UNTIL_FURTHER_NOTICE', false); // command with ack=false
			}, 10000); // do with 10s delay due to temporary change of this state on manual mowing command
		}
	} else if(newState === 'OK_SEARCHING') {
		if(countDownTimerMowing) {
			clearInterval(countDownTimerMowing);
		}
		setState(DATA_BASE_ID + '.next_stop', 0, true);
		setState(DATA_BASE_ID + '.remaining_mowing_time', 0, true);
		setState(DATA_BASE_ID + '.remaining_mowing_time_str', '', true);

		mowerLog('Mower ended mowing and is searching for the station', true);

		mowingEndSoC = getState('smartgarden.0.LOCATION_' + SG_LOCATION_ID + '.DEVICE_' + SG_DEVICE_ID + '.SERVICE_COMMON_' + SG_DEVICE_ID + '.batteryLevel_value').val;
		if(mowingStarted) {
			// we had a mowing start event before
			let mowingTime = ((new Date()).getTime() - mowingStarted) / 1000;

			let wasStopped = false;
			let now = (new Date()).getTime();
			if(mowingStopCommand === true || now >= mowingPlannedEnd) {
				wasStopped = true;
			}

			// reset value
			mowingStopCommand = false;

			if(mowingTime >= 1800) {
				mowingHistory.push({
					time: mowingTime,
					soc: mowingEndSoC,
					stopped: wasStopped
				});

				let keep = 0;
				let nonStopped = 0;
				for(let i = mowingHistory.length - 1; i >= 0 ; i--) {
					keep++;
					if(!mowingHistory[i].stopped) {
						nonStopped++;
						if(nonStopped >= 10) {
							break;
						}
					}
				}
				while(mowingHistory.length > keep) {
					mowingHistory.shift();
				}

				mowerLog('We have now ' + mowingHistory.length + ' mowing history entries. Added mowingTime ' + mowingTime + 's with endSoC of ' + mowingEndSoC + '%', true);

				setState(DATA_BASE_ID + '.mowing_history', JSON.stringify(mowingHistory), true);
			}

			mowingStarted = null;
		}

		let now = (new Date()).getTime();
		if(now >= mowingPlannedEnd) {
			setState(DATA_BASE_ID + '.cmd_mowing_until', 0, true);
		}
	}
});

let tmpCheckBat = getState('smartgarden.0.LOCATION_' + SG_LOCATION_ID + '.DEVICE_' + SG_DEVICE_ID + '.SERVICE_COMMON_' + SG_DEVICE_ID + '.batteryState_value').val;
if(tmpCheckBat === 'CHARGING') {
	let curSoC = getState('smartgarden.0.LOCATION_' + SG_LOCATION_ID + '.DEVICE_' + SG_DEVICE_ID + '.SERVICE_COMMON_' + SG_DEVICE_ID + '.batteryLevel_value').val;

	mowerLog('Mower is charging now at script start, soc is ' + curSoC + '%.', true);

	chargingStartSoC = curSoC;
	chargingStarted = (new Date()).getTime();
	calcRemainingChargingTime(100 - curSoC);
}

let tmpCheckMow = getState('smartgarden.0.LOCATION_' + SG_LOCATION_ID + '.DEVICE_' + SG_DEVICE_ID + '.SERVICE_MOWER_' + SG_DEVICE_ID + '.activity_mowing_i').val;
let mowerState = getState('smartgarden.0.LOCATION_' + SG_LOCATION_ID + '.DEVICE_' + SG_DEVICE_ID + '.SERVICE_MOWER_' + SG_DEVICE_ID + '.state_value').val;
if(tmpCheckMow === true && mowerState === 'OK') {
	// check for last state change
	let actState = getState('smartgarden.0.LOCATION_' + SG_LOCATION_ID + '.DEVICE_' + SG_DEVICE_ID + '.SERVICE_MOWER_' + SG_DEVICE_ID + '.activity_value');
	if(actState.ack === true && actState.val !== 'OK_SEARCHING') {
		mowingStarted = actState.lc;
		calcRemainingMowingTime();
	}
}

on({id: 'smartgarden.0.LOCATION_' + SG_LOCATION_ID + '.DEVICE_' + SG_DEVICE_ID + '.SERVICE_COMMON_' + SG_DEVICE_ID + '.batteryState_value', change: 'ne'}, function(obj) {
	if(obj.state.ack !== true) {
		return;
	}

	let newState = obj.state.val;

	if(newState === 'CHARGING') {
		mowerLog('Mower started charging now.', true);
		setState(DATA_BASE_ID + '.remaining_mowing_time', 0, true);
		setState(DATA_BASE_ID + '.remaining_mowing_time_str', '', true);
		nextStopValues.charge = 0;
		calcNextStopTime();

		let curSoC = getState('smartgarden.0.LOCATION_' + SG_LOCATION_ID + '.DEVICE_' + SG_DEVICE_ID + '.SERVICE_COMMON_' + SG_DEVICE_ID + '.batteryLevel_value').val;
		chargingStartSoC = curSoC;
		chargingStarted = (new Date()).getTime();
		calcRemainingChargingTime((100 - curSoC));
	} else if(newState === 'OK' && obj.oldState.val === 'CHARGING') {
		setState(DATA_BASE_ID + '.remaining_charge_time', 0, true);
		setState(DATA_BASE_ID + '.remaining_charge_time_str', '', true);

		if(!chargingStarted) {
			// no current charging start value
			return;
		}

		let curSoC = getState('smartgarden.0.LOCATION_' + SG_LOCATION_ID + '.DEVICE_' + SG_DEVICE_ID + '.SERVICE_COMMON_' + SG_DEVICE_ID + '.batteryLevel_value').val;
		if(curSoC < 99) {
			mowerLog('Charging ended before reaching 100%. Not using this history entry.', true);
			return;
		}

		mowerLog('Charging completed', true);

		let chargingTime = ((new Date()).getTime() - chargingStarted) / 1000;
		let chargedPercentage = 100 - chargingStartSoC;
		if(chargedPercentage < 50) {
			mowerLog('Only ' + chargedPercentage + '% charged. Ignoring this cycle.', true);
		} else {
			chargingHistory.push({
				'time': chargingTime,
				'percentage': chargedPercentage
			});
			while(chargingHistory.length > 10) {
				chargingHistory.shift();
			}

			chargingStarted = null;
			chargingStartSoC = null;

			mowerLog('We have now ' + chargingHistory.length + ' charging history entries. Added entry with ' + chargingTime + 's for ' + chargedPercentage + '%', true);
			setState(DATA_BASE_ID + '.charging_history', JSON.stringify(chargingHistory), true);
		}
	}
});

on({id: 'smartgarden.0.LOCATION_' + SG_LOCATION_ID + '.DEVICE_' + SG_DEVICE_ID + '.SERVICE_COMMON_' + SG_DEVICE_ID + '.batteryLevel_value', change: 'ne'}, function(obj) {
	if(obj.state.ack !== true) {
		return;
	}

	let newSoC = obj.state.val;
	if(newSoC <= obj.oldState.val) {
		// possibly mowing

		let mowing = getState('smartgarden.0.LOCATION_' + SG_LOCATION_ID + '.DEVICE_' + SG_DEVICE_ID + '.SERVICE_MOWER_' + SG_DEVICE_ID + '.activity_mowing_i').val;
		let mowerState = getState('smartgarden.0.LOCATION_' + SG_LOCATION_ID + '.DEVICE_' + SG_DEVICE_ID + '.SERVICE_MOWER_' + SG_DEVICE_ID + '.state_value').val;
		if(mowing === true && mowerState === 'OK') {
			// currently mowing
			calcRemainingMowingTime();
		}
	} else {
		calcRemainingChargingTime(100 - newSoC);
	}
});
