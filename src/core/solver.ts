import type {
  AdjacencyEvidence,
  AssignedPacket,
  MissingSegment,
  PacketInput,
  ConstraintFailureEvidence,
  DormancyStatus,
  SolveResult,
} from './types.js';
import { SolveError } from './types.js';

interface Packet {
  index: number;
  id: string | number;
  remainder: number;
  lo: number;
  hi: number;
  /** Twice the interval midpoint (lo + hi); deviation uses |2t - mid2|. */
  mid2: number;
  /** Smallest absolute count >= countLower congruent to remainder. */
  baseCount: number;
  /** Largest absolute count <= countUpper congruent to remainder. */
  topCount: number;
  /** Rank among packets with identical (remainder, lo, hi), by id. */
  symRank: number;
  /** Identifier of the identical-packet symmetry group. */
  symGroup: number;
}

/** Intrinsic feasibility of an adjacency i -> j: congruent d in [dLo, dHi]. */
interface PairFeas {
  /** Required residue d ≡ delta (mod modulus); 0 means a multiple. */
  delta: number;
  /** Smallest positive counter gap with the required residue. */
  d0: number;
  /** Time-feasible gap range for the raw intervals, without a pause. */
  timeLo: number;
  timeHi: number;
  /** Time-feasible gap range when the single pause straddles THIS edge. */
  timeLoD: number;
  timeHiD: number;
  /** Count-window feasible gap range (includes d0 and W). */
  countLo: number;
  countHi: number;
  /** Overall plain (no-pause) intersection used by the non-dormancy search. */
  dLo: number;
  dHi: number;
}

/** Affine expression v + b*s (b ∈ {-1, 0, 1}); s is the pause duration. */
interface Aff {
  v: number;
  b: number;
}

/** Parameterized tight window: t ∈ [max(P+s, Q), min(R+s, T)]. */
interface Env {
  P: number;
  Q: number;
  R: number;
  T: number;
}

/** Search frontier: fixed time window, or a window parameterized by s. */
type Frontier =
  | { kind: 'plain'; tLo: number; tHi: number }
  | { kind: 'param'; envLo: Env; envHi: Env; sLo: number; sHi: number };

interface DeadState {
  depth: number;
  placed: number[];
  last: number;
  S: number;
  c0lo: number;
  c0hi: number;
  frontier: Frontier;
  /** Adjacency index carrying the pause, when already placed. */
  dormEdge: number;
}

function modNonNeg(a: number, m: number): number {
  return ((a % m) + m) % m;
}

/** Smallest value >= bound congruent to residue mod m. */
function ceilResidue(bound: number, residue: number, m: number): number {
  return bound + modNonNeg(residue - bound, m);
}

/** Largest value <= bound congruent to residue mod m. */
function floorResidue(bound: number, residue: number, m: number): number {
  return bound - modNonNeg(bound - residue, m);
}

/**
 * Canonical id comparison for the tertiary tie-break:
 * numbers by numeric value, then strings by UTF-16 code unit order.
 */
function compareId(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Minimum |2t - mid2| for an integer t inside [lo, hi]. */
function minDeviation2(lo: number, hi: number, mid2: number): number {
  const low = Math.floor(mid2 / 2);
  const high = mid2 % 2 === 0 ? low : low + 1;
  const t = high < lo ? lo : low > hi ? hi : Math.max(low, lo);
  return Math.abs(2 * t - mid2);
}

/**
 * Tighten timestamp windows for a fixed complete order and gap sequence.
 * Forward pass intersects [t_prev + L, t_prev + U]; backward pass intersects
 * [t_next - U, t_next - L]. Nonempty forward windows already imply global
 * feasibility of the difference-constraint chain; the backward pass only
 * shrinks domains for the deviation optimizer. Null = defensively infeasible.
 *
 * `shift[e]` adds an edge-specific constant (the pause duration) to both
 * bounds of edge e; omitted shifts are zero.
 */
function tightenWindows(
  packets: Packet[],
  order: number[],
  gaps: number[],
  minInterval: number,
  maxInterval: number,
  shift?: number[],
): { lo: number; hi: number }[] | null {
  const n = order.length;
  const edgeLo = (k: number): number => gaps[k] * minInterval + (shift?.[k] ?? 0);
  const edgeHi = (k: number): number => gaps[k] * maxInterval + (shift?.[k] ?? 0);
  const win = new Array<{ lo: number; hi: number }>(n);
  win[0] = { lo: packets[order[0]].lo, hi: packets[order[0]].hi };
  for (let k = 1; k < n; k++) {
    const p = packets[order[k]];
    const lo = Math.max(p.lo, win[k - 1].lo + edgeLo(k - 1));
    const hi = Math.min(p.hi, win[k - 1].hi + edgeHi(k - 1));
    if (lo > hi) return null;
    win[k] = { lo, hi };
  }
  for (let k = n - 2; k >= 0; k--) {
    const lo = Math.max(win[k].lo, win[k + 1].lo - edgeHi(k));
    const hi = Math.min(win[k].hi, win[k + 1].hi - edgeLo(k));
    if (lo > hi) return null;
    win[k] = { lo, hi };
  }
  return win;
}

/**
 * Minimize Σ |2 t_k - mid2_k| over integer timestamps subject to
 * t_k ∈ window_k and L_e ≤ t_{e+1} - t_e ≤ U_e, for a FIXED order.
 *
 * Exported for direct differential testing against a full-domain DP.
 *
 * Difference-constraint L1 program on a path. At an integral optimum every
 * variable is pinned — directly or through a chain of tight lower/upper edge
 * constraints — to a pivot: an interval bound or one of the two integers
 * adjacent to its midpoint. Propagating every pivot along every lower/upper
 * pin chain gives O(n · 2^n) candidate values per position (n ≤ 14). A
 * backward shortest-path DP with monotone sliding-window minima computes the
 * optimum; the forward greedy reconstruction returns the lexicographically
 * smallest optimal timestamp vector.
 */
export function optimalTimes(
  packets: Packet[],
  order: number[],
  windows: { lo: number; hi: number }[],
  gaps: number[],
  minInterval: number,
  maxInterval: number,
  /** Optional per-edge additive offsets (e.g. the single dormancy duration). */
  shift?: number[],
): { times: number[]; deviation2: number } {
  const n = order.length;
  const L = gaps.map((d, k) => d * minInterval + (shift?.[k] ?? 0));
  const U = gaps.map((d, k) => d * maxInterval + (shift?.[k] ?? 0));

  const candSets: Set<number>[] = windows.map(() => new Set<number>());
  const add = (k: number, v: number): void => {
    if (Number.isSafeInteger(v) && v >= windows[k].lo && v <= windows[k].hi) {
      candSets[k].add(v);
    }
  };

  const pivotsOf = (k: number): number[] => {
    const p = packets[order[k]];
    const f = Math.floor(p.mid2 / 2);
    const c = p.mid2 % 2 === 0 ? f : f + 1;
    return [p.lo, p.hi, f, c];
  };

  // Forward tight-edge chains.
  for (let j = 0; j < n; j++) {
    for (const s of pivotsOf(j)) add(j, s);
    if (j === n - 1) continue;
    const visit = (pos: number, v: number): void => {
      add(pos, v);
      if (pos < n - 1) {
        visit(pos + 1, v + L[pos]);
        visit(pos + 1, v + U[pos]);
      }
    };
    for (const s of pivotsOf(j)) {
      visit(j + 1, s + L[j]);
      visit(j + 1, s + U[j]);
    }
  }
  // Backward tight-edge chains.
  for (let j = 1; j < n; j++) {
    const visit = (pos: number, v: number): void => {
      add(pos, v);
      if (pos > 0) {
        visit(pos - 1, v - L[pos - 1]);
        visit(pos - 1, v - U[pos - 1]);
      }
    };
    for (const s of pivotsOf(j)) {
      visit(j - 1, s - L[j - 1]);
      visit(j - 1, s - U[j - 1]);
    }
  }

  const candidates = candSets.map((set) => [...set].sort((a, b) => a - b));
  const dev = (k: number, t: number): number => Math.abs(2 * t - packets[order[k]].mid2);

  // suffix[k][c] = minimal cost on positions k..n-1 with t_k = cand[k][c].
  const suffix: number[][] = new Array(n);
  suffix[n - 1] = candidates[n - 1].map((t) => dev(n - 1, t));
  for (let k = n - 2; k >= 0; k--) {
    const prev = suffix[k + 1];
    const nextCands = candidates[k + 1];
    const cur: number[] = new Array(candidates[k].length);
    // Feasible t_{k+1} for t is [t + L_e, t + U_e]; monotone deque minimum.
    const deque: number[] = [];
    let head = 0;
    let pushed = -1;
    for (let c = 0; c < candidates[k].length; c++) {
      const t = candidates[k][c];
      const low = t + L[k];
      const high = t + U[k];
      while (head < deque.length && nextCands[deque[head]] < low) head++;
      while (pushed + 1 < nextCands.length && nextCands[pushed + 1] <= high) {
        pushed++;
        while (deque.length > head && prev[deque[deque.length - 1]] >= prev[pushed]) deque.pop();
        deque.push(pushed);
      }
      const best = head < deque.length ? prev[deque[head]] : Infinity;
      cur[c] = best + dev(k, t);
    }
    suffix[k] = cur;
  }

  const globalBest = Math.min(...suffix[0]);
  // Lexicographically smallest optimal vector: smallest t keeping the
  // remaining optimum attainable at every position.
  const times = new Array<number>(n);
  let target = globalBest;
  let prevTime = Number.NaN;
  for (let k = 0; k < n; k++) {
    let chosen = -1;
    for (let c = 0; c < candidates[k].length; c++) {
      const t = candidates[k][c];
      if (k > 0 && (t - prevTime < L[k - 1] || t - prevTime > U[k - 1])) continue;
      if (suffix[k][c] !== target) continue;
      chosen = c;
      break;
    }
    times[k] = candidates[k][chosen];
    target -= dev(k, times[k]);
    prevTime = times[k];
  }
  return { times, deviation2: globalBest };
}

type MoveBranch =
  | { kind: 'plain'; tLo: number; tHi: number }
  | { kind: 'dorm'; envLo: Env; envHi: Env; sLo: number; sHi: number }
  | { kind: 'post'; envLo: Env; envHi: Env; sLo: number; sHi: number };

interface Move {
  j: number;
  d: number;
  c0lo: number;
  c0hi: number;
  branch: MoveBranch;
}

/**
 * Jointly recover transmission order, wrap-crossing absolute counters and
 * transmit timestamps, optionally placing exactly one low-power dormancy.
 *
 * Without dormancy the optimization is lexicographic:
 *   1. missing packet count between first/last observed packet
 *   2. total deviation of chosen times from interval midpoints
 *   3. the recovered packet-id sequence (lexicographic)
 *
 * With an enabled pause the solver additionally chooses the unique adjacent
 * pair carrying it and an integer duration inside the requested closed range;
 * on that edge the observed time difference spans d*L+s .. d*U+s. The same
 * three objectives keep priority; only completely tied solutions then prefer
 * the shorter pause and the earlier (smaller-index) carrying edge.
 *
 * Implemented as exhaustive branch-and-bound phases over the same state
 * space: A minimizes total counter gap; B minimizes midpoint deviation on
 * primary-optimal chains (also choosing s); C greedily fixes the
 * lexicographically smallest id sequence with a memoized feasibility oracle;
 * a final pass selects the pause duration and carrying edge.
 *
 * Throws SolveError(NO_CONSISTENT_INTERPRETATION) with first-failure evidence.
 */
export function solve(
  inputs: PacketInput[],
  modulus: number,
  countLower: number,
  countUpper: number,
  minInterval: number,
  maxInterval: number,
  dormancy?: { lower: number; upper: number },
): SolveResult {
  const n = inputs.length;
  const W = countUpper - countLower;
  const Dlo = dormancy?.lower ?? 0;
  const Dhi = dormancy?.upper ?? 0;
  const dormEnabled = dormancy !== undefined;

  // Group identical (remainder, lo, hi) packets for symmetry breaking.
  const groups = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const p = inputs[i];
    const key = `${p.remainder}|${p.timeLower}|${p.timeUpper}`;
    const g = groups.get(key);
    if (g) g.push(i);
    else groups.set(key, [i]);
  }
  const symRank = new Array<number>(n);
  const symGroup = new Array<number>(n);
  let groupId = 0;
  for (const members of groups.values()) {
    members.sort((a, b) => compareId(inputs[a].id, inputs[b].id));
    members.forEach((ix, rank) => {
      symRank[ix] = rank;
      symGroup[ix] = groupId;
    });
    groupId++;
  }

  const packets: Packet[] = inputs.map((p, index) => ({
    index,
    id: p.id,
    remainder: p.remainder,
    lo: p.timeLower,
    hi: p.timeUpper,
    mid2: p.timeLower + p.timeUpper,
    baseCount: ceilResidue(countLower, p.remainder, modulus),
    topCount: floorResidue(countUpper, p.remainder, modulus),
    symRank: symRank[index],
    symGroup: symGroup[index],
  }));

  // Intrinsic adjacency feasibility = congruent-gap RANGES per ordered pair.
  // Time (no pause): L_d ≤ t_j - t_i ≤ U_d with t_i∈I_i, t_j∈I_j:
  //   d ≥ ceil((lo_j - hi_i)/U), d ≤ floor((hi_j - lo_i)/L).
  // With the pause straddling this edge the range is relaxed by s ∈ [Dlo,Dhi]:
  //   d ≥ ceil((lo_j - hi_i - Dhi)/U), d ≤ floor((hi_j - lo_i - Dlo)/L).
  // Counts: c_i, c_j = c_i + d both inside the search window:
  //   base_j - top_i ≤ d ≤ top_j - base_i.
  const pair: PairFeas[][] = packets.map((pi) =>
    packets.map((pj): PairFeas => {
      const same = pi.index === pj.index;
      const delta = modNonNeg(pj.remainder - pi.remainder, modulus);
      const d0 = same ? Infinity : delta === 0 ? modulus : delta;
      const timeLo = same ? Infinity : Math.ceil((pj.lo - pi.hi) / maxInterval);
      const timeHi = same ? -Infinity : Math.floor((pj.hi - pi.lo) / minInterval);
      const timeLoD = same
        ? Infinity
        : Math.ceil((pj.lo - pi.hi - Dhi) / maxInterval);
      const timeHiD = same
        ? -Infinity
        : Math.floor((pj.hi - pi.lo - Dlo) / minInterval);
      const countLo = same ? Infinity : Math.max(d0, pj.baseCount - pi.topCount);
      const countHi = same ? -Infinity : Math.min(W, pj.topCount - pi.baseCount);
      return {
        delta,
        d0,
        timeLo,
        timeHi,
        timeLoD: dormEnabled ? timeLoD : timeLo,
        timeHiD: dormEnabled ? timeHiD : timeHi,
        countLo,
        countHi,
        dLo: Math.max(d0, timeLo, countLo),
        dHi: Math.min(timeHi, countHi),
      };
    }),
  );

  const firstCongruentGap = (pf: PairFeas, useDorm: boolean): number => {
    const lo = Math.max(
      pf.d0,
      pf.countLo,
      useDorm ? pf.timeLoD : pf.timeLo,
    );
    const hi = Math.min(pf.countHi, useDorm ? pf.timeHiD : pf.timeHi);
    if (lo > hi) return Infinity;
    const d = ceilResidue(lo, pf.delta, modulus);
    return d <= hi ? d : Infinity;
  };

  // Minimum admissible gap per ordered pair over BOTH edge modes: at most
  // one edge in a completion carries the pause, but the Held-Karp bound
  // cannot know which, so it must lower-bound by the smaller of the plain
  // and the pause-carrying gap (a valid, albeit weaker, LB either way).
  const minGap: number[][] = packets.map((pi) =>
    packets.map((pj) => {
      if (pi.index === pj.index) return Infinity;
      const pf = pair[pi.index][pj.index];
      const plain = firstCongruentGap(pf, false);
      if (!dormEnabled) return plain;
      return Math.min(plain, firstCongruentGap(pf, true));
    }),
  );

  // cont[mask][j] = minimum gap sum of a path starting at j visiting all
  // nodes of `mask` (j ∉ mask). Exact admissible completion bound, O(2^n n²).
  const full = (1 << n) - 1;
  const cont: number[][] = Array.from({ length: 1 << n }, () => new Array<number>(n).fill(Infinity));
  for (let j = 0; j < n; j++) cont[0][j] = 0;
  for (let mask = 1; mask <= full; mask++) {
    for (let j = 0; j < n; j++) {
      if (mask & (1 << j)) continue;
      let best = Infinity;
      for (let x = 0; x < n; x++) {
        if (!(mask & (1 << x))) continue;
        const v = minGap[j][x] + cont[mask ^ (1 << x)][x];
        if (v < best) best = v;
      }
      cont[mask][j] = best;
    }
  }

  const seedOrder = packets
    .filter((p) => p.baseCount <= Math.min(p.topCount, countUpper - n + 1))
    .sort((a, b) => compareId(a.id, b.id));
  if (seedOrder.length === 0) {
    throw new SolveError(
      'NO_CONSISTENT_INTERPRETATION',
      'no globally consistent interpretation exists within the search window',
      {
        stage: 'seed',
        partialLength: 0,
        partialOrder: [],
        candidateId: packets[0].id,
        reason:
          `no packet can be seeded inside [${countLower}, ${countUpper}] while leaving ` +
          `room for ${n - 1} further strictly increasing absolute counters`,
        dormancyStatus: dormEnabled ? 'NOT_USED' : undefined,
      },
    );
  }
  const globalPrimaryLB = Math.min(
    ...seedOrder.map((p) => cont[full ^ (1 << p.index)][p.index]),
  );

  // Per-position arrays shared by the recursive searches.
  const orderArr = new Array<number>(n);
  const gapsArr = new Array<number>(n - 1);
  const tLoArr = new Array<number>(n);
  const tHiArr = new Array<number>(n);
  const envLoArr = new Array<Env | undefined>(n);
  const envHiArr = new Array<Env | undefined>(n);
  const sLoArr = new Array<number>(n);
  const sHiArr = new Array<number>(n);
  const used = new Uint8Array(n);
  let bestDead: DeadState | null = null;

  /** Symmetry leader: within a twin group only the smallest-ranked still
   * unused member may be picked next. Relabeling identical twins never
   * changes the objectives, and the lex-min order always consumes them in
   * ascending id rank. */
  const isSymmetryAllowed = (j: number, mask: number): boolean => {
    const pj = packets[j];
    if (pj.symRank === 0) return true;
    for (let i = 0; i < n; i++) {
      const pi = packets[i];
      if (pi.symGroup === pj.symGroup && pi.symRank < pj.symRank && !(mask & (1 << i))) {
        return false;
      }
    }
    return true;
  };

  /**
   * Extend a parameterized (post-pause) frontier across one ordinary edge of
   * counter gap d. New window:
   *   lo = max(pj.lo, max(P+s,Q) + dL) = max((P+dL)+s, max(pj.lo, Q+dL))
   *   hi = min(pj.hi, min(R+s,T) + dU) = min((R+dU)+s, min(pj.hi, T+dU))
   * Nonemptiness restricts the feasible s interval.
   */
  const extendParam = (
    envLo: Env,
    envHi: Env,
    sLo: number,
    sHi: number,
    d: number,
    pj: Packet,
  ): { envLo: Env; envHi: Env; sLo: number; sHi: number } | null => {
    const dL = d * minInterval;
    const dU = d * maxInterval;
    const nEnvLo: Env = { P: envLo.P + dL, Q: Math.max(pj.lo, envLo.Q + dL), R: 0, T: 0 };
    const nEnvHi: Env = { P: 0, Q: 0, R: envHi.R + dU, T: Math.min(pj.hi, envHi.T + dU) };
    if (nEnvLo.P > nEnvHi.R || nEnvLo.Q > nEnvHi.T) return null;
    const a = Math.max(sLo, nEnvLo.Q - nEnvHi.R);
    const b = Math.min(sHi, nEnvHi.T - nEnvLo.P);
    if (a > b) return null;
    return { envLo: nEnvLo, envHi: nEnvHi, sLo: a, sHi: b };
  };

  /** Successors in canonical order: every congruent feasible gap per target,
   * sorted by smallest gap then smallest target id. From a plain frontier
   * both ordinary moves and pause-carrying (dorm) moves are produced; from a
   * parameterized frontier only post-pause ordinary moves exist. */
  const enumerateMoves = (
    depth: number,
    last: number,
    S: number,
    c0lo: number,
    c0hi: number,
    frontier: Frontier,
    mask: number,
  ): Move[] => {
    const slotsAfter = n - 1 - depth;
    const moves: Move[] = [];
    for (let j = 0; j < n; j++) {
      if (mask & (1 << j)) continue;
      if (!isSymmetryAllowed(j, mask)) continue;
      const pj = packets[j];
      const pf = pair[last][j];

      const countLo = Math.max(pf.d0, pf.countLo, pj.baseCount - S - c0hi);
      const countHi = Math.min(
        pf.countHi,
        pj.topCount - S - c0lo,
        countUpper - slotsAfter - S - c0lo,
      );
      if (countLo > countHi) continue;

      const countPart = (d: number): { c0lo: number; c0hi: number } | null => {
        const njLo = Math.max(c0lo, pj.baseCount - S - d);
        const njHi = Math.min(c0hi, pj.topCount - S - d, countUpper - slotsAfter - S - d);
        return njLo <= njHi ? { c0lo: njLo, c0hi: njHi } : null;
      };

      if (frontier.kind === 'plain') {
        const { tLo, tHi } = frontier;

        // Ordinary (non-pause) moves, identical to the no-dormancy search.
        const dLo = Math.max(countLo, pf.timeLo, Math.ceil((pj.lo - tHi) / maxInterval));
        const dHi = Math.min(countHi, pf.timeHi, Math.floor((pj.hi - tLo) / minInterval));
        if (dLo <= dHi) {
          const dMin = ceilResidue(dLo, pf.delta, modulus);
          for (let d = dMin; d <= dHi; d += modulus) {
            if (d * minInterval > pj.hi - tLo) break;
            const ntLo = Math.max(pj.lo, tLo + d * minInterval);
            const ntHi = Math.min(pj.hi, tHi + d * maxInterval);
            if (ntLo > ntHi) continue;
            const c = countPart(d);
            if (c) {
              moves.push({ j, d, c0lo: c.c0lo, c0hi: c.c0hi, branch: { kind: 'plain', tLo: ntLo, tHi: ntHi } });
            }
          }
        }

        // Pause-carrying move: this edge spans d*L+s .. d*U+s for some
        // integer s in the requested closed range.
        if (dormEnabled) {
          const dLoD = Math.max(
            countLo,
            Math.ceil((pj.lo - tHi - Dhi) / maxInterval),
          );
          const dHiD = Math.min(
            countHi,
            Math.floor((pj.hi - tLo - Dlo) / minInterval),
          );
          if (dLoD <= dHiD) {
            const dMin = ceilResidue(dLoD, pf.delta, modulus);
            for (let d = dMin; d <= dHiD; d += modulus) {
              // Monotone rising lower bound; once it passes j's interval no
              // larger gap with the smallest pause can work.
              if (d * minInterval + Dlo > pj.hi - tLo) break;
              const a = Math.max(Dlo, pj.lo - tHi - d * maxInterval);
              const b = Math.min(Dhi, pj.hi - tLo - d * minInterval);
              if (a > b) continue;
              const c = countPart(d);
              if (!c) continue;
              moves.push({
                j,
                d,
                c0lo: c.c0lo,
                c0hi: c.c0hi,
                branch: {
                  kind: 'dorm',
                  envLo: { P: tLo + d * minInterval, Q: pj.lo, R: 0, T: 0 },
                  envHi: { P: 0, Q: 0, R: tHi + d * maxInterval, T: pj.hi },
                  sLo: a,
                  sHi: b,
                },
              });
            }
          }
        }
      } else {
        // Post-pause frontier: the pause is spent; extend the s-envelope.
        const { envLo, envHi, sLo, sHi } = frontier;
        const dMin = ceilResidue(countLo, pf.delta, modulus);
        for (let d = dMin; d <= countHi; d += modulus) {
          // The constant lower branch Q + d*L can never return below j's
          // own interval upper bound for larger gaps.
          if (envLo.Q + d * minInterval > pj.hi) break;
          const ext = extendParam(envLo, envHi, sLo, sHi, d, pj);
          if (!ext) continue;
          const c = countPart(d);
          if (!c) continue;
          moves.push({
            j,
            d,
            c0lo: c.c0lo,
            c0hi: c.c0hi,
            branch: { kind: 'post', ...ext },
          });
        }
      }
    }
    moves.sort((a, b) => a.d - b.d || compareId(packets[a.j].id, packets[b.j].id));
    return moves;
  };

  const recordDead = (
    depth: number,
    last: number,
    S: number,
    c0lo: number,
    c0hi: number,
    frontier: Frontier,
    dormEdge: number,
  ): void => {
    if (bestDead === null || depth > bestDead.depth) {
      bestDead = {
        depth,
        placed: orderArr.slice(0, depth),
        last,
        S,
        c0lo,
        c0hi,
        frontier,
        dormEdge,
      };
    }
  };

  const frontierOf = (branch: MoveBranch): Frontier => {
    if (branch.kind === 'plain') return { kind: 'plain', tLo: branch.tLo, tHi: branch.tHi };
    return { kind: 'param', envLo: branch.envLo, envHi: branch.envHi, sLo: branch.sLo, sHi: branch.sHi };
  };

  /** Serialize the frontier for memoization keys. */
  const frontierKey = (fr: Frontier): string =>
    fr.kind === 'plain'
      ? `P|${fr.tLo}|${fr.tHi}`
      : `S|${fr.envLo.P},${fr.envLo.Q},${fr.envHi.R},${fr.envHi.T}|${fr.sLo},${fr.sHi}`;

  /** Write a branch's tightened window into the per-position arrays,
   * clearing the representation not in use so stale values from another
   * DFS path can never leak into memoization keys. */
  const setPositionWindow = (depth: number, branch: MoveBranch): void => {
    if (branch.kind === 'plain') {
      tLoArr[depth] = branch.tLo;
      tHiArr[depth] = branch.tHi;
      envLoArr[depth] = undefined;
      envHiArr[depth] = undefined;
      sLoArr[depth] = 0;
      sHiArr[depth] = 0;
    } else {
      envLoArr[depth] = branch.envLo;
      envHiArr[depth] = branch.envHi;
      sLoArr[depth] = branch.sLo;
      sHiArr[depth] = branch.sHi;
      tLoArr[depth] = 0;
      tHiArr[depth] = 0;
    }
  };

  /** Whether a complete chain is admissible: with dormancy enabled the
   * unique pause must have been placed exactly once (param frontier). */
  const leafAdmissible = (fr: Frontier, dormEdge: number): boolean => {
    if (!dormEnabled) return fr.kind === 'plain';
    return fr.kind === 'param' && dormEdge >= 0;
  };

  // ------------------------------------------------------------------ Phase A
  // Minimum total counter gap. A state memo caches the best completion gap
  // sum (Infinity = dead); the state is the used set, last packet, fixed
  // prefix gap sum, tightened c0 window and the time frontier (fixed window,
  // or the s-parameterized envelope once the pause has been placed).
  const memoA = new Map<string, number>();
  let bestA = Infinity;
  let stopA = false;

  const dfsA = (
    depth: number,
    last: number,
    S: number,
    c0lo: number,
    c0hi: number,
    fr: Frontier,
    dormEdge: number,
    mask: number,
  ): number => {
    if (stopA) return Infinity;
    if (depth === n) {
      if (!leafAdmissible(fr, dormEdge)) {
        recordDead(depth, last, S, c0lo, c0hi, fr, dormEdge);
        return Infinity;
      }
      if (S < bestA) bestA = S;
      if (bestA === globalPrimaryLB) stopA = true;
      return S;
    }
    const remaining = full ^ mask;
    // Bound prune only once a feasible solution exists: before that, an
    // infinite intrinsic completion must still be explored to record the
    // deepest non-extendable state for failure evidence.
    if (Number.isFinite(bestA) && S + cont[remaining][last] >= bestA) return Infinity;

    const key = `A|${mask}|${last}|${S}|${c0lo}|${c0hi}|${dormEdge}|${frontierKey(fr)}`;
    const cached = memoA.get(key);
    if (cached !== undefined) return cached;

    const moves = enumerateMoves(depth, last, S, c0lo, c0hi, fr, mask);
    if (moves.length === 0) {
      recordDead(depth, last, S, c0lo, c0hi, fr, dormEdge);
      memoA.set(key, Infinity);
      return Infinity;
    }

    let best = Infinity;
    for (const mv of moves) {
      if (Number.isFinite(bestA) && S + mv.d + cont[remaining ^ (1 << mv.j)][mv.j] >= bestA) break;
      used[mv.j] = 1;
      orderArr[depth] = mv.j;
      gapsArr[depth - 1] = mv.d;
      const nextDorm = mv.branch.kind === 'dorm' ? depth - 1 : dormEdge;
      const v = dfsA(
        depth + 1,
        mv.j,
        S + mv.d,
        mv.c0lo,
        mv.c0hi,
        frontierOf(mv.branch),
        nextDorm,
        mask | (1 << mv.j),
      );
      used[mv.j] = 0;
      if (v < best) best = v;
      if (stopA) break;
    }
    if (best === Infinity) {
      recordDead(depth, last, S, c0lo, c0hi, fr, dormEdge);
    }
    memoA.set(key, best);
    return best;
  };

  for (const seed of seedOrder) {
    if (stopA) break;
    const c0hi0 = Math.min(seed.topCount, countUpper - n + 1);
    used.fill(0);
    used[seed.index] = 1;
    orderArr[0] = seed.index;
    dfsA(
      1,
      seed.index,
      0,
      seed.baseCount,
      c0hi0,
      { kind: 'plain', tLo: seed.lo, tHi: seed.hi },
      -1,
      1 << seed.index,
    );
  }
  if (bestA === Infinity) {
    throw buildFailureEvidence(
      packets,
      pair,
      bestDead,
      modulus,
      countUpper,
      minInterval,
      maxInterval,
      dormEnabled ? { lower: Dlo, upper: Dhi } : undefined,
    );
  }
  const Pstar = bestA;

  // ------------------------------------------------------------- Phase B/C key
  /** Exact state signature for the deviation/lex phases: full prefix packet
   * sequence, its gaps and every position's tightened window (or envelope).
   * Paths sharing this signature have identical prefix deviation and an
   * identical frontier, so memoized results are interchangeable. */
  const stateKeyBC = (
    depth: number,
    last: number,
    S: number,
    c0lo: number,
    c0hi: number,
    fr: Frontier,
    dormEdge: number,
  ): string => {
    let s = `${depth}|${last}|${S}|${c0lo}|${c0hi}|${dormEdge}|${frontierKey(fr)}`;
    for (let k = 0; k < depth; k++) {
      if (envLoArr[k]) {
        const eL = envLoArr[k]!;
        const eH = envHiArr[k]!;
        s += `>${orderArr[k]}:${k > 0 ? gapsArr[k - 1] : 0}:s${eL.P},${eL.Q},${eH.R},${eH.T}|${sLoArr[k]},${sHiArr[k]}`;
      } else {
        s += `>${orderArr[k]}:${k > 0 ? gapsArr[k - 1] : 0}:${tLoArr[k]},${tHiArr[k]}`;
      }
    }
    return s;
  };

  /**
   * Exact primary-optimal-chain oracle. Returns true exactly when a
   * completion of the CURRENT state reaches total gap Pstar.
   */
  const memoOpt = new Map<string, boolean>();
  const optimalFromState = (
    depth: number,
    last: number,
    S: number,
    c0lo: number,
    c0hi: number,
    fr: Frontier,
    dormEdge: number,
    mask: number,
  ): boolean => {
    if (depth === n) return S === Pstar && leafAdmissible(fr, dormEdge);
    const key = `O|${mask}|${last}|${S}|${c0lo}|${c0hi}|${dormEdge}|${frontierKey(fr)}`;
    const cached = memoOpt.get(key);
    if (cached !== undefined) return cached;

    const remaining = full ^ mask;
    const moves = enumerateMoves(depth, last, S, c0lo, c0hi, fr, mask);
    let ok = false;
    for (const mv of moves) {
      if (S + mv.d + cont[remaining ^ (1 << mv.j)][mv.j] > Pstar) continue;
      used[mv.j] = 1;
      const nextDorm = mv.branch.kind === 'dorm' ? depth - 1 : dormEdge;
      const v = optimalFromState(
        depth + 1,
        mv.j,
        S + mv.d,
        mv.c0lo,
        mv.c0hi,
        frontierOf(mv.branch),
        nextDorm,
        mask | (1 << mv.j),
      );
      used[mv.j] = 0;
      if (v) {
        ok = true;
        break;
      }
    }
    memoOpt.set(key, ok);
    return ok;
  };

  /** Successor moves that lie on at least one primary-optimal completion. */
  const optimalMoves = (
    depth: number,
    last: number,
    S: number,
    c0lo: number,
    c0hi: number,
    fr: Frontier,
    dormEdge: number,
    mask: number,
  ): Move[] => {
    const remaining = full ^ mask;
    const all = enumerateMoves(depth, last, S, c0lo, c0hi, fr, mask);
    return all.filter((mv) => {
      if (S + mv.d + cont[remaining ^ (1 << mv.j)][mv.j] > Pstar) return false;
      const nextDorm = mv.branch.kind === 'dorm' ? depth - 1 : dormEdge;
      return optimalFromState(
        depth + 1,
        mv.j,
        S + mv.d,
        mv.c0lo,
        mv.c0hi,
        frontierOf(mv.branch),
        nextDorm,
        mask | (1 << mv.j),
      );
    });
  };

  /** Whether a seed packet can begin any primary-optimal completion. */
  const seedIsOptimal = (seedIndex: number): boolean => {
    const seed = packets[seedIndex];
    const c0hi0 = Math.min(seed.topCount, countUpper - n + 1);
    if (seed.baseCount > c0hi0) return false;
    return optimalFromState(
      1,
      seedIndex,
      0,
      seed.baseCount,
      c0hi0,
      { kind: 'plain', tLo: seed.lo, tHi: seed.hi },
      -1,
      1 << seedIndex,
    );
  };

  // ------------------------------------------------------------- s deviation
  /**
   * For a fixed complete chain (order, gaps) whose pause straddles edge
   * `dormEdge` with feasible integer s ∈ [sA, sB], jointly minimize the
   * midpoint deviation over (s, times).
   *
   * Narrow s intervals are enumerated exactly. For wide intervals every
   * tight-edge-chain candidate is an affine function v + b*s of the pause
   * (generated with the same forward/backward tight-chain propagation as
   * optimalTimes); the integer optimum can only change at a window-membership
   * crossing, a feasibility toggle, an |.| kink, or a crossing of two
   * same-position candidates, so floor/ceil of all such breakpoints (plus
   * the interval ends) contain an exact optimum.
   */
  const leafDeviationCache = new Map<string, { dev: number; s: number; times: number[] } | null>();

  const bestLeafDeviation = (
    order: number[],
    gaps: number[],
    dormEdge: number,
    sA: number,
    sB: number,
  ): { dev: number; devInfinity: boolean; s: number; times: number[] } => {
    const cacheKey = `${order.join(',')}|${gaps.join(',')}|${dormEdge}|${sA}|${sB}`;
    const cached = leafDeviationCache.get(cacheKey);
    if (cached !== undefined) {
      return cached === null
        ? { dev: Infinity, devInfinity: true, s: sA, times: [] }
        : { ...cached, devInfinity: false };
    }

    const evalAt = (s: number): { dev: number; times: number[] } | null => {
      const shift = new Array<number>(n - 1).fill(0);
      shift[dormEdge] = s;
      const windows = tightenWindows(packets, order, gaps, minInterval, maxInterval, shift);
      if (windows === null) return null;
      const { times, deviation2 } = optimalTimes(
        packets,
        order,
        windows,
        gaps,
        minInterval,
        maxInterval,
        shift,
      );
      return { dev: deviation2, times };
    };

    const finish = (
      bestLeaf: { dev: number; s: number; times: number[] } | null,
    ): { dev: number; devInfinity: boolean; s: number; times: number[] } => {
      leafDeviationCache.set(cacheKey, bestLeaf);
      if (bestLeaf === null) return { dev: Infinity, devInfinity: true, s: sA, times: [] };
      return { ...bestLeaf, devInfinity: false };
    };

    let best: { dev: number; s: number; times: number[] } | null = null;
    const consider = (s: number): void => {
      if (s < sA || s > sB) return;
      const v = evalAt(s);
      if (v && (best === null || v.dev < best.dev || (v.dev === best.dev && s < best.s))) {
        best = { dev: v.dev, s, times: v.times };
      }
    };

    if (sA > sB) return finish(null);

    if (sB - sA <= 48) {
      for (let s = sA; s <= sB; s++) consider(s);
      return finish(best);
    }

    // Symbolic pass for wide feasible intervals.
    const aff = (v: number, b = 0): Aff => ({ v, b });
    const affKey = (a: Aff): string => `${a.b}:${a.v}`;
    const addAff = (a: Aff, b: Aff): Aff => ({ v: a.v + b.v, b: a.b + b.b });
    const subAff = (a: Aff, b: Aff): Aff => ({ v: a.v - b.v, b: a.b - b.b });
    const dedupe = (list: Aff[]): Aff[] => {
      const m = new Map<string, Aff>();
      for (const a of list) m.set(affKey(a), a);
      return [...m.values()];
    };

    // Tightened windows as max/min lists of affine bounds in s.
    const winLo: Aff[][] = new Array(n);
    const winHi: Aff[][] = new Array(n);
    winLo[0] = [aff(packets[order[0]].lo)];
    winHi[0] = [aff(packets[order[0]].hi)];
    for (let k = 1; k < n; k++) {
      const p = packets[order[k]];
      const edgeIsDorm = k - 1 === dormEdge;
      const eLo = aff(gaps[k - 1] * minInterval, edgeIsDorm ? 1 : 0);
      const eHi = aff(gaps[k - 1] * maxInterval, edgeIsDorm ? 1 : 0);
      winLo[k] = dedupe([aff(p.lo), ...winLo[k - 1].map((x) => addAff(x, eLo))]);
      winHi[k] = dedupe([aff(p.hi), ...winHi[k - 1].map((x) => addAff(x, eHi))]);
    }
    for (let k = n - 2; k >= 0; k--) {
      const edgeIsDorm = k === dormEdge;
      const eLo = aff(gaps[k] * minInterval, edgeIsDorm ? 1 : 0);
      const eHi = aff(gaps[k] * maxInterval, edgeIsDorm ? 1 : 0);
      winLo[k] = dedupe([...winLo[k], ...winLo[k + 1].map((x) => subAff(x, eHi))]);
      winHi[k] = dedupe([...winHi[k], ...winHi[k + 1].map((x) => subAff(x, eLo))]);
    }

    // Tight-chain candidates: every pivot propagated along arbitrary
    // forward/backward chains of tight lower/upper edge constraints.
    const cands: Aff[][] = new Array(n);
    for (let k = 0; k < n; k++) {
      const p = packets[order[k]];
      const f = Math.floor(p.mid2 / 2);
      const c = p.mid2 % 2 === 0 ? f : f + 1;
      cands[k] = [aff(p.lo), aff(p.hi), aff(f), aff(c)];
    }
    const edgeBoundsAt = (k: number): [Aff, Aff] => {
      const edgeIsDorm = k === dormEdge;
      return [
        aff(gaps[k] * minInterval, edgeIsDorm ? 1 : 0),
        aff(gaps[k] * maxInterval, edgeIsDorm ? 1 : 0),
      ];
    };
    const addChains = (start: number, dir: 1 | -1): void => {
      const visit = (pos: number, forms: Aff[]): void => {
        const next = pos + dir;
        if (next < 0 || next >= n) return;
        const edge = dir === 1 ? pos : next;
        const [eLo, eHi] = edgeBoundsAt(edge);
        const pushed: Aff[] = [];
        for (const x of forms) {
          pushed.push(dir === 1 ? addAff(x, eLo) : subAff(x, eLo));
          pushed.push(dir === 1 ? addAff(x, eHi) : subAff(x, eHi));
        }
        cands[next] = dedupe([...cands[next], ...pushed]);
        visit(next, pushed);
      };
      for (const pivot of cands[start].slice()) visit(start, [pivot]);
    };
    for (let j = 0; j < n; j++) addChains(j, 1);
    for (let j = 0; j < n; j++) addChains(j, -1);
    for (let k = 0; k < n; k++) cands[k] = dedupe(cands[k]);

    const points = new Set<number>([sA, sB]);
    const addCrossing = (x: Aff, y: Aff): void => {
      const denom = x.b - y.b;
      if (denom === 0) return;
      const r = (y.v - x.v) / denom;
      points.add(Math.floor(r));
      points.add(Math.ceil(r));
    };

    for (let k = 0; k < n; k++) {
      const p = packets[order[k]];
      const list = cands[k];
      for (const cand of list) {
        for (const bound of winLo[k]) addCrossing(cand, bound);
        for (const bound of winHi[k]) addCrossing(cand, bound);
        if (cand.b !== 0) {
          const r = (p.mid2 - 2 * cand.v) / (2 * cand.b);
          points.add(Math.floor(r));
          points.add(Math.ceil(r));
        }
      }
      for (let a = 0; a < list.length; a++) {
        for (let b2 = a + 1; b2 < list.length; b2++) addCrossing(list[a], list[b2]);
      }
      if (k < n - 1) {
        const [eLo, eHi] = edgeBoundsAt(k);
        for (const x of list) {
          for (const y of cands[k + 1]) {
            addCrossing(subAff(y, x), eLo);
            addCrossing(subAff(y, x), eHi);
          }
        }
      }
    }
    for (const s of points) consider(s);
    return finish(best);
  };

  const leafEval = (dormEdge: number): { dev: number; s: number } => {
    const order = orderArr.slice();
    const gaps = gapsArr.slice();
    if (!dormEnabled) {
      const windows = tightenWindows(packets, order, gaps, minInterval, maxInterval);
      if (!windows) return { dev: Infinity, s: 0 };
      return { dev: optimalTimes(packets, order, windows, gaps, minInterval, maxInterval).deviation2, s: 0 };
    }
    // Recover the feasible s interval carried at the last (parameterized)
    // frontier; an inadmissible leaf has no envelope to evaluate.
    if (!envLoArr[n - 1]) return { dev: Infinity, s: Dlo };
    const r = bestLeafDeviation(order, gaps, dormEdge, sLoArr[n - 1], sHiArr[n - 1]);
    return { dev: r.dev, s: r.s };
  };

  // ------------------------------------------------------------------ Phase B
  // Minimum total deviation2 over primary-optimal chains (the pause duration
  // is free inside its feasible interval and optimized at each leaf).
  const memoB = new Map<string, number>();
  let bestB = Infinity;

  const independentDevLB = (mask: number): number => {
    let sum = 0;
    const remaining = full ^ mask;
    for (let j = 0; j < n; j++) {
      if (remaining & (1 << j)) sum += minDeviation2(packets[j].lo, packets[j].hi, packets[j].mid2);
    }
    return sum;
  };

  const dfsB = (
    depth: number,
    last: number,
    S: number,
    c0lo: number,
    c0hi: number,
    fr: Frontier,
    dormEdge: number,
    mask: number,
  ): number => {
    if (depth === n) {
      const v = leafEval(dormEdge).dev;
      if (v < bestB) bestB = v;
      return v;
    }

    let placedLB = 0;
    for (let k = 0; k < depth; k++) {
      if (envLoArr[k]) {
        const lo = Math.max(envLoArr[k]!.Q, envLoArr[k]!.P + sLoArr[k]);
        const hi = Math.min(envHiArr[k]!.T, envHiArr[k]!.R + sHiArr[k]);
        placedLB += minDeviation2(lo, hi, packets[orderArr[k]].mid2);
      } else {
        placedLB += minDeviation2(tLoArr[k], tHiArr[k], packets[orderArr[k]].mid2);
      }
    }
    if (placedLB + independentDevLB(mask) >= bestB) return Infinity;

    const key = stateKeyBC(depth, last, S, c0lo, c0hi, fr, dormEdge);
    const cached = memoB.get(key);
    if (cached !== undefined) return cached;

    const moves = optimalMoves(depth, last, S, c0lo, c0hi, fr, dormEdge, mask);
    let best = Infinity;
    for (const mv of moves) {
      used[mv.j] = 1;
      orderArr[depth] = mv.j;
      gapsArr[depth - 1] = mv.d;
      setPositionWindow(depth, mv.branch);
      const branch = mv.branch;
      const nextDorm = branch.kind === 'dorm' ? depth - 1 : dormEdge;
      const v = dfsB(
        depth + 1,
        mv.j,
        S + mv.d,
        mv.c0lo,
        mv.c0hi,
        frontierOf(branch),
        nextDorm,
        mask | (1 << mv.j),
      );
      used[mv.j] = 0;
      if (v < best) best = v;
    }
    memoB.set(key, best);
    return best;
  };

  for (const seed of seedOrder) {
    if (!seedIsOptimal(seed.index)) continue;
    const c0hi0 = Math.min(seed.topCount, countUpper - n + 1);
    used.fill(0);
    envLoArr.fill(undefined);
    envHiArr.fill(undefined);
    used[seed.index] = 1;
    orderArr[0] = seed.index;
    tLoArr[0] = seed.lo;
    tHiArr[0] = seed.hi;
    dfsB(
      1,
      seed.index,
      0,
      seed.baseCount,
      c0hi0,
      { kind: 'plain', tLo: seed.lo, tHi: seed.hi },
      -1,
      1 << seed.index,
    );
  }
  if (bestB === Infinity) {
    // Defensive: phase A guarantees a primary-optimal feasible leaf.
    throw new SolveError(
      'NO_CONSISTENT_INTERPRETATION',
      'internal search failure during deviation optimization',
    );
  }
  const Dstar = bestB;

  // ------------------------------------------------------------------ Phase C
  // Greedily construct the lexicographically smallest id sequence. At every
  // position candidate packets are tried in ascending id order; a memoized
  // boolean oracle decides whether a primary-optimal, deviation-optimal
  // completion exists with the candidate fixed at the current position.
  const memoC = new Map<string, boolean>();

  const dfsCfeasible = (
    depth: number,
    last: number,
    S: number,
    c0lo: number,
    c0hi: number,
    fr: Frontier,
    dormEdge: number,
    mask: number,
  ): boolean => {
    if (depth === n) {
      return leafEval(dormEdge).dev === Dstar;
    }
    const key = stateKeyBC(depth, last, S, c0lo, c0hi, fr, dormEdge);
    const cached = memoC.get(key);
    if (cached !== undefined) return cached;

    const moves = optimalMoves(depth, last, S, c0lo, c0hi, fr, dormEdge, mask);
    let ok = false;
    for (const mv of moves) {
      used[mv.j] = 1;
      orderArr[depth] = mv.j;
      gapsArr[depth - 1] = mv.d;
      const branch = mv.branch;
      setPositionWindow(depth, branch);
      const nextDorm = branch.kind === 'dorm' ? depth - 1 : dormEdge;
      ok = dfsCfeasible(
        depth + 1,
        mv.j,
        S + mv.d,
        mv.c0lo,
        mv.c0hi,
        frontierOf(branch),
        nextDorm,
        mask | (1 << mv.j),
      );
      used[mv.j] = 0;
      if (ok) break;
    }
    memoC.set(key, ok);
    return ok;
  };

  const chosen: number[] = [];
  const fixedGaps: number[] = [];
  let curLast = -1;
  let curS = 0;
  let curC0lo = 0;
  let curC0hi = 0;
  let curFr: Frontier = { kind: 'plain', tLo: 0, tHi: 0 };
  let curDorm = -1;
  let curMask = 0;

  /** Reproduce the forward-tightened windows of the fixed prefix so the
   * oracle's memoization keys and the leaf evaluation see a consistent
   * state: fixed windows before the pause, s-envelopes from the pause edge
   * onward. */
  const replayPrefixWindows = (): void => {
    envLoArr.fill(undefined);
    envHiArr.fill(undefined);
    if (chosen.length === 0) return;
    tLoArr[0] = packets[chosen[0]].lo;
    tHiArr[0] = packets[chosen[0]].hi;
    for (let k = 1; k < chosen.length; k++) {
      const p = packets[chosen[k]];
      const d = fixedGaps[k - 1];
      orderArr[k] = chosen[k];
      gapsArr[k - 1] = d;
      if (k - 1 === curDorm) {
        envLoArr[k] = { P: tLoArr[k - 1] + d * minInterval, Q: p.lo, R: 0, T: 0 };
        envHiArr[k] = { P: 0, Q: 0, R: tHiArr[k - 1] + d * maxInterval, T: p.hi };
        sLoArr[k] = Math.max(Dlo, p.lo - tHiArr[k - 1] - d * maxInterval);
        sHiArr[k] = Math.min(Dhi, p.hi - tLoArr[k - 1] - d * minInterval);
      } else if (curDorm >= 0 && k - 1 > curDorm) {
        const ext = extendParam(
          envLoArr[k - 1]!,
          envHiArr[k - 1]!,
          sLoArr[k - 1],
          sHiArr[k - 1],
          d,
          p,
        );
        if (ext) {
          envLoArr[k] = ext.envLo;
          envHiArr[k] = ext.envHi;
          sLoArr[k] = ext.sLo;
          sHiArr[k] = ext.sHi;
        }
      } else {
        tLoArr[k] = Math.max(p.lo, tLoArr[k - 1] + d * minInterval);
        tHiArr[k] = Math.min(p.hi, tHiArr[k - 1] + d * maxInterval);
      }
    }
    orderArr[0] = chosen[0];
  };

  for (let depth = 0; depth < n; depth++) {
    let candidates: { j: number; mv: Move | null }[];
    if (depth === 0) {
      candidates = seedOrder
        .filter((p) => seedIsOptimal(p.index))
        .map((p) => ({ j: p.index, mv: null }));
    } else {
      candidates = optimalMoves(depth, curLast, curS, curC0lo, curC0hi, curFr, curDorm, curMask).map(
        (mv) => ({ j: mv.j, mv }),
      );
    }
    candidates.sort((a, b) => compareId(packets[a.j].id, packets[b.j].id));

    let picked: { j: number; mv: Move | null } | null = null;
    for (const cand of candidates) {
      const j = cand.j;
      used.fill(0);
      for (const ix of chosen) used[ix] = 1;
      used[j] = 1;
      replayPrefixWindows();
      orderArr[depth] = j;

      let ok: boolean;
      if (depth === 0) {
        const seed = packets[j];
        const c0hi0 = Math.min(seed.topCount, countUpper - n + 1);
        tLoArr[0] = seed.lo;
        tHiArr[0] = seed.hi;
        ok = dfsCfeasible(
          1,
          j,
          0,
          seed.baseCount,
          c0hi0,
          { kind: 'plain', tLo: seed.lo, tHi: seed.hi },
          -1,
          1 << j,
        );
      } else {
        const mv = cand.mv!;
        const branch = mv.branch;
        gapsArr[depth - 1] = mv.d;
        setPositionWindow(depth, branch);
        const nextDorm = branch.kind === 'dorm' ? depth - 1 : curDorm;
        ok = dfsCfeasible(
          depth + 1,
          j,
          curS + mv.d,
          mv.c0lo,
          mv.c0hi,
          frontierOf(branch),
          nextDorm,
          curMask | (1 << j),
        );
      }
      used[j] = 0;
      if (ok) {
        picked = cand;
        break;
      }
    }

    if (!picked) {
      // Defensive: phases A/B certify a feasible choice at every position.
      throw new SolveError('NO_CONSISTENT_INTERPRETATION', 'internal failure reconstructing lex-min order');
    }

    chosen.push(picked.j);
    if (depth === 0) {
      const seed = packets[picked.j];
      curC0lo = seed.baseCount;
      curC0hi = Math.min(seed.topCount, countUpper - n + 1);
      curFr = { kind: 'plain', tLo: seed.lo, tHi: seed.hi };
    } else {
      const mv = picked.mv!;
      const branch = mv.branch;
      fixedGaps.push(mv.d);
      curS += mv.d;
      curC0lo = mv.c0lo;
      curC0hi = mv.c0hi;
      curFr = frontierOf(branch);
      if (branch.kind === 'dorm') curDorm = depth - 1;
    }
    curLast = picked.j;
    curMask |= 1 << picked.j;
  }

  // Assemble the certified chain: smallest admissible c0.
  const finalOrder = chosen.slice();
  const finalGaps = fixedGaps.slice();

  // Pick the carrying edge and duration. Counts and the id sequence are
  // fixed; evaluate every edge position and prefer (deviation, duration,
  // edge index) lexicographically. Without dormancy the edge stays unused.
  let finalEdge = -1;
  let finalS = 0;
  let finalTimes: number[] = [];
  let finalDev = Infinity;

  if (dormEnabled) {
    // Independent forward time windows for the fixed chain (no pause): the
    // pause onset at edge e starts from packet e's plain tightened window.
    const fwdLo = new Array<number>(n);
    const fwdHi = new Array<number>(n);
    fwdLo[0] = packets[finalOrder[0]].lo;
    fwdHi[0] = packets[finalOrder[0]].hi;
    for (let k = 1; k < n; k++) {
      const p = packets[finalOrder[k]];
      fwdLo[k] = Math.max(p.lo, fwdLo[k - 1] + finalGaps[k - 1] * minInterval);
      fwdHi[k] = Math.min(p.hi, fwdHi[k - 1] + finalGaps[k - 1] * maxInterval);
    }

    for (let e = 0; e < n - 1; e++) {
      if (fwdLo[e] > fwdHi[e]) continue;
      const pNext = packets[finalOrder[e + 1]];
      const d = finalGaps[e];
      let sA = Math.max(Dlo, pNext.lo - fwdHi[e] - d * maxInterval);
      let sB = Math.min(Dhi, pNext.hi - fwdLo[e] - d * minInterval);
      if (sA > sB) continue;
      let envLo: Env = { P: fwdLo[e] + d * minInterval, Q: pNext.lo, R: 0, T: 0 };
      let envHi: Env = { P: 0, Q: 0, R: fwdHi[e] + d * maxInterval, T: pNext.hi };
      let feasible = true;
      for (let k = e + 2; k < n; k++) {
        const ext = extendParam(envLo, envHi, sA, sB, finalGaps[k - 1], packets[finalOrder[k]]);
        if (!ext) {
          feasible = false;
          break;
        }
        envLo = ext.envLo;
        envHi = ext.envHi;
        sA = ext.sLo;
        sB = ext.sHi;
      }
      if (!feasible) continue;
      const r = bestLeafDeviation(finalOrder, finalGaps, e, sA, sB);
      if (r.devInfinity) continue;
      if (
        r.dev < finalDev ||
        (r.dev === finalDev && (r.s < finalS || (r.s === finalS && e < finalEdge)))
      ) {
        finalDev = r.dev;
        finalEdge = e;
        finalS = r.s;
        finalTimes = r.times;
      }
    }
    if (finalEdge < 0) {
      // Defensive: phases A/B/C certified a pause-bearing optimal chain.
      throw new SolveError(
        'NO_CONSISTENT_INTERPRETATION',
        'internal failure selecting the dormancy edge',
      );
    }
  } else {
    const windows = tightenWindows(packets, finalOrder, finalGaps, minInterval, maxInterval);
    if (!windows) {
      throw new SolveError('NO_CONSISTENT_INTERPRETATION', 'internal failure tightening final windows');
    }
    const r = optimalTimes(packets, finalOrder, windows, finalGaps, minInterval, maxInterval);
    finalTimes = r.times;
    finalDev = r.deviation2;
  }
  let gapSum = 0;
  for (const d of finalGaps) gapSum += d;

  return buildResult(
    packets,
    {
      gapSum,
      deviation2: finalDev,
      times: finalTimes,
      order: finalOrder,
      c0: curC0lo,
      gaps: finalGaps,
    },
    modulus,
    minInterval,
    maxInterval,
    dormEnabled ? { lower: Dlo, upper: Dhi, edge: finalEdge, duration: finalS } : undefined,
  );
}

function buildResult(
  packets: Packet[],
  cand: { gapSum: number; deviation2: number; times: number[]; order: number[]; c0: number; gaps: number[] },
  modulus: number,
  minInterval: number,
  maxInterval: number,
  dormancy?: { lower: number; upper: number; edge: number; duration: number },
): SolveResult {
  const n = cand.order.length;
  const order = cand.order.map((ix) => packets[ix].id);
  const assignments: AssignedPacket[] = [];
  const adjacency: AdjacencyEvidence[] = [];
  const missingSegments: MissingSegment[] = [];
  const shift = new Array<number>(n - 1).fill(0);
  if (dormancy) shift[dormancy.edge] = dormancy.duration;

  let count = cand.c0;
  for (let k = 0; k < n; k++) {
    const p = packets[cand.order[k]];
    assignments.push({
      position: k,
      id: p.id,
      absoluteCount: count,
      time: cand.times[k],
      remainder: p.remainder,
      timeInterval: { lower: p.lo, upper: p.hi },
    });
    if (k > 0) {
      const d = cand.gaps[k - 1];
      const prevCount = count - d;
      if (d > 1) {
        missingSegments.push({ fromCount: prevCount + 1, toCount: count - 1, length: d - 1 });
      }
      const tGap = cand.times[k] - cand.times[k - 1];
      const prevP = packets[cand.order[k - 1]];
      const carries = dormancy !== undefined && dormancy.edge === k - 1;
      const pause = carries ? dormancy.duration : 0;
      adjacency.push({
        index: k - 1,
        fromId: prevP.id,
        toId: p.id,
        fromCount: prevCount,
        toCount: count,
        countGap: d,
        fromTime: cand.times[k - 1],
        toTime: cand.times[k],
        timeGap: tGap,
        allowedTimeGap: { min: d * minInterval + pause, max: d * maxInterval + pause },
        missingBetween: d - 1,
        congruence: { remainder: p.remainder, modulus },
        absoluteCountCongruent: modNonNeg(count, modulus) === p.remainder,
        timeWithinInterval: {
          from: { lower: prevP.lo, upper: prevP.hi },
          to: { lower: p.lo, upper: p.hi },
        },
        dormancy: dormancy ? { duration: pause, carriesDormancy: carries } : undefined,
        satisfied:
          tGap >= d * minInterval + pause &&
          tGap <= d * maxInterval + pause &&
          cand.times[k - 1] >= prevP.lo &&
          cand.times[k - 1] <= prevP.hi &&
          cand.times[k] >= p.lo &&
          cand.times[k] <= p.hi &&
          modNonNeg(prevCount, modulus) === prevP.remainder &&
          modNonNeg(count, modulus) === p.remainder,
      });
    }
    if (k < n - 1) count += cand.gaps[k];
  }

  const result: SolveResult = {
    order,
    assignments,
    missingSegments,
    missingCountTotal: cand.gapSum - (n - 1),
    adjacency,
    observedCountRange: { first: cand.c0, last: cand.c0 + cand.gapSum },
  };
  if (dormancy) {
    result.dormancy = {
      duration: dormancy.duration,
      adjacencyIndex: dormancy.edge,
      fromPosition: dormancy.edge,
      toPosition: dormancy.edge + 1,
      fromId: packets[cand.order[dormancy.edge]].id,
      toId: packets[cand.order[dormancy.edge + 1]].id,
      range: { lower: dormancy.lower, upper: dormancy.upper },
    };
  }
  return result;
}


// --------------------------------------------------------------- failure evidence

function buildFailureEvidence(
  packets: Packet[],
  pair: PairFeas[][],
  bestDead: DeadState | null,
  modulus: number,
  countUpper: number,
  minInterval: number,
  maxInterval: number,
  dormancy?: { lower: number; upper: number },
): SolveError {
  const make = (evidence: ConstraintFailureEvidence): SolveError =>
    new SolveError(
      'NO_CONSISTENT_INTERPRETATION',
      'no globally consistent interpretation exists within the search window',
      evidence,
    );

  if (bestDead === null) {
    return make({
      stage: 'seed',
      partialLength: 0,
      partialOrder: [],
      candidateId: packets[0].id,
      reason: 'no packet can be seeded inside the absolute count search window',
      dormancyStatus: dormancy ? 'NOT_USED' : undefined,
    });
  }

  const n = packets.length;
  const { depth, placed, last, S, c0lo, c0hi, frontier, dormEdge } = bestDead;
  const partialOrder = placed.map((ix) => packets[ix].id);
  const usedNow = new Set(placed);
  const slotsAfter = n - 1 - depth;

  // A complete ordering that never placed the required pause is itself the
  // first non-extendable witness.
  if (dormancy && depth === n && frontier.kind === 'plain') {
    return make({
      stage: 'extension',
      partialLength: depth,
      partialOrder,
      candidateId: packets[last].id,
      reason:
        `all ${n} packets can be ordered without a pause, but the request requires exactly one ` +
        `dormancy of duration inside [${dormancy.lower}, ${dormancy.upper}] on some adjacent pair; ` +
        `no such placement leaves the rest of the chain feasible`,
      dormancyStatus: 'NOT_USED',
    });
  }

  // Tightened time window of the last fixed packet, either fixed or the
  // extremal envelope reachable inside the feasible pause interval.
  const tLo =
    frontier.kind === 'plain'
      ? frontier.tLo
      : Math.max(frontier.envLo.P + frontier.sLo, frontier.envLo.Q);
  const tHi =
    frontier.kind === 'plain'
      ? frontier.tHi
      : Math.min(frontier.envHi.R + frontier.sHi, frontier.envHi.T);
  const pauseUsed = frontier.kind === 'param';

  type Blocker = {
    j: number;
    cause: 'TIME_GAP' | 'COUNT_WINDOW' | 'CONGRUENCE';
    dStar: number;
    delta: number;
    timeRange: { min: number; max: number };
    countRange: { min: number; max: number };
    achievable: { min: number; max: number };
    /** Smallest congruent gap feasible if THIS edge carried the pause. */
    dormGap: number;
    /** Positive pause durations that would make dormGap feasible. */
    dormNeeded?: { min: number; max: number };
  };
  const blockers: Blocker[] = [];

  const congruentGaps = (lo: number, hi: number, delta: number): number[] => {
    if (lo > hi || !Number.isFinite(lo) || !Number.isFinite(hi)) return [];
    const first = ceilResidue(lo, delta, modulus);
    const out: number[] = [];
    for (let d = first; d <= hi; d += modulus) out.push(d);
    return out;
  };

  for (let j = 0; j < n; j++) {
    if (usedNow.has(j)) continue;
    const pj = packets[j];
    const pf = pair[last][j];
    const d0 = pf.delta === 0 ? modulus : pf.delta;

    const Tlo = Math.ceil((pj.lo - tHi) / maxInterval);
    const Thi = Math.floor((pj.hi - tLo) / minInterval);
    const Clo = Math.max(pf.countLo, pj.baseCount - S - c0hi);
    const Chi = Math.min(pf.countHi, pj.topCount - S - c0lo, countUpper - slotsAfter - S - c0lo);

    let cause: Blocker['cause'];
    let dStar: number;
    let dormGap = Infinity;
    let dormNeeded: Blocker['dormNeeded'];

    if (pauseUsed && frontier.kind === 'param') {
      // Pause already spent: test extensions exactly against the surviving
      // s-envelope (the future must stay feasible for some s in [sLo, sHi]).
      const gaps = congruentGaps(Math.max(d0, Clo), Chi, pf.delta);
      const feasibleGap = gaps.find((d) => {
        // The extension must also keep the seed-counter c0 window feasible.
        const njLo = Math.max(c0lo, pj.baseCount - S - d);
        const njHi = Math.min(c0hi, pj.topCount - S - d, countUpper - slotsAfter - S - d);
        if (njLo > njHi) return false;
        const dL = d * minInterval;
        const dU = d * maxInterval;
        const P = frontier.envLo.P + dL;
        const Q = Math.max(pj.lo, frontier.envLo.Q + dL);
        const R = frontier.envHi.R + dU;
        const T = Math.min(pj.hi, frontier.envHi.T + dU);
        if (P > R || Q > T) return false;
        const a = Math.max(frontier.sLo, Q - R);
        const b = Math.min(frontier.sHi, T - P);
        return a <= b;
      });
      if (feasibleGap !== undefined) continue; // extendable; not a dead end
      if (Clo > Chi) cause = 'COUNT_WINDOW';
      else if (gaps.length === 0) cause = 'CONGRUENCE';
      else cause = 'TIME_GAP';
      dStar = gaps[0] ?? Infinity;
    } else {
      const plainLo = Math.max(d0, pf.timeLo, Tlo, Clo);
      const plainHi = Math.min(pf.timeHi, Thi, Chi);
      const dPlain = congruentGaps(plainLo, plainHi, pf.delta)[0] ?? Infinity;
      if (dPlain !== Infinity) continue; // extendable; not a dead end

      const dTime = congruentGaps(Math.max(d0, Tlo), Thi, pf.delta)[0] ?? Infinity;
      const dCount = congruentGaps(Math.max(d0, Clo), Chi, pf.delta)[0] ?? Infinity;
      if (dCount !== Infinity) {
        cause = 'TIME_GAP';
        dStar = dCount;
      } else if (dTime !== Infinity) {
        cause = 'COUNT_WINDOW';
        dStar = dTime;
      } else {
        cause = Tlo > Thi ? 'TIME_GAP' : 'CONGRUENCE';
        dStar = Infinity;
      }

      if (dormancy) {
        // Structural crossing test: could THIS edge carry the pause if its
        // positive integer duration were unrestricted? For a counter gap d
        // the observed difference Δ needs some s >= 1 with
        // d*L+s <= Δmax and d*U+s >= Δmin, i.e.
        // s in [max(1, Δmin - dU), Δmax - dL].
        const deltaMin = pj.lo - tHi;
        const deltaMax = pj.hi - tLo;
        const structLo = Math.max(d0, Clo);
        const structHi = Math.min(Chi, Math.floor((deltaMax - 1) / minInterval));
        for (const dg of congruentGaps(structLo, structHi, pf.delta)) {
          const sLoNeed = Math.max(1, deltaMin - dg * maxInterval);
          const sHiNeed = deltaMax - dg * minInterval;
          if (sLoNeed <= sHiNeed) {
            dormGap = dg;
            dormNeeded = { min: sLoNeed, max: sHiNeed };
            break;
          }
        }
      }
    }

    blockers.push({
      j,
      cause,
      dStar,
      delta: pf.delta,
      timeRange: { min: Tlo, max: Thi },
      countRange: { min: Clo, max: Chi },
      achievable: { min: pj.lo - tHi, max: pj.hi - tLo },
      dormGap,
      dormNeeded,
    });
  }

  // Prefer reporting the edge where the pause is provably the missing
  // ingredient, then the original (cause, gap, id) canonical ordering.
  const causeRank = { TIME_GAP: 0, COUNT_WINDOW: 1, CONGRUENCE: 2 } as const;
  blockers.sort((a, b) => {
    const ca = Number.isFinite(a.dormGap);
    const cb = Number.isFinite(b.dormGap);
    if (ca !== cb) return ca ? -1 : 1;
    return (
      causeRank[a.cause] - causeRank[b.cause] ||
      a.dStar - b.dStar ||
      compareId(packets[a.j].id, packets[b.j].id)
    );
  });

  if (blockers.length > 0) {
    const b = blockers[0];
    const pj = packets[b.j];
    const prevId = String(packets[last].id);
    const finite = (x: number): number => (Number.isFinite(x) ? x : -1);
    const d = b.dStar;
    // The pause is "crossing" this edge exactly when the edge is only
    // feasible as the pause-carrying edge (some positive s exists), even
    // though the requested closed range contains no such s.
    const crossingHere =
      !!dormancy && !pauseUsed && Number.isFinite(b.dormGap) && !!b.dormNeeded;
    const effectiveStatus: DormancyStatus | undefined = !dormancy
      ? undefined
      : pauseUsed
        ? 'USED'
        : crossingHere
          ? 'CROSSING'
          : 'NOT_USED';
    const usedEdgeInfo =
      effectiveStatus === 'USED'
        ? {
            index: dormEdge,
            fromId: packets[placed[dormEdge]].id,
            toId: packets[placed[dormEdge + 1]].id,
          }
        : undefined;
    const needed = b.dormNeeded;
    const rangeNote = dormancy
      ? pauseUsed
        ? ` the single dormancy pause (requested [${dormancy.lower}, ${dormancy.upper}]) was already ` +
          `spent on adjacency ${dormEdge + 1} (${String(packets[placed[dormEdge]].id)} -> ` +
          `${String(packets[placed[dormEdge + 1]].id)}) and cannot relax this edge`
        : crossingHere && needed
          ? ` this edge cannot be crossed by ordinary sampling: counter gap ${b.dormGap} only works if ` +
            `it carries the unique pause with a duration in [${needed.min}, ${needed.max}], but the ` +
            `requested dormancy range [${dormancy.lower}, ${dormancy.upper}] does not intersect it`
          : ` the dormancy pause [${dormancy.lower}, ${dormancy.upper}] is still unused, but placing ` +
            `it on this edge admits no positive-duration interpretation either`
      : '';
    const dormancyTimeGap =
      dormancy && !pauseUsed && crossingHere && needed
        ? {
            withoutPause: {
              min: Number.isFinite(d) ? d * minInterval : 0,
              max: Number.isFinite(d) ? d * maxInterval : 0,
            },
            withPause: {
              min: b.dormGap * minInterval + needed.min,
              max: b.dormGap * maxInterval + needed.max,
            },
          }
        : undefined;

    if (b.cause === 'TIME_GAP') {
      const firstPositive = b.delta === 0 ? modulus : b.delta;
      const dTiming =
        b.timeRange.min <= b.timeRange.max
          ? congruentGaps(Math.max(firstPositive, b.timeRange.min), b.timeRange.max, b.delta)[0] ?? Infinity
          : Infinity;
      const dCountVal = b.dStar;
      return make({
        stage: 'extension',
        partialLength: depth,
        partialOrder,
        candidateId: pj.id,
        reason:
          `cannot append packet ${String(pj.id)} after packet ${prevId}: the time-difference ` +
          `constraint needs a counter gap in [${b.timeRange.min}, ${b.timeRange.max}] but the ` +
          `absolute-count window only permits [${b.countRange.min}, ${b.countRange.max}] ` +
          `(smallest congruent gap satisfying the count window: ${finite(dCountVal)}; satisfying ` +
          `the time range: ${finite(dTiming)}). The tightened closed intervals only admit time ` +
          `differences in [${b.achievable.min}, ${b.achievable.max}], so no single gap satisfies ` +
          `both constraints.${rangeNote}`,
        dormancyStatus: effectiveStatus,
        dormancyEdge: usedEdgeInfo,
        detail: {
          cause: 'TIME_GAP',
          minimalCongruentGap: Number.isFinite(dCountVal) ? dCountVal : undefined,
          countGap: Number.isFinite(dCountVal) ? dCountVal : undefined,
          requiredTimeGap: Number.isFinite(dTiming)
            ? { min: dTiming * minInterval, max: dTiming * maxInterval }
            : undefined,
          actualTimeGapRange: b.achievable,
          countGapWindow: { min: b.countRange.min, max: b.countRange.max },
          dormancyRange: dormancy,
          dormancyTimeGap,
        },
      });
    }

    if (b.cause === 'COUNT_WINDOW') {
      return make({
        stage: 'extension',
        partialLength: depth,
        partialOrder,
        candidateId: pj.id,
        reason:
          `cannot append packet ${String(pj.id)} after packet ${prevId}: the absolute-count ` +
          `window only admits a counter gap in [${b.countRange.min}, ${b.countRange.max}], but the ` +
          `time-difference constraint needs a gap in [${b.timeRange.min}, ${b.timeRange.max}]; the ` +
          `two ranges have no congruent value in common.${rangeNote}`,
        dormancyStatus: effectiveStatus,
        dormancyEdge: usedEdgeInfo,
        detail: {
          cause: 'COUNT_WINDOW',
          minimalCongruentGap: Number.isFinite(d) ? d : undefined,
          countGapWindow: { min: b.countRange.min, max: b.countRange.max },
          requiredTimeGap: Number.isFinite(d)
            ? { min: d * minInterval, max: d * maxInterval }
            : undefined,
          actualTimeGapRange: b.achievable,
          dormancyRange: dormancy,
          dormancyTimeGap,
        },
      });
    }

    return make({
      stage: 'extension',
      partialLength: depth,
      partialOrder,
      candidateId: pj.id,
      reason:
        `cannot append packet ${String(pj.id)} after packet ${prevId}: the time-feasible gap range ` +
        `[${b.timeRange.min}, ${b.timeRange.max}] and count-feasible gap range ` +
        `[${b.countRange.min}, ${b.countRange.max}] overlap but contain no positive counter gap ` +
        `congruent to ${b.delta} modulo ${modulus}.${rangeNote}`,
      dormancyStatus: effectiveStatus,
      dormancyEdge: usedEdgeInfo,
      detail: {
        cause: 'CONGRUENCE',
        minimalCongruentGap: Number.isFinite(d) ? d : undefined,
        countGapWindow: { min: b.countRange.min, max: b.countRange.max },
        actualTimeGapRange: b.achievable,
        dormancyRange: dormancy,
        dormancyTimeGap,
      },
    });
  }

  const candidate = packets[last];
  return make({
    stage: 'extension',
    partialLength: depth,
    partialOrder,
    candidateId: candidate.id,
    reason: `cannot extend from packet ${String(candidate.id)}: no unused packet remains`,
    dormancyStatus: dormancy ? (pauseUsed ? 'USED' : 'NOT_USED') : undefined,
  });
}
