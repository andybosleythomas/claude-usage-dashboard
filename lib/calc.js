// Pure, dependency-free computation functions -- no DB, no HTTP, no Date.now()
// side effects (callers pass in "now" explicitly) so these can be unit
// tested directly. Extracted from server.js after several feature cycles
// made the inline versions hard to verify in isolation.

const MIN_DOLLAR_FLOOR = 20;
const Z_THRESHOLD = 2.0;

// costByDay: { 'YYYY-MM-DD': number }. Returns null if there isn't enough
// history for a same-weekday baseline (needs 8+ distinct days total, and at
// least 3 prior occurrences of the most recent day's weekday).
function computeCostAnomaly(costByDay) {
  const allDaysSorted = Object.keys(costByDay).sort();
  if (allDaysSorted.length < 8) return null;

  const lastDay = allDaysSorted[allDaysSorted.length - 1];
  const lastDow = new Date(lastDay + 'T00:00:00Z').getUTCDay();
  const sameDow = allDaysSorted
    .filter(d => d !== lastDay && new Date(d + 'T00:00:00Z').getUTCDay() === lastDow)
    .slice(-8);
  if (sameDow.length < 3) return null;

  const vals = sameDow.map(d => costByDay[d]);
  const mean = vals.reduce((a, v) => a + v, 0) / vals.length;
  const variance = vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length;
  const stddev = Math.sqrt(variance);
  const todayCost = costByDay[lastDay];
  const z = stddev > 0 ? (todayCost - mean) / stddev : 0;

  return {
    day: lastDay,
    cost: Math.round(todayCost * 100) / 100,
    baselineMean: Math.round(mean * 100) / 100,
    pctAboveBaseline: mean > 0 ? Math.round((todayCost - mean) / mean * 100) : null,
    z: Math.round(z * 100) / 100,
    isAnomalous: z > Z_THRESHOLD && (todayCost - mean) > MIN_DOLLAR_FLOOR,
  };
}

// costByDay: { 'YYYY-MM-DD': number }. nowBris: a Date already shifted into
// Brisbane local time (caller adds the UTC+10 offset before calling).
// Returns null if there's no data yet for nowBris's calendar month.
function computeForecast(costByDay, nowBris) {
  const curMonth = nowBris.toISOString().slice(0, 7);
  const daysInMonth = new Date(Date.UTC(nowBris.getUTCFullYear(), nowBris.getUTCMonth() + 1, 0)).getUTCDate();
  const dayOfMonth = nowBris.getUTCDate();
  const mtdDays = Object.keys(costByDay).filter(d => d.slice(0, 7) === curMonth);
  if (mtdDays.length === 0) return null;

  const mtdCost = mtdDays.reduce((a, d) => a + costByDay[d], 0);
  const projected = (mtdCost / dayOfMonth) * daysInMonth;
  return {
    month: curMonth, mtdCost: Math.round(mtdCost * 100) / 100,
    daysElapsed: dayOfMonth, daysInMonth,
    projectedTotal: Math.round(projected * 100) / 100,
  };
}

// Rounds (activeHours + idleHours) to the nearest incrementMinutes, then
// rescales both proportionally so the active/idle ratio is preserved.
// incrementMinutes <= 0 means "no rounding" -- returns the inputs unchanged.
function computeRoundedHours(activeHours, idleHours, incrementMinutes) {
  if (!(incrementMinutes > 0)) return { activeHours, idleHours };
  const incrementHours = incrementMinutes / 60;
  const rawTotal = activeHours + idleHours;
  if (rawTotal <= 0) return { activeHours: 0, idleHours: 0 };
  const roundedTotal = Math.round(rawTotal / incrementHours) * incrementHours;
  const scale = roundedTotal / rawTotal;
  return { activeHours: activeHours * scale, idleHours: idleHours * scale };
}

// distinctDaysSorted: ['YYYY-MM-DD', ...] ascending, no duplicates.
// todayStr: 'YYYY-MM-DD' for "today" in the same calendar system as the
// input days (caller resolves "today" in whatever timezone matters).
function computeStreaks(distinctDaysSorted, todayStr) {
  if (distinctDaysSorted.length === 0) return { currentStreak: 0, longestStreak: 0 };

  let longestStreak = 0, run = 0;
  for (let i = 0; i < distinctDaysSorted.length; i++) {
    if (i === 0) { run = 1; }
    else {
      const prev = new Date(distinctDaysSorted[i - 1]);
      const cur = new Date(distinctDaysSorted[i]);
      const diffDays = Math.round((cur - prev) / 86400000);
      run = diffDays === 1 ? run + 1 : 1;
    }
    longestStreak = Math.max(longestStreak, run);
  }

  const lastDay = new Date(distinctDaysSorted[distinctDaysSorted.length - 1]);
  const today = new Date(todayStr);
  const gapFromToday = Math.round((today - lastDay) / 86400000);
  const currentStreak = gapFromToday <= 1 ? run : 0;

  return { currentStreak, longestStreak };
}

// dateStr: 'YYYY-MM-DD'. interval: 'weekly' | 'monthly' | 'yearly'. Steps
// forward exactly one interval, clamping month/year-end overflow to the
// target month's last day instead of rolling into the next month (e.g. Jan
// 31 + monthly -> Feb 28/29, not Mar 3) -- plain UTC-millis arithmetic would
// silently do the latter.
function addInterval(dateStr, interval) {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (interval === 'weekly') {
    return new Date(Date.UTC(y, m - 1, d + 7)).toISOString().slice(0, 10);
  }
  const monthsToAdd = interval === 'yearly' ? 12 : 1;
  const totalMonths = (m - 1) + monthsToAdd;
  const targetY = y + Math.floor(totalMonths / 12);
  const targetM = (totalMonths % 12) + 1; // 1-indexed
  const lastDayOfTargetMonth = new Date(Date.UTC(targetY, targetM, 0)).getUTCDate();
  const day = Math.min(d, lastDayOfTargetMonth);
  return new Date(Date.UTC(targetY, targetM - 1, day)).toISOString().slice(0, 10);
}

// Generates the missing occurrence dates for a recurring expense: starting
// the interval after anchorDate (the template's own ExpenseDate), stepping
// forward through throughDate inclusive (callers pass "today" in whatever
// timezone matters), skipping any date already present. Bounded to 1000
// steps as a runaway-input guard (a weekly recurrence with no end date run
// through a far-future throughDate).
function materializeOccurrenceDates(anchorDate, interval, throughDate, existingDates) {
  const existing = new Set(existingDates);
  const out = [];
  let cur = addInterval(anchorDate, interval);
  let guard = 0;
  while (cur <= throughDate && guard < 1000) {
    if (!existing.has(cur)) out.push(cur);
    cur = addInterval(cur, interval);
    guard++;
  }
  return out;
}

// Merges a manual Time-tab override onto a repo/day's auto-computed hours.
// adjustmentHours (number or null/undefined): replaces rawActiveHours when
// present -- a correction to that day's total, not a delta on top of it.
// manualHours (number, default 0): added on top afterwards -- separate
// non-Claude time (meetings, planning) with no session span of its own.
// spanHours is widened to at least the adjusted-active figure (an
// adjustment can raise active time past the auto-detected session span,
// e.g. the log missed part of the work) and then gets the same manual
// hours added, so idle time (spanHours - activeHours downstream) only ever
// reflects the gap within the Claude-tracked portion -- manual hours never
// generate synthetic idle time.
function computeEffectiveHours(rawActiveHours, rawSpanHours, adjustmentHours, manualHours) {
  const adjustedActive = adjustmentHours != null ? adjustmentHours : rawActiveHours;
  const manual = manualHours || 0;
  return {
    activeHours: adjustedActive + manual,
    spanHours: Math.max(rawSpanHours, adjustedActive) + manual,
    adjusted: adjustmentHours != null || manual > 0,
  };
}

module.exports = {
  computeCostAnomaly, computeForecast, computeRoundedHours, computeStreaks,
  addInterval, materializeOccurrenceDates, computeEffectiveHours,
};
