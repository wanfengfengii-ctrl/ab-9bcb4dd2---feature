import { describe, expect, it } from 'vitest';
import { solve } from '../src/core/solver.js';
import { SolveError } from '../src/core/types.js';
import type { PacketInput } from '../src/core/types.js';
import { bruteSolveDormancy, makeRng, type DormRefSolution } from './helpers/brute.js';

/**
 * Fixed-cadence scenario that is only explainable with a pause:
 * counts 0..5, cadence exactly 10, a 100-unit sleep between p2 and p3.
 */
function sleepRequiredPackets(halfWidth = 1): PacketInput[] {
  const truth: Array<[string, number, number]> = [
    ['p0', 0, 0],
    ['p1', 1, 10],
    ['p2', 2, 20],
    ['p3', 3, 130],
    ['p4', 4, 140],
    ['p5', 5, 150],
  ];
  return truth
    .map(([id, remainder, t]) => ({
      id,
      remainder,
      timeLower: t - halfWidth,
      timeUpper: t + halfWidth,
    }))
    .reverse();
}

describe('solver: required dormancy', () => {
  it('refuses the sleep-required sample without the dormancy fields', () => {
    let caught: SolveError | null = null;
    try {
      solve(sleepRequiredPackets(), 10, 0, 10, 10, 10);
    } catch (e) {
      caught = e as SolveError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe('NO_CONSISTENT_INTERPRETATION');
  });

  it('recovers order, counts, timestamps and the unique pause when enabled', () => {
    const r = solve(sleepRequiredPackets(), 10, 0, 10, 10, 10, { lower: 50, upper: 150 });
    expect(r.order).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
    expect(r.assignments.map((a) => a.absoluteCount)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(r.assignments.map((a) => a.time)).toEqual([0, 10, 20, 130, 140, 150]);
    expect(r.missingCountTotal).toBe(0);
    expect(r.dormancy).toEqual({
      duration: 100,
      adjacencyIndex: 2,
      fromPosition: 2,
      toPosition: 3,
      fromId: 'p2',
      toId: 'p3',
      range: { lower: 50, upper: 150 },
    });
    expect(r.adjacency).toHaveLength(5);
    for (const ev of r.adjacency) {
      expect(ev.satisfied).toBe(true);
      expect(ev.dormancy).toBeDefined();
      if (ev.index === 2) {
        expect(ev.dormancy).toEqual({ duration: 100, carriesDormancy: true });
        expect(ev.timeGap).toBe(110);
        expect(ev.allowedTimeGap).toEqual({ min: 110, max: 110 });
      } else {
        expect(ev.dormancy).toEqual({ duration: 0, carriesDormancy: false });
        expect(ev.timeGap).toBe(10);
      }
    }
    const carrying = r.adjacency.filter((e) => e.dormancy?.carriesDormancy);
    expect(carrying).toHaveLength(1);
  });

  it('reports CROSSING when the blocking edge structurally needs a pause outside the range', () => {
    let caught: SolveError | null = null;
    try {
      solve(sleepRequiredPackets(), 10, 0, 10, 10, 10, { lower: 50, upper: 90 });
    } catch (e) {
      caught = e as SolveError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe('NO_CONSISTENT_INTERPRETATION');
    expect(caught!.evidence?.dormancyStatus).toBe('CROSSING');
    expect(caught!.evidence?.candidateId).toBe('p3');
    // The detail distinguishes the plain gap from the pause-shifted gap.
    expect(caught!.evidence?.detail?.dormancyTimeGap).toBeTruthy();
  });

  it('reports NOT_USED when even an unrestricted positive pause cannot cross', () => {
    let caught: SolveError | null = null;
    // A positive pause only widens time gaps forward; this packet sits
    // before its predecessor in time, so no pause placement repairs it.
    const packets: PacketInput[] = [
      { id: 'p0', remainder: 0, timeLower: 0, timeUpper: 0 },
      { id: 'p1', remainder: 1, timeLower: 10, timeUpper: 10 },
      { id: 'p2', remainder: 2, timeLower: 20, timeUpper: 20 },
      { id: 'p3', remainder: 3, timeLower: -50, timeUpper: -50 },
      { id: 'p4', remainder: 4, timeLower: 40, timeUpper: 40 },
      { id: 'p5', remainder: 5, timeLower: 50, timeUpper: 50 },
    ];
    try {
      solve(packets, 10, 0, 10, 10, 10, { lower: 1, upper: 5 });
    } catch (e) {
      caught = e as SolveError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe('NO_CONSISTENT_INTERPRETATION');
    expect(caught!.evidence?.dormancyStatus).toBe('NOT_USED');
  });
});

describe('solver: dormancy tie-breaks after the three original objectives', () => {
  it('prefers the shorter pause on complete ties', () => {
    // Elastic cadence 8..12: with exact timestamps the edge gap 110 admits
    // every pause s in [110-12, 110-8] = [98,102] with zero deviation, so
    // the shorter-duration tie-break must pick 98.
    const packets: PacketInput[] = [0, 10, 20, 130, 140, 150].map((t, i) => ({
      id: i,
      remainder: i,
      timeLower: t,
      timeUpper: t,
    }));
    const r = solve(packets, 10, 0, 10, 8, 12, { lower: 98, upper: 102 });
    expect(r.dormancy?.duration).toBe(98);
    expect(r.dormancy?.adjacencyIndex).toBe(2);
  });

  it('prefers the earlier carrying edge on fully tied chains', () => {
    // Cadence 10; a 20-unit pause is equally explained between p2/p3 and
    // p3/p4: p3's interval [30,50] is centered midway between the two
    // candidate timestamps, so both edges have identical deviation.
    const packets: PacketInput[] = [
      { id: 'p0', remainder: 0, timeLower: 0, timeUpper: 0 },
      { id: 'p1', remainder: 1, timeLower: 10, timeUpper: 10 },
      { id: 'p2', remainder: 2, timeLower: 20, timeUpper: 20 },
      { id: 'p3', remainder: 3, timeLower: 30, timeUpper: 50 },
      { id: 'p4', remainder: 4, timeLower: 60, timeUpper: 60 },
      { id: 'p5', remainder: 5, timeLower: 70, timeUpper: 70 },
    ];
    const r = solve(packets, 10, 0, 10, 10, 10, { lower: 20, upper: 20 });
    expect(r.dormancy?.duration).toBe(20);
    expect(r.dormancy?.adjacencyIndex).toBe(2);
    expect(r.dormancy?.fromId).toBe('p2');
    expect(r.dormancy?.toId).toBe('p3');
  });
});

describe('solver: dormancy failure evidence dispositions', () => {
  const expectCode = (fn: () => unknown): SolveError => {
    try {
      fn();
    } catch (e) {
      return e as SolveError;
    }
    throw new Error('expected NO_CONSISTENT_INTERPRETATION');
  };

  it('marks NOT_USED when the whole no-pause chain fits but no positive pause does', () => {
    // Exact timestamps, fixed cadence: a complete interpretation exists with
    // no pause; no positive pause can be absorbed.
    const packets: PacketInput[] = [0, 10, 20, 30, 40, 50].map((t, i) => ({
      id: i,
      remainder: i,
      timeLower: t,
      timeUpper: t,
    }));
    const err = expectCode(() => solve(packets, 10, 0, 10, 10, 10, { lower: 1, upper: 5 }));
    expect(err.code).toBe('NO_CONSISTENT_INTERPRETATION');
    expect(err.evidence?.dormancyStatus).toBe('NOT_USED');
  });

  it('marks USED (with the carrying edge) when a later edge fails after the pause', () => {
    // p0..p3 follow the 100-unit sleep; p4 jumps impossibly far afterward,
    // with no pause left to spend.
    const packets: PacketInput[] = [
      { id: 'p0', remainder: 0, timeLower: 0, timeUpper: 0 },
      { id: 'p1', remainder: 1, timeLower: 10, timeUpper: 10 },
      { id: 'p2', remainder: 2, timeLower: 20, timeUpper: 20 },
      { id: 'p3', remainder: 3, timeLower: 129, timeUpper: 131 },
      { id: 'p4', remainder: 4, timeLower: 300, timeUpper: 300 },
      { id: 'p5', remainder: 5, timeLower: 310, timeUpper: 310 },
    ];
    const err = expectCode(() => solve(packets, 10, 0, 10, 10, 10, { lower: 90, upper: 110 }));
    expect(err.code).toBe('NO_CONSISTENT_INTERPRETATION');
    expect(err.evidence?.dormancyStatus).toBe('USED');
    expect(err.evidence?.dormancyEdge).toBeTruthy();
  });
});

describe('solver: wide dormancy intervals via the symbolic breakpoint path', () => {
  it('matches exhaustive search when the feasible s interval is wider than 48', () => {
    // Fixed cadence 10, exact early times, ±30 windows after the sleep: the
    // feasible pause interval on edge p2->p3 is s ∈ [70,130] (width 60), so
    // bestLeafDeviation must take its symbolic breakpoint branch.
    const packets: PacketInput[] = [
      { id: 'p0', remainder: 0, timeLower: 0, timeUpper: 0 },
      { id: 'p1', remainder: 1, timeLower: 10, timeUpper: 10 },
      { id: 'p2', remainder: 2, timeLower: 20, timeUpper: 20 },
      { id: 'p3', remainder: 3, timeLower: 100, timeUpper: 160 },
      { id: 'p4', remainder: 4, timeLower: 110, timeUpper: 170 },
      { id: 'p5', remainder: 5, timeLower: 120, timeUpper: 180 },
    ];
    const dRange = { lower: 60, upper: 140 };
    const r = solve(packets, 10, 0, 10, 10, 10, dRange);
    const ref = bruteSolveDormancy(packets, 10, 0, 10, 10, 10, dRange);
    expect(ref).not.toBeNull();
    let deviation = 0;
    for (const a of r.assignments) {
      const p = packets.find((pp) => pp.id === a.id)!;
      deviation += Math.abs(2 * a.time - (p.timeLower + p.timeUpper));
    }
    expect(r.missingCountTotal).toBe(ref!.missing);
    expect(deviation).toBe(ref!.deviation);
    expect(r.order).toEqual(ref!.idSeq);
    expect(r.dormancy?.duration).toBe(ref!.dormDuration);
    expect(r.dormancy?.adjacencyIndex).toBe(ref!.dormEdge);
  });
});

describe('solver: dormancy differential fuzzing against exhaustive reference', () => {
  const batches: [number, number, 'fixed' | 'wide' | 'elastic'][] = [
    [11, 18, 'fixed'],
    [77, 18, 'fixed'],
    [303, 8, 'wide'],
    [512, 8, 'elastic'],
  ];

  for (const [seedStart, count, mode] of batches) {
    it(`agrees with brute force with dormancy on ${count} instances (seed ${seedStart}, ${mode})`, () => {
      const rnd = makeRng(seedStart);
      for (let iter = 0; iter < count; iter++) {
        const n = 6;
        const modulus = 4 + Math.floor(rnd() * 4); // 4..7
        let minInterval: number;
        let maxInterval: number;
        let halfWidth: number;
        if (mode === 'elastic') {
          minInterval = 2 + Math.floor(rnd() * 3);
          maxInterval = minInterval + 1 + Math.floor(rnd() * 2);
          halfWidth = rnd() < 0.7 ? 0 : 1;
        } else {
          minInterval = maxInterval = 2 + Math.floor(rnd() * 3);
          halfWidth = mode === 'wide' ? 0 : rnd() < 0.6 ? 0 : 1;
        }

        // Ground-truth increasing congruent counts, mostly gap 1.
        const counts: number[] = [];
        let c = Math.floor(rnd() * 2);
        for (let i = 0; i < n; i++) {
          counts.push(c);
          c += 1;
        }
        const countLower = 0;
        const countUpper = counts[n - 1] + 1 + Math.floor(rnd() * 2);

        const hasSleep = rnd() < 0.55;
        const sleepEdge = Math.floor(rnd() * (n - 1));
        const sleep = 1 + Math.floor(rnd() * 5);
        const timesTruth: number[] = [];
        let t = Math.floor(rnd() * 3);
        for (let i = 0; i < n; i++) {
          timesTruth.push(t);
          if (i < n - 1) {
            // Ground-truth step inside the cadence band when elastic.
            const step =
              minInterval === maxInterval
                ? minInterval
                : minInterval + Math.floor(rnd() * (maxInterval - minInterval + 1));
            t += step + (hasSleep && i === sleepEdge ? sleep : 0);
          }
        }

        const packets: PacketInput[] = counts.map((cc, i) => ({
          id: i,
          remainder: ((cc % modulus) + modulus) % modulus,
          timeLower: timesTruth[i] - halfWidth,
          timeUpper: timesTruth[i] + halfWidth,
        }));
        // Scramble download order.
        for (let i = packets.length - 1; i > 0; i--) {
          const q = Math.floor(rnd() * (i + 1));
          [packets[i], packets[q]] = [packets[q], packets[i]];
        }

        let dRange: { lower: number; upper: number };
        if (!hasSleep) {
          dRange = { lower: 1, upper: 2 + Math.floor(rnd() * 2) };
        } else {
          const pick = rnd();
          if (mode === 'wide') {
            // Force a wide integer range so the symbolic breakpoint path runs.
            dRange = { lower: 1, upper: 120 };
          } else if (pick < 0.45) {
            dRange = { lower: sleep, upper: sleep };
          } else if (pick < 0.85) {
            dRange = { lower: Math.max(1, sleep - 1), upper: sleep + 1 };
          } else {
            dRange = { lower: sleep + 6, upper: sleep + 8 };
          }
        }

        let got: { missing: number; deviation: number; ref: DormRefSolution } | 'ERR' | null = null;
        try {
          const r = solve(
            packets,
            modulus,
            countLower,
            countUpper,
            minInterval,
            maxInterval,
            dRange,
          );
          for (const a of r.assignments) {
            const p = packets.find((pp) => pp.id === a.id)!;
            expect(a.time).toBeGreaterThanOrEqual(p.timeLower);
            expect(a.time).toBeLessThanOrEqual(p.timeUpper);
          }
          const carrying = r.adjacency.filter((e) => e.dormancy?.carriesDormancy);
          expect(carrying).toHaveLength(1);
          expect(r.dormancy).toBeTruthy();
          expect(r.dormancy!.duration).toBeGreaterThanOrEqual(dRange.lower);
          expect(r.dormancy!.duration).toBeLessThanOrEqual(dRange.upper);
          let deviation = 0;
          for (const a of r.assignments) {
            const p = packets.find((pp) => pp.id === a.id)!;
            deviation += Math.abs(2 * a.time - (p.timeLower + p.timeUpper));
          }
          got = {
            missing: r.missingCountTotal,
            deviation,
            ref: {
              missing: r.missingCountTotal,
              deviation,
              idSeq: r.order,
              dormEdge: r.dormancy!.adjacencyIndex,
              dormDuration: r.dormancy!.duration,
            },
          };
        } catch (e) {
          if (!(e instanceof SolveError)) throw e;
          got = 'ERR';
        }

        const ref = bruteSolveDormancy(
          packets,
          modulus,
          countLower,
          countUpper,
          minInterval,
          maxInterval,
          dRange,
        );
        expect(got === 'ERR').toBe(ref === null);
        if (got !== null && got !== 'ERR' && ref) {
          expect(got.missing).toBe(ref.missing);
          expect(got.deviation).toBe(ref.deviation);
          expect(got.ref.idSeq).toEqual(ref.idSeq);
          expect(got.ref.dormDuration).toBe(ref.dormDuration);
          expect(got.ref.dormEdge).toBe(ref.dormEdge);
        }
      }
    });
  }
});
