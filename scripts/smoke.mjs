#!/usr/bin/env node
/**
 * HTTP smoke check against a running API instance. Posts the canonical
 * cross-week + missing-packet sample and asserts the recovered interpretation.
 *
 * Usage: node scripts/smoke.mjs [baseUrl]
 * Exit code 0 on success, 1 on any failure.
 */

const baseUrl = process.argv[2] ?? process.env.API_BASE_URL ?? 'http://127.0.0.1:3000';

const sample = {
  modulus: 10,
  countLower: 0,
  countUpper: 120,
  minInterval: 9,
  maxInterval: 11,
  packets: [
    { id: 'G', remainder: 1, timeLower: 307, timeUpper: 313 },
    { id: 'A', remainder: 8, timeLower: 77, timeUpper: 83 },
    { id: 'F', remainder: 0, timeLower: 297, timeUpper: 303 },
    { id: 'C', remainder: 2, timeLower: 117, timeUpper: 123 },
    { id: 'B', remainder: 9, timeLower: 87, timeUpper: 93 },
    { id: 'E', remainder: 2, timeLower: 217, timeUpper: 223 },
    { id: 'D', remainder: 1, timeLower: 207, timeUpper: 213 },
  ],
};

const expectedOrder = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const expectedCounts = [8, 9, 12, 21, 22, 30, 31];
const expectedMissing = [
  [10, 11],
  [13, 20],
  [23, 29],
];

/**
 * Low-battery dormancy scenario: identical counter truth, but the buoy paused
 * sampling once between D and E (counter frozen, wall clock kept running).
 * Only explainable with the dormancy model — the same packets without the
 * dormancy fields must yield NO_CONSISTENT_INTERPRETATION.
 */
const dormantSample = {
  modulus: 10,
  countLower: 0,
  countUpper: 120,
  minInterval: 9,
  maxInterval: 11,
  dormancyLower: 40,
  dormancyUpper: 60,
  packets: [
    { id: 'G', remainder: 1, timeLower: 358, timeUpper: 364 },
    { id: 'A', remainder: 8, timeLower: 77, timeUpper: 83 },
    { id: 'F', remainder: 0, timeLower: 348, timeUpper: 354 },
    { id: 'C', remainder: 2, timeLower: 117, timeUpper: 123 },
    { id: 'B', remainder: 9, timeLower: 87, timeUpper: 93 },
    { id: 'E', remainder: 2, timeLower: 268, timeUpper: 274 },
    { id: 'D', remainder: 1, timeLower: 207, timeUpper: 213 },
  ],
};

const dormantExpected = {
  order: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
  counts: [8, 9, 12, 21, 22, 30, 31],
  duration: 50,
  boundaryIndex: 3,
  fromId: 'D',
  toId: 'E',
};

function fail(message) {
  console.error(`SMOKE FAILED: ${message}`);
  process.exit(1);
}

async function main() {
  // 1. Health endpoint.
  const healthRes = await fetch(`${baseUrl}/health`);
  if (!healthRes.ok) fail(`GET /health returned ${healthRes.status}`);
  const health = await healthRes.json();
  if (health.status !== 'ok') fail(`health payload not ok: ${JSON.stringify(health)}`);

  // 2. Recovery on the cross-week sample.
  const res = await fetch(`${baseUrl}/api/v1/recover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sample),
  });
  if (res.status !== 200) {
    fail(`POST /api/v1/recover returned ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  if (body.status !== 'ok') fail(`response status not ok: ${JSON.stringify(body)}`);

  const { data } = body;
  if (JSON.stringify(data.order) !== JSON.stringify(expectedOrder)) {
    fail(`wrong order: got ${JSON.stringify(data.order)}`);
  }
  const counts = data.assignments.map((a) => a.absoluteCount);
  if (JSON.stringify(counts) !== JSON.stringify(expectedCounts)) {
    fail(`wrong absolute counts: got ${JSON.stringify(counts)}`);
  }
  for (let k = 1; k < data.assignments.length; k++) {
    const prev = data.assignments[k - 1];
    const cur = data.assignments[k];
    if (cur.absoluteCount <= prev.absoluteCount) fail('counts not strictly increasing');
    if (cur.time <= prev.time) fail('timestamps not strictly increasing');
    if (((cur.absoluteCount % 10) + 10) % 10 !== cur.remainder) fail('count/remainder mismatch');
    if (cur.time < cur.timeInterval.lower || cur.time > cur.timeInterval.upper) {
      fail('selected time outside packet closed interval');
    }
  }
  const segments = data.missingSegments.map((s) => [s.fromCount, s.toCount]);
  if (JSON.stringify(segments) !== JSON.stringify(expectedMissing)) {
    fail(`wrong missing segments: got ${JSON.stringify(segments)}`);
  }
  if (data.missingCountTotal !== 17) fail(`wrong missing total: ${data.missingCountTotal}`);
  if (data.adjacency.length !== 6) fail('expected 6 adjacency evidence entries');
  for (const ev of data.adjacency) {
    if (!ev.satisfied) fail(`unsatisfied adjacency evidence: ${JSON.stringify(ev)}`);
    if (ev.timeGap < ev.allowedTimeGap.min || ev.timeGap > ev.allowedTimeGap.max) {
      fail(`time gap ${ev.timeGap} outside [${ev.allowedTimeGap.min}, ${ev.allowedTimeGap.max}]`);
    }
  }

  // 3. Infeasible request must surface the stable business error code.
  const bad = await fetch(`${baseUrl}/api/v1/recover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...sample, countUpper: 3 }),
  });
  if (bad.status !== 400 && bad.status !== 422) {
    fail(`infeasible request returned HTTP ${bad.status}`);
  }
  const badBody = await bad.json();
  if (badBody.status !== 'error' || !badBody.error.code) fail('error body missing stable code');

  // 4. Dormancy model: the low-battery sample is only explainable with the
  //    pause fields, and must report the recovered pause.
  const dormantRes = await fetch(`${baseUrl}/api/v1/recover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dormantSample),
  });
  if (dormantRes.status !== 200) {
    fail(`dormancy sample returned ${dormantRes.status}: ${await dormantRes.text()}`);
  }
  const dormantBody = await dormantRes.json();
  if (dormantBody.status !== 'ok') fail(`dormancy response not ok: ${JSON.stringify(dormantBody)}`);
  const dd = dormantBody.data;
  if (JSON.stringify(dd.order) !== JSON.stringify(dormantExpected.order)) {
    fail(`dormancy: wrong order: ${JSON.stringify(dd.order)}`);
  }
  const dCounts = dd.assignments.map((a) => a.absoluteCount);
  if (JSON.stringify(dCounts) !== JSON.stringify(dormantExpected.counts)) {
    fail(`dormancy: wrong counts: ${JSON.stringify(dCounts)}`);
  }
  if (!dd.dormancy) fail('dormancy: response missing the recovered pause');
  if (dd.dormancy.duration !== dormantExpected.duration) {
    fail(`dormancy: wrong duration: ${dd.dormancy.duration}`);
  }
  if (dd.dormancy.boundaryIndex !== dormantExpected.boundaryIndex) {
    fail(`dormancy: wrong boundary: ${dd.dormancy.boundaryIndex}`);
  }
  if (dd.dormancy.fromId !== dormantExpected.fromId || dd.dormancy.toId !== dormantExpected.toId) {
    fail(`dormancy: wrong flanking packets: ${dd.dormancy.fromId}->${dd.dormancy.toId}`);
  }
  if (
    dd.dormancy.duration < dormantSample.dormancyLower ||
    dd.dormancy.duration > dormantSample.dormancyUpper
  ) {
    fail('dormancy: duration outside the requested interval');
  }
  const pauseEdges = dd.adjacency.filter((ev) => ev.dormancy !== undefined);
  if (pauseEdges.length !== 1) fail('dormancy: expected exactly one pause-carrying adjacency');
  if (pauseEdges[0].index !== dormantExpected.boundaryIndex) {
    fail('dormancy: pause-carrying adjacency at the wrong index');
  }
  for (const ev of dd.adjacency) {
    if (!ev.satisfied) fail(`dormancy: unsatisfied adjacency: ${JSON.stringify(ev)}`);
  }

  // 5. The same packets WITHOUT the dormancy fields are unexplainable (the
  //    silence must not be read as massive packet loss).
  const noDormancy = { ...dormantSample };
  delete noDormancy.dormancyLower;
  delete noDormancy.dormancyUpper;
  const stripped = await fetch(`${baseUrl}/api/v1/recover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(noDormancy),
  });
  if (stripped.status !== 422) {
    fail(`dormancy-free sample returned HTTP ${stripped.status}, expected 422`);
  }
  const strippedBody = await stripped.json();
  if (strippedBody.status !== 'error' || strippedBody.error.code !== 'NO_CONSISTENT_INTERPRETATION') {
    fail(`dormancy-free sample: unexpected body: ${JSON.stringify(strippedBody)}`);
  }

  // 6. Malformed dormancy usage must be rejected as INVALID_REQUEST.
  for (const badDormancy of [
    { dormancyLower: 10 },
    { dormancyUpper: 10 },
    { dormancyLower: 60, dormancyUpper: 40 },
    { dormancyLower: 0, dormancyUpper: 10 },
  ]) {
    const res = await fetch(`${baseUrl}/api/v1/recover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...sample, ...badDormancy }),
    });
    if (res.status !== 400) {
      fail(`invalid dormancy ${JSON.stringify(badDormancy)} returned HTTP ${res.status}, expected 400`);
    }
    const body = await res.json();
    if (body.status !== 'error' || body.error.code !== 'INVALID_REQUEST') {
      fail(`invalid dormancy ${JSON.stringify(badDormancy)}: unexpected body: ${JSON.stringify(body)}`);
    }
  }

  console.log('SMOKE PASSED');
  console.log(`  order     : ${data.order.join(' -> ')}`);
  console.log(`  counts    : ${counts.join(', ')}`);
  console.log(`  missing   : ${data.missingCountTotal} packets in ${segments.length} segment(s)`);
  console.log(`  adjacency : all ${data.adjacency.length} constraints satisfied`);
  console.log(
    `  dormancy  : duration ${dd.dormancy.duration} between ${dd.dormancy.fromId} and ${dd.dormancy.toId} ` +
      `(boundary ${dd.dormancy.boundaryIndex}); dormancy-free sample correctly rejected`,
  );
}

main().catch((err) => fail(err.stack ?? String(err)));
