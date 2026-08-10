const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  computeCostAnomaly, computeForecast, computeRoundedHours, computeStreaks,
  addInterval, materializeOccurrenceDates, computeEffectiveHours,
} = require('../lib/calc');

test('computeCostAnomaly returns null with fewer than 8 days of history', () => {
  const costByDay = { '2026-08-01': 100, '2026-08-02': 100 };
  assert.equal(computeCostAnomaly(costByDay), null);
});

test('computeCostAnomaly returns null without 3+ same-weekday occurrences', () => {
  // 8 consecutive days is enough total history, but each weekday only
  // appears once except the last -- not enough for a same-weekday baseline.
  const costByDay = {};
  for (let i = 0; i < 8; i++) {
    costByDay[`2026-08-0${i + 1}`] = 100;
  }
  assert.equal(computeCostAnomaly(costByDay), null);
});

test('computeCostAnomaly flags a real spike above the $20 floor and z>2', () => {
  // 2026-08-03 is a Monday. Prior Mondays: 07-06, 07-13, 07-20, 07-27, with
  // some natural variance (45/50/55/50) so stddev isn't zero -- a baseline
  // with zero variance would make z=0 by construction (tested separately).
  const costByDay = {
    '2026-07-06': 45, '2026-07-13': 50, '2026-07-20': 55, '2026-07-27': 50,
    '2026-07-28': 10, '2026-07-29': 10, '2026-07-30': 10, '2026-07-31': 10,
    '2026-08-03': 500, // today: way above the ~$50 baseline
  };
  const result = computeCostAnomaly(costByDay);
  assert.ok(result, 'expected an anomaly result, got null');
  assert.equal(result.day, '2026-08-03');
  assert.equal(result.isAnomalous, true);
  assert.equal(result.baselineMean, 50);
  assert.ok(result.z > 2, `expected z > 2, got ${result.z}`);
});

test('computeCostAnomaly gives z=0 (not flagged) when the baseline has zero variance', () => {
  // Every prior Monday cost exactly the same -- stddev is 0, so z must be 0
  // by construction (dividing by zero stddev is explicitly guarded against),
  // even though today's cost differs from the baseline.
  const costByDay = {
    '2026-07-06': 50, '2026-07-13': 50, '2026-07-20': 50, '2026-07-27': 50,
    '2026-07-28': 10, '2026-07-29': 10, '2026-07-30': 10, '2026-07-31': 10,
    '2026-08-03': 500,
  };
  const result = computeCostAnomaly(costByDay);
  assert.ok(result);
  assert.equal(result.z, 0);
  assert.equal(result.isAnomalous, false);
});

test('computeCostAnomaly does not flag a quiet day even with high z (dollar floor)', () => {
  // Same-weekday baseline is tiny ($1), so a $5 "spike" has a huge z-score
  // but is nowhere near the $20 floor -- must not be flagged.
  const costByDay = {
    '2026-07-06': 1, '2026-07-13': 1, '2026-07-20': 1, '2026-07-27': 1,
    '2026-07-28': 10, '2026-07-29': 10, '2026-07-30': 10, '2026-07-31': 10,
    '2026-08-03': 5,
  };
  const result = computeCostAnomaly(costByDay);
  assert.ok(result);
  assert.equal(result.isAnomalous, false);
});

test('computeForecast projects a straight run-rate for the current month', () => {
  const costByDay = { '2026-08-01': 100, '2026-08-02': 100, '2026-08-03': 100 };
  const nowBris = new Date('2026-08-03T12:00:00Z'); // day 3 of a 31-day month
  const result = computeForecast(costByDay, nowBris);
  assert.equal(result.mtdCost, 300);
  assert.equal(result.daysElapsed, 3);
  assert.equal(result.daysInMonth, 31);
  assert.equal(result.projectedTotal, Math.round((300 / 3) * 31 * 100) / 100);
});

test('computeForecast returns null when there is no data for the current month', () => {
  const costByDay = { '2026-07-15': 100 };
  const nowBris = new Date('2026-08-03T12:00:00Z');
  assert.equal(computeForecast(costByDay, nowBris), null);
});

test('computeRoundedHours leaves hours unchanged when incrementMinutes is 0', () => {
  const result = computeRoundedHours(1.3, 4.7, 0);
  assert.equal(result.activeHours, 1.3);
  assert.equal(result.idleHours, 4.7);
});

test('computeRoundedHours rounds the total to the nearest 15 minutes and preserves the active/idle ratio', () => {
  // total = 9.54h -> nearest 0.25h (15 min) is 9.5h. scale = 9.5/9.54.
  const result = computeRoundedHours(0.11, 9.43, 15);
  const total = result.activeHours + result.idleHours;
  assert.ok(Math.abs(total - 9.5) < 1e-9, `expected total ~9.5, got ${total}`);
  const ratio = result.activeHours / result.idleHours;
  const originalRatio = 0.11 / 9.43;
  assert.ok(Math.abs(ratio - originalRatio) < 1e-9, 'active/idle ratio should be preserved');
});

test('computeRoundedHours handles zero raw hours without dividing by zero', () => {
  const result = computeRoundedHours(0, 0, 15);
  assert.equal(result.activeHours, 0);
  assert.equal(result.idleHours, 0);
});

test('computeStreaks finds the longest run across a gap', () => {
  const days = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-10', '2026-07-11'];
  const result = computeStreaks(days, '2026-07-11');
  assert.equal(result.longestStreak, 3);
  assert.equal(result.currentStreak, 2); // the run ending on the last day
});

test('computeStreaks reports currentStreak=0 when the last active day is not today or yesterday', () => {
  const days = ['2026-07-01', '2026-07-02', '2026-07-03'];
  const result = computeStreaks(days, '2026-07-10'); // 7 days after the last activity
  assert.equal(result.longestStreak, 3);
  assert.equal(result.currentStreak, 0);
});

test('computeStreaks handles a single day', () => {
  const result = computeStreaks(['2026-07-01'], '2026-07-01');
  assert.equal(result.longestStreak, 1);
  assert.equal(result.currentStreak, 1);
});

test('computeStreaks handles no days at all', () => {
  const result = computeStreaks([], '2026-07-01');
  assert.equal(result.longestStreak, 0);
  assert.equal(result.currentStreak, 0);
});

test('addInterval steps a plain weekly recurrence', () => {
  assert.equal(addInterval('2026-08-04', 'weekly'), '2026-08-11');
});

test('addInterval clamps Jan 31 + monthly to Feb 28 in a non-leap year', () => {
  assert.equal(addInterval('2026-01-31', 'monthly'), '2026-02-28');
});

test('addInterval clamps Jan 31 + monthly to Feb 29 in a leap year', () => {
  assert.equal(addInterval('2028-01-31', 'monthly'), '2028-02-29');
});

test('addInterval rolls Dec + monthly into January of the next year', () => {
  assert.equal(addInterval('2026-12-15', 'monthly'), '2027-01-15');
});

test('addInterval keeps clamping month over month (Jan 31 -> Feb 28 -> Mar 28, not back to 31)', () => {
  const feb = addInterval('2026-01-31', 'monthly');
  const mar = addInterval(feb, 'monthly');
  assert.equal(feb, '2026-02-28');
  assert.equal(mar, '2026-03-28');
});

test('addInterval steps yearly and clamps Feb 29 anchors in a non-leap target year', () => {
  assert.equal(addInterval('2028-02-29', 'yearly'), '2029-02-28');
});

test('materializeOccurrenceDates generates monthly occurrences up to and including throughDate', () => {
  const dates = materializeOccurrenceDates('2026-05-15', 'monthly', '2026-08-20', []);
  assert.deepEqual(dates, ['2026-06-15', '2026-07-15', '2026-08-15']);
});

test('materializeOccurrenceDates stops before throughDate when the next occurrence would exceed it', () => {
  const dates = materializeOccurrenceDates('2026-05-15', 'monthly', '2026-06-20', []);
  assert.deepEqual(dates, ['2026-06-15']);
});

test('materializeOccurrenceDates skips dates already present (idempotent re-run)', () => {
  const dates = materializeOccurrenceDates('2026-05-15', 'monthly', '2026-08-20', ['2026-06-15', '2026-07-15']);
  assert.deepEqual(dates, ['2026-08-15']);
});

test('materializeOccurrenceDates returns nothing when throughDate is before the first occurrence', () => {
  const dates = materializeOccurrenceDates('2026-05-15', 'monthly', '2026-05-20', []);
  assert.deepEqual(dates, []);
});

test('computeEffectiveHours passes through unchanged with no adjustment or manual time', () => {
  const result = computeEffectiveHours(2.5, 4, null, 0);
  assert.equal(result.activeHours, 2.5);
  assert.equal(result.spanHours, 4);
  assert.equal(result.adjusted, false);
});

test('computeEffectiveHours: adjustment replaces active hours, not adds to them', () => {
  const result = computeEffectiveHours(2.5, 4, 6, 0);
  assert.equal(result.activeHours, 6);
  assert.equal(result.adjusted, true);
});

test('computeEffectiveHours widens spanHours when an adjustment exceeds the auto-detected span', () => {
  // auto span was only 4h but the adjustment says 6h of real work happened.
  const result = computeEffectiveHours(2.5, 4, 6, 0);
  assert.equal(result.spanHours, 6);
});

test('computeEffectiveHours adds manual hours on top of active AND span, generating no synthetic idle', () => {
  const result = computeEffectiveHours(2.5, 4, null, 1.5);
  assert.equal(result.activeHours, 4); // 2.5 + 1.5
  assert.equal(result.spanHours, 5.5); // 4 + 1.5 -- idle gap (span-active) stays the original 1.5h, untouched by manual
  assert.equal(result.spanHours - result.activeHours, 1.5);
  assert.equal(result.adjusted, true);
});

test('computeEffectiveHours combines an adjustment and manual time together', () => {
  const result = computeEffectiveHours(2.5, 4, 6, 1);
  assert.equal(result.activeHours, 7); // 6 + 1
  assert.equal(result.spanHours, 7); // max(4,6) + 1
  assert.equal(result.adjusted, true);
});

test('computeEffectiveHours handles a repo with zero auto activity but manual time logged', () => {
  const result = computeEffectiveHours(0, 0, null, 2);
  assert.equal(result.activeHours, 2);
  assert.equal(result.spanHours, 2);
  assert.equal(result.adjusted, true);
});
