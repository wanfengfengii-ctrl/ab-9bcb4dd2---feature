import { describe, expect, it } from 'vitest';
import { solve } from '../src/core/solver.js';
import { SolveError } from '../src/core/types.js';
import type { PacketInput } from '../src/core/types.js';
import { sampleRequest, dormantSampleRequest, dormantSampleExpected } from './fixtures/sample.js';
import { bruteSolveDormant, lexIds, makeRng } from './helpers/brute.js';

const dormantArgs = (
  req: typeof dormantSampleRequest,
): Parameters<typeof solve> => [
  req.packets,
  req.modulus,
  req.countLower,
  req.countUpper,
  req.minInterval,
  req.maxInterval,
  { lower: req.dormancyLower!, upper: req.dormancyUpper! },
];

describe('dormancy: low-battery pause recovery', () => {
  const result = solve(...dormantArgs(dormantSampleRequest));

  it('recovers the true order and counts despite the pause', () => {
    expect(result.order).toEqual(dormantSampleExpected.order);
    expect(result.assignments.map((a) => a.absoluteCount)).toEqual(dormantSampleExpected.counts);
    expect(result.assignments.map((a) => a.time)).toEqual(dormantSampleExpected.times);
    expect(result.missingCountTotal).toBe(dormantSampleExpected.missingTotal);
  });

  it('reports the pause duration and the flanking packets', () => {
    expect(result.dormancy).toBeDefined();
    expect(result.dormancy!.duration).toBe(dormantSampleExpected.duration);
    expect(result.dormancy!.boundaryIndex).toBe(dormantSampleExpected.boundaryIndex);
    expect(result.dormancy!.fromId).toBe(dormantSampleExpected.fromId);
    expect(result.dormancy!.toId).toBe(dormantSampleExpected.toId);
    expect(result.dormancy!.fromCount).toBe(21);
    expect(result.dormancy!.toCount).toBe(22);
    expect(result.dormancy!.duration).toBeGreaterThanOrEqual(dormantSampleRequest.dormancyLower!);
    expect(result.dormancy!.duration).toBeLessThanOrEqual(dormantSampleRequest.dormancyUpper!);
  });

  it('marks the pause-carrying adjacency and shifts its allowed time gap', () => {
    expect(result.adjacency).toHaveLength(6);
    const withDormancy = result.adjacency.filter((ev) => ev.dormancy !== undefined);
    expect(withDormancy).toHaveLength(1);
    const ev = withDormancy[0];
    expect(ev.index).toBe(dormantSampleExpected.boundaryIndex);
    expect(ev.fromId).toBe('D');
    expect(ev.toId).toBe('E');
    // Base range for the unit counter gap is [9, 11]; the pause of 50 shifts
    // the allowed difference to [59, 61], which the realized 61 satisfies.
    expect(ev.dormancy!.duration).toBe(50);
    expect(ev.dormancy!.baseAllowedTimeGap).toEqual({ min: 9, max: 11 });
    expect(ev.allowedTimeGap).toEqual({ min: 59, max: 61 });
    expect(ev.timeGap).toBe(61);
    for (const e of result.adjacency) expect(e.satisfied).toBe(true);
  });

  it('is infeasible without the dormancy model (the silence is not packet loss)', () => {
    let caught: SolveError | null = null;
    try {
      solve(
        dormantSampleRequest.packets,
        dormantSampleRequest.modulus,
        dormantSampleRequest.countLower,
        dormantSampleRequest.countUpper,
        dormantSampleRequest.minInterval,
        dormantSampleRequest.maxInterval,
      );
    } catch (e) {
      caught = e as SolveError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe('NO_CONSISTENT_INTERPRETATION');
    // Legacy request: the evidence carries no dormancy status.
    expect(caught!.evidence && 'dormancyStatus' in caught!.evidence).toBe(false);
  });

  it('places a mandatory pause even when a pause-free interpretation exists', () => {
    // The canonical sample is feasible without any pause; enabling the
    // dormancy model must still attribute exactly one pause.
    const r = solve(
      sampleRequest.packets,
      sampleRequest.modulus,
      sampleRequest.countLower,
      sampleRequest.countUpper,
      sampleRequest.minInterval,
      sampleRequest.maxInterval,
      { lower: 1, upper: 5 },
    );
    expect(r.dormancy).toBeDefined();
    expect(r.dormancy!.duration).toBeGreaterThanOrEqual(1);
    expect(r.dormancy!.duration).toBeLessThanOrEqual(5);
    const carrying = r.adjacency.filter((ev) => ev.dormancy !== undefined);
    expect(carrying).toHaveLength(1);
    for (const ev of r.adjacency) expect(ev.satisfied).toBe(true);
  });
});

describe('dormancy: tie-breaks', () => {
  it('chooses the shortest consistent pause (sample picks 50 out of [50,52])', () => {
    // Midpoint-exact times force the D->E difference to 61; any pause in
    // [50, 52] explains it, and the shortest wins.
    const r = solve(...dormantArgs(dormantSampleRequest));
    expect(r.dormancy!.duration).toBe(50);
  });

  it('breaks full ties toward the earlier boundary', () => {
    // Identical optima (missing/deviation/id sequence/duration) are achievable
    // with the pause on boundaries 0..3; the earliest must win.
    const packets: PacketInput[] = [
      { id: 1000, remainder: 0, timeLower: -1, timeUpper: 1 },
      { id: 1001, remainder: 2, timeLower: 5, timeUpper: 7 },
      { id: 1002, remainder: 2, timeLower: 14, timeUpper: 16 },
      { id: 1003, remainder: 2, timeLower: 23, timeUpper: 25 },
      { id: 1004, remainder: 2, timeLower: 31, timeUpper: 33 },
      { id: 1005, remainder: 0, timeLower: 33, timeUpper: 35 },
    ];
    const r = solve(packets, 3, 0, 17, 2, 3, { lower: 2, upper: 2 });
    expect(r.dormancy!.duration).toBe(2);
    expect(r.dormancy!.boundaryIndex).toBe(0);
  });

  it('breaks full ties toward the earlier boundary (interior case)', () => {
    const packets: PacketInput[] = [
      { id: 1000, remainder: 0, timeLower: -1, timeUpper: 1 },
      { id: 1001, remainder: 1, timeLower: 1, timeUpper: 3 },
      { id: 1002, remainder: 0, timeLower: 3, timeUpper: 5 },
      { id: 1003, remainder: 1, timeLower: 9, timeUpper: 11 },
      { id: 1004, remainder: 0, timeLower: 12, timeUpper: 14 },
      { id: 1005, remainder: 1, timeLower: 18, timeUpper: 20 },
    ];
    const r = solve(packets, 2, 0, 13, 2, 2, { lower: 1, upper: 3 });
    expect(r.dormancy!.duration).toBe(3);
    expect(r.dormancy!.boundaryIndex).toBe(2);
  });
});

describe('dormancy: infeasibility evidence carries the pause status', () => {
  const infeasible = (
    packets: PacketInput[],
    modulus: number,
    countLower: number,
    countUpper: number,
    minInterval: number,
    maxInterval: number,
    dormLower: number,
    dormUpper: number,
  ): SolveError => {
    try {
      solve(packets, modulus, countLower, countUpper, minInterval, maxInterval, {
        lower: dormLower,
        upper: dormUpper,
      });
    } catch (e) {
      return e as SolveError;
    }
    throw new Error('expected NO_CONSISTENT_INTERPRETATION');
  };

  it('reports dormancyStatus "unused" when the pause was never placed', () => {
    // The pause interval is far too short to explain the D->E silence, and no
    // prefix placed the pause before the first non-extendable boundary.
    const err = infeasible(
      dormantSampleRequest.packets,
      dormantSampleRequest.modulus,
      dormantSampleRequest.countLower,
      dormantSampleRequest.countUpper,
      dormantSampleRequest.minInterval,
      dormantSampleRequest.maxInterval,
      5,
      10,
    );
    expect(err.code).toBe('NO_CONSISTENT_INTERPRETATION');
    expect(err.evidence?.dormancyStatus).toBe('unused');
  });

  it('reports dormancyStatus "used" when the pause sits on an earlier boundary', () => {
    // Count window too small to finish the chain: the deepest dead end is
    // reached after the pause was already placed upstream.
    const err = infeasible(
      dormantSampleRequest.packets,
      dormantSampleRequest.modulus,
      0,
      25,
      dormantSampleRequest.minInterval,
      dormantSampleRequest.maxInterval,
      dormantSampleRequest.dormancyLower!,
      dormantSampleRequest.dormancyUpper!,
    );
    expect(err.code).toBe('NO_CONSISTENT_INTERPRETATION');
    expect(err.evidence?.dormancyStatus).toBe('used');
  });

  it('can report dormancyStatus "crossing" for a failing pause-carrying extension', () => {
    // Brute-force search for an instance whose canonical first blocker is the
    // pause-carrying extension itself.
    const rnd = makeRng(55);
    let found: SolveError | null = null;
    for (let iter = 0; iter < 400 && found === null; iter++) {
      const n = 6 + Math.floor(rnd() * 3);
      const modulus = 2 + Math.floor(rnd() * 6);
      const ids = new Set<number>();
      const packets: PacketInput[] = [];
      for (let i = 0; i < n; i++) {
        let id = Math.floor(rnd() * 1000);
        while (ids.has(id)) id = Math.floor(rnd() * 1000);
        ids.add(id);
        const lo = Math.floor(rnd() * 30);
        packets.push({ id, remainder: Math.floor(rnd() * modulus), timeLower: lo, timeUpper: lo + Math.floor(rnd() * 4) });
      }
      const minInterval = 1 + Math.floor(rnd() * 3);
      const maxInterval = minInterval + Math.floor(rnd() * 3);
      const countLower = Math.floor(rnd() * 8);
      const countUpper = countLower + (n - 1) + Math.floor(rnd() * 4);
      const dormLower = 1 + Math.floor(rnd() * 4);
      const dormUpper = dormLower + Math.floor(rnd() * 5);
      try {
        solve(packets, modulus, countLower, countUpper, minInterval, maxInterval, {
          lower: dormLower,
          upper: dormUpper,
        });
      } catch (e) {
        const err = e as SolveError;
        if (err.evidence?.dormancyStatus === 'crossing') found = err;
      }
    }
    expect(found).not.toBeNull();
    expect(found!.code).toBe('NO_CONSISTENT_INTERPRETATION');
    expect(found!.evidence?.dormancyStatus).toBe('crossing');
  });
});

describe('dormancy: differential fuzzing against exhaustive reference', () => {
  const batches: [number, number][] = [
    [101, 100],
    [202, 100],
    [303, 100],
  ];

  for (const [seedStart, count] of batches) {
    it(`agrees with brute force on ${count} feasible-by-construction instances (seed ${seedStart})`, () => {
      const rnd = makeRng(seedStart);
      for (let iter = 0; iter < count; iter++) {
        const n = 6 + Math.floor(rnd() * 3);
        const modulus = 2 + Math.floor(rnd() * 7);
        const minInterval = 1 + Math.floor(rnd() * 4);
        const maxInterval = minInterval + Math.floor(rnd() * 4);
        const countLower = Math.floor(rnd() * 6);
        const dormLower = 1 + Math.floor(rnd() * 8);
        const dormUpper = dormLower + Math.floor(rnd() * 8);
        const boundary = Math.floor(rnd() * (n - 1));
        const dormTrue = dormLower + Math.floor(rnd() * (dormUpper - dormLower + 1));
        const trueCounts: number[] = [];
        let c = countLower + Math.floor(rnd() * 3);
        for (let k = 0; k < n; k++) {
          trueCounts.push(c);
          c += 1 + Math.floor(rnd() * 4);
        }
        const countUpper = c - 1 + Math.floor(rnd() * 3);
        const trueTimes: number[] = [];
        let t = Math.floor(rnd() * 5);
        for (let k = 0; k < n; k++) {
          trueTimes.push(t);
          if (k < n - 1) {
            const d = trueCounts[k + 1] - trueCounts[k];
            t +=
              d * (minInterval + Math.floor(rnd() * (maxInterval - minInterval + 1))) +
              (k === boundary ? dormTrue : 0);
          }
        }
        const idx = [...Array(n).keys()];
        for (let i = idx.length - 1; i > 0; i--) {
          const j = Math.floor(rnd() * (i + 1));
          [idx[i], idx[j]] = [idx[j], idx[i]];
        }
        const packets: PacketInput[] = idx.map((k) => ({
          id: 1000 + k,
          remainder: ((trueCounts[k] % modulus) + modulus) % modulus,
          timeLower: trueTimes[k] - Math.floor(rnd() * 3),
          timeUpper: trueTimes[k] + Math.floor(rnd() * 3),
        }));
        // Inject identical twins in some cases.
        if (iter % 3 === 0) {
          packets[1].remainder = packets[0].remainder;
          packets[1].timeLower = packets[0].timeLower;
          packets[1].timeUpper = packets[0].timeUpper;
        }

        let got: {
          missing: number;
          deviation: number;
          idSeq: (string | number)[];
          duration: number;
          boundary: number;
        } | null = null;
        let gotError = false;
        try {
          const r = solve(packets, modulus, countLower, countUpper, minInterval, maxInterval, {
            lower: dormLower,
            upper: dormUpper,
          });
          expect(r.dormancy).toBeDefined();
          let deviation = 0;
          for (const a of r.assignments) {
            const p = packets.find((pp) => pp.id === a.id)!;
            expect(a.time).toBeGreaterThanOrEqual(p.timeLower);
            expect(a.time).toBeLessThanOrEqual(p.timeUpper);
            deviation += Math.abs(2 * a.time - (p.timeLower + p.timeUpper));
          }
          for (const ev of r.adjacency) expect(ev.satisfied).toBe(true);
          // Exactly one pause-carrying adjacency, at the reported boundary.
          const carrying = r.adjacency.filter((ev) => ev.dormancy !== undefined);
          expect(carrying).toHaveLength(1);
          expect(carrying[0].index).toBe(r.dormancy!.boundaryIndex);
          expect(carrying[0].dormancy!.duration).toBe(r.dormancy!.duration);
          expect(r.dormancy!.duration).toBeGreaterThanOrEqual(dormLower);
          expect(r.dormancy!.duration).toBeLessThanOrEqual(dormUpper);
          got = {
            missing: r.missingCountTotal,
            deviation,
            idSeq: r.order,
            duration: r.dormancy!.duration,
            boundary: r.dormancy!.boundaryIndex,
          };
        } catch (e) {
          if (!(e instanceof SolveError)) throw e;
          gotError = true;
        }

        const ref = bruteSolveDormant(
          packets,
          modulus,
          countLower,
          countUpper,
          minInterval,
          maxInterval,
          dormLower,
          dormUpper,
        );
        expect(gotError).toBe(ref === null);
        if (got && ref) {
          expect(got.missing).toBe(ref.missing);
          expect(got.deviation).toBe(ref.deviation);
          expect(lexIds(got.idSeq, ref.idSeq)).toBe(0);
          expect(got.duration).toBe(ref.duration);
          expect(got.boundary).toBe(ref.boundary);
        }
      }
    });
  }
});
