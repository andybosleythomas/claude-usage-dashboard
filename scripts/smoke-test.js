#!/usr/bin/env node
// Quick regression check against a running `node server.js` instance.
// Run with: node scripts/smoke-test.js [baseUrl]
// Exits non-zero on the first failure so it's CI/pre-commit friendly.

const BASE = process.argv[2] || 'http://localhost:4173';
let failures = 0;

function check(label, cond) {
  if (cond) { console.log(`  ok   ${label}`); }
  else { console.error(`  FAIL ${label}`); failures++; }
}

async function getJSON(path) {
  const res = await fetch(BASE + path);
  const body = await res.json();
  return { status: res.status, body };
}

async function main() {
  console.log(`Smoke-testing ${BASE} ...\n`);

  console.log('GET /api/data');
  const data = await getJSON('/api/data');
  check('status 200', data.status === 200);
  check('records is an array', Array.isArray(data.body.records));
  check('records have a commits field', data.body.records.length === 0 || 'commits' in data.body.records[0]);
  check('clientsConfig.clients is an object', typeof data.body.clientsConfig?.clients === 'object');

  const clientNames = Object.keys(data.body.clientsConfig?.clients || {});

  console.log('\nGET /api/insights (no filters)');
  const insAll = await getJSON('/api/insights');
  check('status 200', insAll.status === 200);
  check('has cacheCostBreakdown', typeof insAll.body.cacheCostBreakdown === 'object');
  check('has toolTaxonomy array', Array.isArray(insAll.body.toolTaxonomy));
  check('has rework object', typeof insAll.body.rework === 'object');
  check('has costPerCommit object', typeof insAll.body.costPerCommit === 'object');

  if (clientNames.length > 0) {
    const name = clientNames[0];
    console.log(`\nGET /api/insights?client=${name} (regression check: client filter must actually filter)`);
    const insClient = await getJSON(`/api/insights?client=${encodeURIComponent(name)}`);
    check('status 200', insClient.status === 200);
    check(
      'focusRatio.activeHours is a positive number OR the client genuinely has 0 active hours (manual check if this looks wrong)',
      typeof insClient.body.focusRatio?.activeHours === 'number'
    );
    check('manualEquivalent is present for a named client', insClient.body.manualEquivalent !== null);

    console.log(`\nGET /api/invoice?client=${name}`);
    const inv = await getJSON(`/api/invoice?client=${encodeURIComponent(name)}&month=all`);
    check('status 200', inv.status === 200);
    check('has rates', typeof inv.body.rates?.activeRate === 'number');
    check('has roundingIncrementMinutes', typeof inv.body.roundingIncrementMinutes === 'number');
    check('lineItems is an array', Array.isArray(inv.body.lineItems));
    check('expenseItems is an array', Array.isArray(inv.body.expenseItems));
    check('grandTotal equals time total + expenses total', Math.abs(inv.body.grandTotal - (inv.body.totals.amount + inv.body.expensesTotal)) < 0.01);
    check('lineItems is empty OR each item carries a summary key (may be null)', inv.body.lineItems.length === 0 || 'summary' in inv.body.lineItems[0]);

    const firstRepo = data.body.records[0]?.repo;
    if (firstRepo) {
      console.log(`\nGET /api/repo-commits?repo=${firstRepo}`);
      const rc = await getJSON(`/api/repo-commits?repo=${encodeURIComponent(firstRepo)}`);
      check('status 200', rc.status === 200);
      check('has an "available" boolean', typeof rc.body.available === 'boolean');
      check('available=false always carries a reason', rc.body.available || typeof rc.body.reason === 'string');
    }
  } else {
    console.log('\n(skipping client-scoped checks -- no clients configured)');
  }

  const today = new Date().toISOString().slice(0, 10);
  console.log(`\nGET /api/time-entries?date=${today}`);
  const timeEntries = await getJSON(`/api/time-entries?date=${today}`);
  check('status 200', timeEntries.status === 200);
  check('repoRows is an array', Array.isArray(timeEntries.body.repoRows));
  check('clientRows is an array', Array.isArray(timeEntries.body.clientRows));
  check('repoRows is empty OR each row carries summary/summarySource keys', timeEntries.body.repoRows.length === 0 || ('summary' in timeEntries.body.repoRows[0] && 'summarySource' in timeEntries.body.repoRows[0]));

  const curMonth = today.slice(0, 7);
  console.log(`\nGET /api/time-entries-summary?month=${curMonth}`);
  const timeSummary = await getJSON(`/api/time-entries-summary?month=${curMonth}`);
  check('status 200', timeSummary.status === 200);
  check('manualHours is a number', typeof timeSummary.body.manualHours === 'number');
  check('adjustedDays is a number', typeof timeSummary.body.adjustedDays === 'number');

  console.log('\nGET /api/expenses');
  const expenses = await getJSON('/api/expenses');
  check('status 200', expenses.status === 200);
  check('expenses is an array', Array.isArray(expenses.body.expenses));

  console.log('\nGET / (dashboard page)');
  const page = await fetch(BASE + '/');
  check('status 200', page.status === 200);
  const html = await page.text();
  check('no embedded __CHART_DATA__ placeholder (legacy artifact)', !html.includes('__CHART_DATA__'));
  check('page has no null bytes (regression check for the 2026-08-03 corruption bug)', !html.includes('' + String.fromCharCode(0) + ''));

  console.log(`\n${failures === 0 ? 'All checks passed.' : failures + ' check(s) FAILED.'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('Smoke test crashed:', e); process.exit(1); });
