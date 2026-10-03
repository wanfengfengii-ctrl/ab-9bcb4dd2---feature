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
 * Dormancy-required sample: fixed cadence 10 (modulus 10), counts 0..5, true
 * times 0,10,20,130,140,150 with a 100-unit sleep between p2 and p3. With
 * countUpper=10 the jump cannot be explained by missing counters; only a
 * pause on adjacency 2 makes the batch consistent.
 */
const dormancySample = {
  modulus: 10,
  countLower: 0,
  countUpper: 10,
  minInterval: 10,
  maxInterval: 10,
  dormancyLower: 50,
  dormancyUpper: 150,
  packets: [
    { id: 'p5', remainder: 5, timeLower: 149, timeUpper: 151 },
    { id: 'p0', remainder: 0, timeLower: -1, timeUpper: 1 },
    { id: 'p3', remainder: 3, timeLower: 129, timeUpper: 131 },
    { id: 'p1', remainder: 1, timeLower: 9, timeUpper: 11 },
    { id: 'p4', remainder: 4, timeLower: 139, timeUpper: 141 },
    { id: 'p2', remainder: 2, timeLower: 19, timeUpper: 21 },
  ],
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

  // 4. Dormancy-required sample: the same packets without dormancy bounds
  //    must be rejected (the silence would otherwise read as missing packets).
  const { dormancyLower, dormancyUpper, ...withoutDormancy } = dormancySample;
  void dormancyLower;
  void dormancyUpper;
  const noDorm = await fetch(`${baseUrl}/api/v1/recover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(withoutDormancy),
  });
  if (noDorm.status !== 422) {
    fail(`dormancy-required sample without bounds returned HTTP ${noDorm.status}`);
  }
  const noDormBody = await noDorm.json();
  if (noDormBody.error.code !== 'NO_CONSISTENT_INTERPRETATION') {
    fail(`expected NO_CONSISTENT_INTERPRETATION, got ${JSON.stringify(noDormBody)}`);
  }

  // 5. Dormancy-enabled recovery: unique pause on p2 -> p3 of length 100.
  const dormRes = await fetch(`${baseUrl}/api/v1/recover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dormancySample),
  });
  if (dormRes.status !== 200) {
    fail(`dormancy recovery returned ${dormRes.status}: ${await dormRes.text()}`);
  }
  const dormBody = await dormRes.json();
  if (dormBody.status !== 'ok') fail(`dormancy response not ok: ${JSON.stringify(dormBody)}`);
  const dd = dormBody.data;
  if (JSON.stringify(dd.order) !== JSON.stringify(['p0', 'p1', 'p2', 'p3', 'p4', 'p5'])) {
    fail(`dormancy wrong order: ${JSON.stringify(dd.order)}`);
  }
  if (JSON.stringify(dd.assignments.map((a) => a.absoluteCount)) !== JSON.stringify([0, 1, 2, 3, 4, 5])) {
    fail(`dormancy wrong counts: ${JSON.stringify(dd.assignments.map((a) => a.absoluteCount))}`);
  }
  if (!dd.dormancy || dd.dormancy.duration !== 100 || dd.dormancy.adjacencyIndex !== 2) {
    fail(`dormancy info wrong: ${JSON.stringify(dd.dormancy)}`);
  }
  if (dd.dormancy.fromId !== 'p2' || dd.dormancy.toId !== 'p3') {
    fail(`dormancy endpoints wrong: ${JSON.stringify(dd.dormancy)}`);
  }
  const carriers = dd.adjacency.filter((e) => e.dormancy?.carriesDormancy);
  if (carriers.length !== 1) fail('expected exactly one dormancy-carrying adjacency');
  for (const ev of dd.adjacency) {
    if (!ev.satisfied) fail(`unsatisfied dormancy adjacency: ${JSON.stringify(ev)}`);
    const pause = ev.dormancy?.carriesDormancy ? 100 : 0;
    if (ev.timeGap !== ev.countGap * 10 + pause) {
      fail(`adjacency ${ev.index} time gap ${ev.timeGap} does not match beats + pause ${pause}`);
    }
  }

  // 6. Half-provided dormancy bounds are an invalid request.
  const half = await fetch(`${baseUrl}/api/v1/recover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...dormancySample, dormancyUpper: undefined }),
  });
  if (half.status !== 400) fail(`half dormancy bounds returned HTTP ${half.status}`);
  const halfBody = await half.json();
  if (halfBody.error.code !== 'INVALID_REQUEST') fail('half dormancy bounds not INVALID_REQUEST');

  console.log('SMOKE PASSED');
  console.log(`  order     : ${data.order.join(' -> ')}`);
  console.log(`  counts    : ${counts.join(', ')}`);
  console.log(`  missing   : ${data.missingCountTotal} packets in ${segments.length} segment(s)`);
  console.log(`  adjacency : all ${data.adjacency.length} constraints satisfied`);
  console.log(
    `  dormancy  : ${dd.dormancy.duration} units between ${dd.dormancy.fromId} -> ${dd.dormancy.toId}`,
  );
}

main().catch((err) => fail(err.stack ?? String(err)));
