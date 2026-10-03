import type {
  AdjacencyEvidence,
  AssignedPacket,
  MissingSegment,
  PacketInput,
  ConstraintFailureEvidence,
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
  dLo: number;
  dHi: number;
}

interface DeadState {
  depth: number;
  placed: number[];
  last: number;
  S: number;
  c0lo: number;
  c0hi: number;
  tLo: number;
  tHi: number;
  /** Adjacency index carrying the dormancy pause, -1 while unplaced. */
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
 * Tighten timestamp windows for a fixed complete order and per-edge feasible
 * time-difference bounds [edgeLo, edgeHi]. Forward pass intersects
 * [t_prev + L, t_prev + U]; backward pass intersects [t_next - U, t_next - L].
 * Nonempty forward windows already imply global feasibility of the
 * difference-constraint chain; the backward pass only shrinks domains for the
 * deviation optimizer. Null = defensively infeasible.
 */
function tightenWindows(
  packets: Packet[],
  order: number[],
  edgeLo: number[],
  edgeHi: number[],
): { lo: number; hi: number }[] | null {
  const n = order.length;
  const win = new Array<{ lo: number; hi: number }>(n);
  win[0] = { lo: packets[order[0]].lo, hi: packets[order[0]].hi };
  for (let k = 1; k < n; k++) {
    const p = packets[order[k]];
    const lo = Math.max(p.lo, win[k - 1].lo + edgeLo[k - 1]);
    const hi = Math.min(p.hi, win[k - 1].hi + edgeHi[k - 1]);
    if (lo > hi) return null;
    win[k] = { lo, hi };
  }
  for (let k = n - 2; k >= 0; k--) {
    const lo = Math.max(win[k].lo, win[k + 1].lo - edgeHi[k]);
    const hi = Math.min(win[k].hi, win[k + 1].hi - edgeLo[k]);
    if (lo > hi) return null;
    win[k] = { lo, hi };
  }
  return win;
}

/** Feasible time-difference bounds implied by counter gaps alone. */
function gapEdgeBounds(
  gaps: number[],
  minInterval: number,
  maxInterval: number,
): { lo: number[]; hi: number[] } {
  return {
    lo: gaps.map((d) => d * minInterval),
    hi: gaps.map((d) => d * maxInterval),
  };
}

/**
 * Candidate timestamp values spanning an optimum of the path L1 problem.
 * At an integral optimum every variable is pinned — directly or through a
 * chain of tight lower/upper edge constraints — to a pivot: an interval bound
 * or one of the two integers adjacent to its midpoint. Propagating every
 * pivot along every lower/upper pin chain gives O(n · 2^n) candidate values
 * per position (n ≤ 14).
 */
function timeCandidates(
  packets: Packet[],
  order: number[],
  windows: { lo: number; hi: number }[],
  edgeLo: number[],
  edgeHi: number[],
): number[][] {
  const n = order.length;
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
        visit(pos + 1, v + edgeLo[pos]);
        visit(pos + 1, v + edgeHi[pos]);
      }
    };
    for (const s of pivotsOf(j)) {
      visit(j + 1, s + edgeLo[j]);
      visit(j + 1, s + edgeHi[j]);
    }
  }
  // Backward tight-edge chains.
  for (let j = 1; j < n; j++) {
    const visit = (pos: number, v: number): void => {
      add(pos, v);
      if (pos > 0) {
        visit(pos - 1, v - edgeLo[pos - 1]);
        visit(pos - 1, v - edgeHi[pos - 1]);
      }
    };
    for (const s of pivotsOf(j)) {
      visit(j - 1, s - edgeLo[j - 1]);
      visit(j - 1, s - edgeHi[j - 1]);
    }
  }

  return candSets.map((set) => [...set].sort((a, b) => a - b));
}

/**
 * Minimize Σ |2 t_k - mid2_k| over integer timestamps subject to
 * t_k ∈ window_k and L_e ≤ t_{e+1} - t_e ≤ U_e, for a FIXED order.
 *
 * Exported for direct differential testing against a full-domain DP.
 *
 * Difference-constraint L1 program on a path. The candidate set spans an
 * optimum (see timeCandidates). A backward shortest-path DP with monotone
 * sliding-window minima computes the optimum; the forward greedy
 * reconstruction returns the lexicographically smallest optimal timestamp
 * vector.
 *
 * `edgeBounds`, when given, overrides the per-edge difference bounds
 * [L_e, U_e] (used for the dormancy-shifted adjacency); otherwise they are
 * derived from the counter gaps as [d·minInterval, d·maxInterval].
 */
export function optimalTimes(
  packets: Packet[],
  order: number[],
  windows: { lo: number; hi: number }[],
  gaps: number[],
  minInterval: number,
  maxInterval: number,
  edgeBounds?: { lo: number[]; hi: number[] },
): { times: number[]; deviation2: number } {
  const n = order.length;
  const L = edgeBounds?.lo ?? gaps.map((d) => d * minInterval);
  const U = edgeBounds?.hi ?? gaps.map((d) => d * maxInterval);

  const candidates = timeCandidates(packets, order, windows, L, U);
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

/**
 * Lexicographic counterpart of optimalTimes over the same candidate sets:
 * minimize first the total midpoint deviation, then — among deviation-optimal
 * timestamp vectors — the realized time difference across edge `edgeIndex`.
 *
 * The lexicographic pair (deviation, edge gap) equals the minimum of the
 * weighted objective deviation·K + gap for any K exceeding the feasible gap
 * range, so its optimum is spanned by the same tight-chain candidates. The
 * sliding-window DP compares (deviation, gap) pairs lexicographically; only
 * the row crossing `edgeIndex` accumulates a gap contribution (u − t folded
 * into the next position's cost before the window minimum, then t back out).
 */
function minDeviationAndEdgeGap(
  packets: Packet[],
  order: number[],
  windows: { lo: number; hi: number }[],
  edgeLo: number[],
  edgeHi: number[],
  edgeIndex: number,
): { deviation2: number; edgeGap: number } {
  const n = order.length;
  const candidates = timeCandidates(packets, order, windows, edgeLo, edgeHi);
  const dev = (k: number, t: number): number => Math.abs(2 * t - packets[order[k]].mid2);

  interface Cost {
    dev: number;
    gap: number;
  }
  const lexLess = (a: Cost, b: Cost): boolean => a.dev < b.dev || (a.dev === b.dev && a.gap < b.gap);

  // suffix[k][c] = lexicographically minimal cost on positions k..n-1 with
  // t_k = cand[k][c]; the gap component is zero until edgeIndex is crossed.
  const suffix: Cost[][] = new Array(n);
  suffix[n - 1] = candidates[n - 1].map((t) => ({ dev: dev(n - 1, t), gap: 0 }));
  for (let k = n - 2; k >= 0; k--) {
    const crossing = k === edgeIndex;
    const nextCands = candidates[k + 1];
    // When crossing the watched edge, fold the realized difference u into the
    // successor cost so the window minimum orders by (deviation, gap + u).
    const prev: Cost[] = crossing
      ? suffix[k + 1].map((c, i) => ({ dev: c.dev, gap: c.gap + nextCands[i] }))
      : suffix[k + 1];
    const cur: Cost[] = new Array(candidates[k].length);
    const deque: number[] = [];
    let head = 0;
    let pushed = -1;
    for (let c = 0; c < candidates[k].length; c++) {
      const t = candidates[k][c];
      const low = t + edgeLo[k];
      const high = t + edgeHi[k];
      while (head < deque.length && nextCands[deque[head]] < low) head++;
      while (pushed + 1 < nextCands.length && nextCands[pushed + 1] <= high) {
        pushed++;
        while (deque.length > head && !lexLess(prev[deque[deque.length - 1]], prev[pushed])) deque.pop();
        deque.push(pushed);
      }
      const best: Cost = head < deque.length ? prev[deque[head]] : { dev: Infinity, gap: Infinity };
      cur[c] = {
        dev: best.dev + dev(k, t),
        gap: best.gap - (crossing ? t : 0),
      };
    }
    suffix[k] = cur;
  }

  let best = suffix[0][0];
  for (const c of suffix[0]) {
    if (lexLess(c, best)) best = c;
  }
  return { deviation2: best.dev, edgeGap: best.gap };
}

interface Move {
  j: number;
  d: number;
  c0lo: number;
  c0hi: number;
  tLo: number;
  tHi: number;
  /** Whether this adjacency carries the dormancy pause. */
  dorm: boolean;
}

/**
 * Jointly recover transmission order, wrap-crossing absolute counters and
 * transmit timestamps.
 *
 * Optimization is lexicographic:
 *   1. missing packet count between first/last observed packet
 *   2. total deviation of chosen times from interval midpoints
 *   3. the recovered packet-id sequence (lexicographic)
 *
 * Implemented as three exhaustive branch-and-bound phases over the same
 * state space:
 *   A — minimum total counter gap (primary value),
 *   B — minimum midpoint deviation subject to primary = optimum,
 *   C — lexicographically smallest id sequence subject to both (greedy
 *       position fixing with a memoized feasibility oracle).
 * Packets sharing (remainder, time interval) are exact symmetry twins: they
 * may only be consumed in ascending id order, which never removes the
 * lex-min solution but collapses permutation families.
 *
 * Throws SolveError(NO_CONSISTENT_INTERPRETATION) with first-failure evidence.
 *
 * When `dormancy` is given, the batch is known to contain exactly one
 * low-battery sampling pause whose integer duration lies inside
 * [dormancy.lower, dormancy.upper]. The solver jointly chooses the single
 * adjacency carrying the pause (its feasible time-difference range shifts up
 * by the pause duration) and the duration itself. The three lexicographic
 * objectives are unchanged; remaining ties are broken by the shorter pause
 * and then by the earlier pause boundary.
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
  const dorm = dormancy ?? null;
  const dormLo = dorm?.lower ?? 0;
  const dormHi = dorm?.upper ?? 0;

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

  // Intrinsic adjacency feasibility = congruent-gap RANGE per ordered pair.
  // Time: L_d ≤ t_j - t_i ≤ U_d with t_i∈I_i, t_j∈I_j:
  //   d ≥ ceil((lo_j - hi_i)/maxInterval), d ≤ floor((hi_j - lo_i)/minInterval).
  // Counts: c_i, c_j = c_i + d both inside the search window:
  //   base_j - top_i ≤ d ≤ top_j - base_i.
  // A dormancy-carrying adjacency shifts the observed time difference up by
  // the pause duration, so its feasible range uses time bounds reduced by
  // [dormLo, dormHi].
  const buildPair = (shiftLo: number, shiftHi: number): PairFeas[][] =>
    packets.map((pi) =>
      packets.map((pj): PairFeas => {
        const delta = modNonNeg(pj.remainder - pi.remainder, modulus);
        const d0 = pi.index === pj.index ? Infinity : delta === 0 ? modulus : delta;
        const dLo = Math.max(
          d0,
          Math.ceil((pj.lo - pi.hi - shiftHi) / maxInterval),
          pj.baseCount - pi.topCount,
        );
        const dHi = Math.min(
          W,
          Math.floor((pj.hi - pi.lo - shiftLo) / minInterval),
          pj.topCount - pi.baseCount,
        );
        return { delta, dLo, dHi };
      }),
    );

  const pair = buildPair(0, 0);
  const pairDorm = dorm ? buildPair(dormLo, dormHi) : pair;

  const buildMinGap = (pf: PairFeas[][]): number[][] =>
    packets.map((pi) =>
      packets.map((pj) => {
        if (pi.index === pj.index) return Infinity;
        const p = pf[pi.index][pj.index];
        return p.dLo <= p.dHi ? p.dLo : Infinity;
      }),
    );

  const minGap = buildMinGap(pair);
  const minGapDorm = dorm ? buildMinGap(pairDorm) : minGap;

  // cont[mask][j] = minimum gap sum of a path starting at j visiting all
  // nodes of `mask` (j ∉ mask). Exact admissible completion bound, O(2^n n²).
  // contRelax additionally allows the single dormancy shift on at most one of
  // the remaining adjacencies — a valid lower bound for dormancy-enabled
  // requests whose pause has not been placed yet.
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

  const contRelax: number[][] = dorm
    ? Array.from({ length: 1 << n }, () => new Array<number>(n).fill(Infinity))
    : cont;
  if (dorm) {
    for (let j = 0; j < n; j++) contRelax[0][j] = 0;
    for (let mask = 1; mask <= full; mask++) {
      for (let j = 0; j < n; j++) {
        if (mask & (1 << j)) continue;
        let best = Infinity;
        for (let x = 0; x < n; x++) {
          if (!(mask & (1 << x))) continue;
          const plain = minGap[j][x] + contRelax[mask ^ (1 << x)][x];
          if (plain < best) best = plain;
          const shifted = minGapDorm[j][x] + cont[mask ^ (1 << x)][x];
          if (shifted < best) best = shifted;
        }
        contRelax[mask][j] = best;
      }
    }
  }

  /** Completion lower bound for a state whose dormancy use is `dormUsed`. */
  const contFor = (mask: number, j: number, dormUsed: boolean): number =>
    dormUsed ? cont[mask][j] : contRelax[mask][j];

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
        ...(dorm !== null ? { dormancyStatus: 'unused' as const } : {}),
      },
    );
  }
  const globalPrimaryLB = Math.min(
    ...seedOrder.map((p) => contFor(full ^ (1 << p.index), p.index, false)),
  );

  // Per-position arrays shared by the recursive searches.
  const orderArr = new Array<number>(n);
  const tLoArr = new Array<number>(n);
  const tHiArr = new Array<number>(n);
  const gapsArr = new Array<number>(n - 1);
  const used = new Uint8Array(n);
  let bestDead: DeadState | null = null;

  const usedMask = (): number => {
    let bits = 0;
    for (let i = 0; i < n; i++) if (used[i]) bits |= 1 << i;
    return bits;
  };

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
   * Move-generation mode for the dormancy model:
   *  -1: the pause may be placed on at most one adjacency (global phases);
   *  k >= 0: the pause is forced onto adjacency k exactly (per-boundary
   *  reconstruction of the lex/duration tie-breaks).
   */
  let activeForcedEdge = -1;

  /** Successors in canonical order: every congruent feasible gap per target,
   * sorted by smallest gap then smallest target id. When the dormancy pause
   * is still unplaced, each target additionally offers pause-carrying moves
   * whose time bounds are shifted up by the pause duration. */
  const enumerateMoves = (
    depth: number,
    last: number,
    S: number,
    c0lo: number,
    c0hi: number,
    tLo: number,
    tHi: number,
    mask: number,
    dormUsed: boolean,
  ): Move[] => {
    const slotsAfter = n - 1 - depth;
    const moves: Move[] = [];
    for (let j = 0; j < n; j++) {
      if (mask & (1 << j)) continue;
      if (!isSymmetryAllowed(j, mask)) continue;
      const pj = packets[j];

      // Move variants: the regular adjacency and — while the pause is
      // unplaced — the adjacency carrying the dormancy pause.
      for (const withDorm of [false, true]) {
        if (withDorm && dorm === null) continue;
        if (activeForcedEdge >= 0) {
          // Forced boundary: this adjacency's pause flag is predetermined.
          if (withDorm !== (depth === activeForcedEdge + 1)) continue;
        } else if (withDorm && dormUsed) {
          continue;
        }
        const pf = withDorm ? pairDorm[last][j] : pair[last][j];
        const shiftLo = withDorm ? dormLo : 0;
        const shiftHi = withDorm ? dormHi : 0;
        const dLo = Math.max(
          pf.dLo,
          pj.baseCount - S - c0hi,
          Math.ceil((pj.lo - tHi - shiftHi) / maxInterval),
        );
        const dHi0 = Math.min(
          pf.dHi,
          pj.topCount - S - c0lo,
          countUpper - slotsAfter - S - c0lo,
          Math.floor((pj.hi - tLo - shiftLo) / minInterval),
        );
        if (dLo > dHi0) continue;
        const dMin = ceilResidue(dLo, pf.delta, modulus);
        if (dMin > dHi0) continue;

        const consider = (d: number): Move | null => {
          const njLo = Math.max(c0lo, pj.baseCount - S - d);
          const njHi = Math.min(c0hi, pj.topCount - S - d, countUpper - slotsAfter - S - d);
          const ntLo = Math.max(pj.lo, tLo + d * minInterval + shiftLo);
          const ntHi = Math.min(pj.hi, tHi + d * maxInterval + shiftHi);
          if (njLo > njHi || ntLo > ntHi) return null;
          return { j, d, c0lo: njLo, c0hi: njHi, tLo: ntLo, tHi: ntHi, dorm: withDorm };
        };

        for (let d = dMin; d <= dHi0; d += modulus) {
          // The rising time lower bound is monotone in d; once it passes j's
          // interval no larger gap can work.
          if (d * minInterval + shiftLo > pj.hi - tLo) break;
          const mv = consider(d);
          if (mv) moves.push(mv);
        }
      }
    }
    moves.sort((a, b) => a.d - b.d || compareId(packets[a.j].id, packets[b.j].id) || Number(a.dorm) - Number(b.dorm));
    return moves;
  };

  const recordDead = (
    depth: number,
    last: number,
    S: number,
    c0lo: number,
    c0hi: number,
    tLo: number,
    tHi: number,
    dormEdge: number,
  ): void => {
    if (bestDead === null || depth > bestDead.depth) {
      bestDead = { depth, placed: orderArr.slice(0, depth), last, S, c0lo, c0hi, tLo, tHi, dormEdge };
    }
  };

  // ------------------------------------------------------------------ Phase A
  // Minimum total counter gap. A state memo caches the best completion gap
  // sum (Infinity = dead); state = (used set, last packet, fixed prefix gap
  // sum, tightened c0 and last-timestamp windows, dormancy-used bit). The
  // pause position itself is irrelevant to the gap-sum objective: once the
  // tightened windows absorb its effect, only whether it is still available
  // influences future moves.
  const memoA = new Map<string, number>();
  let bestA = Infinity;
  let stopA = false;

  const dfsA = (
    depth: number,
    last: number,
    S: number,
    c0lo: number,
    c0hi: number,
    tLo: number,
    tHi: number,
    dormEdge: number,
  ): number => {
    if (stopA) return Infinity;
    if (depth === n) {
      // The dormancy model requires exactly one pause: a pause-free chain is
      // not a valid completion.
      if (dorm !== null && dormEdge < 0) return Infinity;
      if (S < bestA) bestA = S;
      if (bestA === globalPrimaryLB) stopA = true;
      return S;
    }
    const dormUsed = dormEdge >= 0;
    const mask = usedMask();
    const remaining = full ^ mask;
    // Bound prune only once a feasible solution exists: before that, an
    // infinite intrinsic completion must still be explored to record the
    // deepest non-extendable state for failure evidence.
    if (Number.isFinite(bestA) && S + contFor(remaining, last, dormUsed) >= bestA) return Infinity;

    const key = `A|${mask}|${last}|${S}|${c0lo}|${c0hi}|${tLo}|${tHi}|${dormUsed ? 1 : 0}`;
    const cached = memoA.get(key);
    if (cached !== undefined) return cached;

    const moves = enumerateMoves(depth, last, S, c0lo, c0hi, tLo, tHi, mask, dormUsed);
    if (moves.length === 0) {
      recordDead(depth, last, S, c0lo, c0hi, tLo, tHi, dormEdge);
      memoA.set(key, Infinity);
      return Infinity;
    }

    let best = Infinity;
    for (const mv of moves) {
      const nextDormUsed = dormUsed || mv.dorm;
      if (Number.isFinite(bestA) && S + mv.d + contFor(remaining ^ (1 << mv.j), mv.j, nextDormUsed) >= bestA) continue;
      used[mv.j] = 1;
      orderArr[depth] = mv.j;
      gapsArr[depth - 1] = mv.d;
      tLoArr[depth] = mv.tLo;
      tHiArr[depth] = mv.tHi;
      const v = dfsA(depth + 1, mv.j, S + mv.d, mv.c0lo, mv.c0hi, mv.tLo, mv.tHi, mv.dorm ? depth - 1 : dormEdge);
      used[mv.j] = 0;
      if (v < best) best = v;
      if (stopA) break;
    }
    if (best === Infinity) {
      recordDead(depth, last, S, c0lo, c0hi, tLo, tHi, dormEdge);
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
    tLoArr[0] = seed.lo;
    tHiArr[0] = seed.hi;
    dfsA(1, seed.index, 0, seed.baseCount, c0hi0, seed.lo, seed.hi, -1);
  }
  if (bestA === Infinity) {
    throw buildFailureEvidence(packets, pair, pairDorm, bestDead, modulus, countUpper, minInterval, maxInterval, dorm);
  }
  const Pstar = bestA;

  // ------------------------------------------------------------- Phase B/C key
  // Deviation-relevant state also records the per-position tightened windows
  // AND interval identities (midpoint sequence), since converging paths with
  // different packet types at prefix positions are not interchangeable.
  /** Exact state signature for the deviation/lex phases: full prefix packet
   * sequence, its gaps and every position's tightened window. Paths sharing
   * this signature have identical prefix deviation and an identical frontier,
   * so memoized results are interchangeable. */
  const stateKeyBC = (depth: number, last: number, S: number, c0lo: number, c0hi: number, tLo: number, tHi: number, dormEdge: number): string => {
    let s = `${depth}|${last}|${S}|${c0lo}|${c0hi}|${tLo}|${tHi}|${dormEdge}`;
    for (let k = 0; k < depth; k++) {
      s += `>${orderArr[k]}:${k > 0 ? gapsArr[k - 1] : 0}:${tLoArr[k]},${tHiArr[k]}`;
    }
    return s;
  };

  /**
   * Exact primary-optimal-chain oracle. Returns true exactly when a
   * completion of the CURRENT state reaches total gap Pstar. Unlike the
   * intrinsic Held-Karp bound, this accounts for time/count feasibility, so
   * it is the correct filter for the deviation and lexicographic phases.
   *
   * The state is Markovian in (used mask, last packet, fixed gap sum S,
   * tightened c0 window and last timestamp window): difference constraints on
   * an ordered chain mean earlier prefix positions influence the future only
   * through the last packet's tightened window.
   */
  let memoOpt = new Map<string, boolean>();
  const optimalFromState = (
    depth: number,
    last: number,
    S: number,
    c0lo: number,
    c0hi: number,
    tLo: number,
    tHi: number,
    mask: number,
    dormUsed: boolean,
  ): boolean => {
    if (depth === n) return S === Pstar && (dorm === null || dormUsed);
    const key = `O|${mask}|${last}|${S}|${c0lo}|${c0hi}|${tLo}|${tHi}|${dormUsed ? 1 : 0}`;
    const cached = memoOpt.get(key);
    if (cached !== undefined) return cached;

    const remaining = full ^ mask;
    const moves = enumerateMoves(depth, last, S, c0lo, c0hi, tLo, tHi, mask, dormUsed);
    let ok = false;
    for (const mv of moves) {
      const nextDormUsed = dormUsed || mv.dorm;
      // Necessary bound for reaching Pstar; exact feasibility checked below.
      if (S + mv.d + contFor(remaining ^ (1 << mv.j), mv.j, nextDormUsed) > Pstar) continue;
      used[mv.j] = 1;
      const v = optimalFromState(
        depth + 1,
        mv.j,
        S + mv.d,
        mv.c0lo,
        mv.c0hi,
        mv.tLo,
        mv.tHi,
        mask | (1 << mv.j),
        nextDormUsed,
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
    tLo: number,
    tHi: number,
    mask: number,
    dormUsed: boolean,
  ): Move[] => {
    const remaining = full ^ mask;
    const all = enumerateMoves(depth, last, S, c0lo, c0hi, tLo, tHi, mask, dormUsed);
    return all.filter((mv) => {
      const nextDormUsed = dormUsed || mv.dorm;
      if (S + mv.d + contFor(remaining ^ (1 << mv.j), mv.j, nextDormUsed) > Pstar) return false;
      return optimalFromState(
        depth + 1,
        mv.j,
        S + mv.d,
        mv.c0lo,
        mv.c0hi,
        mv.tLo,
        mv.tHi,
        mask | (1 << mv.j),
        nextDormUsed,
      );
    });
  };

  /** Whether a seed packet can begin any primary-optimal completion. */
  const seedIsOptimal = (seedIndex: number): boolean => {
    const seed = packets[seedIndex];
    const c0hi0 = Math.min(seed.topCount, countUpper - n + 1);
    if (seed.baseCount > c0hi0) return false;
    return optimalFromState(1, seedIndex, 0, seed.baseCount, c0hi0, seed.lo, seed.hi, 1 << seedIndex, false);
  };

  /** Minimum midpoint deviation over the leaf's chain; the dormancy-carrying
   * adjacency (if any) uses its pause-shifted difference bounds. */
  const leafDeviation = (dormEdge: number): number => {
    const order = orderArr.slice();
    const gaps = gapsArr.slice();
    const bounds = gapEdgeBounds(gaps, minInterval, maxInterval);
    if (dormEdge >= 0) {
      bounds.lo[dormEdge] += dormLo;
      bounds.hi[dormEdge] += dormHi;
    }
    const windows = tightenWindows(packets, order, bounds.lo, bounds.hi);
    if (windows === null) return Infinity;
    return optimalTimes(packets, order, windows, gaps, minInterval, maxInterval, bounds).deviation2;
  };

  // ------------------------------------------------------------------ Phase B
  // Minimum total deviation2 over primary-optimal chains.
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
    tLo: number,
    tHi: number,
    dormEdge: number,
  ): number => {
    if (depth === n) {
      if (dorm !== null && dormEdge < 0) return Infinity;
      const v = leafDeviation(dormEdge);
      if (v < bestB) bestB = v;
      return v;
    }
    const mask = usedMask();

    let placedLB = 0;
    for (let k = 0; k < depth; k++) {
      placedLB += minDeviation2(tLoArr[k], tHiArr[k], packets[orderArr[k]].mid2);
    }
    if (placedLB + independentDevLB(mask) >= bestB) return Infinity;

    const key = stateKeyBC(depth, last, S, c0lo, c0hi, tLo, tHi, dormEdge);
    const cached = memoB.get(key);
    if (cached !== undefined) return cached;

    const moves = optimalMoves(depth, last, S, c0lo, c0hi, tLo, tHi, mask, dormEdge >= 0);
    let best = Infinity;
    for (const mv of moves) {
      used[mv.j] = 1;
      orderArr[depth] = mv.j;
      gapsArr[depth - 1] = mv.d;
      tLoArr[depth] = mv.tLo;
      tHiArr[depth] = mv.tHi;
      const v = dfsB(depth + 1, mv.j, S + mv.d, mv.c0lo, mv.c0hi, mv.tLo, mv.tHi, mv.dorm ? depth - 1 : dormEdge);
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
    used[seed.index] = 1;
    orderArr[0] = seed.index;
    tLoArr[0] = seed.lo;
    tHiArr[0] = seed.hi;
    dfsB(1, seed.index, 0, seed.baseCount, c0hi0, seed.lo, seed.hi, -1);
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
  let memoC = new Map<string, boolean>();

  const dfsCfeasible = (
    depth: number,
    last: number,
    S: number,
    c0lo: number,
    c0hi: number,
    tLo: number,
    tHi: number,
    dormEdge: number,
  ): boolean => {
    if (depth === n) {
      if (dorm !== null && dormEdge < 0) return false;
      return leafDeviation(dormEdge) === Dstar;
    }
    const mask = usedMask();
    const key = stateKeyBC(depth, last, S, c0lo, c0hi, tLo, tHi, dormEdge);
    const cached = memoC.get(key);
    if (cached !== undefined) return cached;

    const moves = optimalMoves(depth, last, S, c0lo, c0hi, tLo, tHi, mask, dormEdge >= 0);
    let ok = false;
    for (const mv of moves) {
      used[mv.j] = 1;
      orderArr[depth] = mv.j;
      gapsArr[depth - 1] = mv.d;
      tLoArr[depth] = mv.tLo;
      tHiArr[depth] = mv.tHi;
      ok = dfsCfeasible(depth + 1, mv.j, S + mv.d, mv.c0lo, mv.c0hi, mv.tLo, mv.tHi, mv.dorm ? depth - 1 : dormEdge);
      used[mv.j] =0;
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
  let curTLo = 0;
  let curTHi = 0;
  let curMask = 0;
  let curDormEdge = -1;

  /** Reproduce the forward-tightened windows of the fixed prefix so the
   * oracle's memoization keys and leaf tightening see a consistent state. */
  const replayPrefixWindows = (): void => {
    for (let k = 0; k < chosen.length; k++) {
      const p = packets[chosen[k]];
      if (k === 0) {
        tLoArr[0] = p.lo;
        tHiArr[0] = p.hi;
      } else {
        const d = fixedGaps[k - 1];
        const shiftLo = k - 1 === curDormEdge ? dormLo : 0;
        const shiftHi = k - 1 === curDormEdge ? dormHi : 0;
        tLoArr[k] = Math.max(p.lo, tLoArr[k - 1] + d * minInterval + shiftLo);
        tHiArr[k] = Math.min(p.hi, tHiArr[k - 1] + d * maxInterval + shiftHi);
      }
      orderArr[k] = chosen[k];
      if (k > 0) gapsArr[k - 1] = fixedGaps[k - 1];
    }
  };

  /**
   * Lex-min order reconstruction under the current move-generation mode
   * (activeForcedEdge). Commits packet identities position by position; the
   * chosen gaps/dormancy flags ride along in fixedGaps/curDormEdge. Returns
   * false when no (Pstar, Dstar) completion exists under the mode.
   */
  const greedyLexOrder = (): boolean => {
    chosen.length = 0;
    fixedGaps.length = 0;
    curLast = -1;
    curS = 0;
    curC0lo = 0;
    curC0hi = 0;
    curTLo = 0;
    curTHi = 0;
    curMask = 0;
    curDormEdge = -1;
    memoC = new Map();

    for (let depth = 0; depth < n; depth++) {
      let candidates: { j: number; mv: Move | null }[];
      if (depth === 0) {
        candidates = seedOrder
          .filter((p) => seedIsOptimal(p.index))
          .map((p) => ({ j: p.index, mv: null }));
      } else {
        candidates = optimalMoves(depth, curLast, curS, curC0lo, curC0hi, curTLo, curTHi, curMask, curDormEdge >= 0).map(
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
          ok = dfsCfeasible(1, j, 0, seed.baseCount, c0hi0, seed.lo, seed.hi, -1);
        } else {
          const mv = cand.mv!;
          gapsArr[depth - 1] = mv.d;
          tLoArr[depth] = mv.tLo;
          tHiArr[depth] = mv.tHi;
          ok = dfsCfeasible(
            depth + 1,
            j,
            curS + mv.d,
            mv.c0lo,
            mv.c0hi,
            mv.tLo,
            mv.tHi,
            mv.dorm ? depth - 1 : curDormEdge,
          );
        }
        used[j] = 0;
        if (ok) {
          picked = cand;
          break;
        }
      }

      if (!picked) return false;

      chosen.push(picked.j);
      if (depth === 0) {
        const seed = packets[picked.j];
        curC0lo = seed.baseCount;
        curC0hi = Math.min(seed.topCount, countUpper - n + 1);
        curTLo = seed.lo;
        curTHi = seed.hi;
      } else {
        const mv = picked.mv!;
        fixedGaps.push(mv.d);
        curS += mv.d;
        curC0lo = mv.c0lo;
        curC0hi = mv.c0hi;
        curTLo = mv.tLo;
        curTHi = mv.tHi;
        if (mv.dorm) curDormEdge = depth - 1;
      }
      curLast = picked.j;
      curMask |= 1 << picked.j;
    }
    return true;
  };

  /**
   * Phase D for a fixed recovered order and a fixed pause boundary: choose
   * the counter gaps and the pause duration minimizing the duration (the
   * residual tie-break) subject to (Pstar, Dstar). Gap ties beyond that keep
   * the canonical ascending enumeration order. Null when the order admits no
   * (Pstar, Dstar) completion with the pause on `boundary`.
   */
  const minDurationForOrderBoundary = (
    ord: number[],
    boundary: number,
  ): { duration: number; gaps: number[]; c0: number } | null => {
    const gapsD = new Array<number>(n - 1).fill(0);
    const wLo = new Array<number>(n);
    const wHi = new Array<number>(n);
    wLo[0] = packets[ord[0]].lo;
    wHi[0] = packets[ord[0]].hi;
    let bestS = Infinity;
    let bestGaps: number[] | null = null;
    let bestC0 = 0;
    let stopD = false;

    const dfsD = (e: number, c0lo: number, c0hi: number, S: number): void => {
      if (stopD) return;
      if (e === n - 1) {
        if (S !== Pstar) return;
        const bounds = gapEdgeBounds(gapsD, minInterval, maxInterval);
        bounds.lo[boundary] += dormLo;
        bounds.hi[boundary] += dormHi;
        const windows = tightenWindows(packets, ord, bounds.lo, bounds.hi);
        if (windows === null) return;
        const { deviation2, edgeGap } = minDeviationAndEdgeGap(
          packets,
          ord,
          windows,
          bounds.lo,
          bounds.hi,
          boundary,
        );
        if (deviation2 !== Dstar) return;
        // Shortest pause consistent with the tightest deviation-optimal
        // realized difference: s >= edgeGap - d·maxInterval and s >= dormLo.
        const s = Math.max(dormLo, edgeGap - gapsD[boundary] * maxInterval);
        if (s < bestS) {
          bestS = s;
          bestGaps = gapsD.slice();
          bestC0 = c0lo;
          if (bestS === dormLo) stopD = true;
        }
        return;
      }

      const i = ord[e];
      const j = ord[e + 1];
      const pj = packets[j];
      const slotsAfter = n - 2 - e;
      // Sum bounds over the still-open adjacencies e+1 .. n-2, used to prune
      // against the fixed primary optimum Pstar.
      let remMin = 0;
      let remMax = 0;
      for (let r = e + 1; r <= n - 2; r++) {
        const a = ord[r];
        const b = ord[r + 1];
        const dormR = r === boundary;
        remMin += dormR ? minGapDorm[a][b] : minGap[a][b];
        remMax += dormR ? pairDorm[a][b].dHi : pair[a][b].dHi;
      }

      const withDorm = e === boundary;
      const pf = withDorm ? pairDorm[i][j] : pair[i][j];
      const shiftLo = withDorm ? dormLo : 0;
      const shiftHi = withDorm ? dormHi : 0;
      const dLo = Math.max(
        pf.dLo,
        pj.baseCount - S - c0hi,
        Math.ceil((pj.lo - wHi[e] - shiftHi) / maxInterval),
      );
      const dHi0 = Math.min(
        pf.dHi,
        pj.topCount - S - c0lo,
        countUpper - slotsAfter - S - c0lo,
        Math.floor((pj.hi - wLo[e] - shiftLo) / minInterval),
      );
      if (dLo > dHi0) return;
      const dMin = ceilResidue(dLo, pf.delta, modulus);
      for (let d = dMin; d <= dHi0; d += modulus) {
        if (d * minInterval + shiftLo > pj.hi - wLo[e]) break;
        if (S + d + remMin > Pstar) break;
        if (S + d + remMax < Pstar) continue;
        const nc0lo = Math.max(c0lo, pj.baseCount - S - d);
        const nc0hi = Math.min(c0hi, pj.topCount - S - d, countUpper - slotsAfter - S - d);
        const ntLo = Math.max(pj.lo, wLo[e] + d * minInterval + shiftLo);
        const ntHi = Math.min(pj.hi, wHi[e] + d * maxInterval + shiftHi);
        if (nc0lo > nc0hi || ntLo > ntHi) continue;
        // Deviation lower bound over placed + remaining positions.
        let lb = 0;
        for (let k = 0; k <= e; k++) {
          lb += minDeviation2(wLo[k], wHi[k], packets[ord[k]].mid2);
        }
        lb += minDeviation2(ntLo, ntHi, pj.mid2);
        for (let k = e + 2; k < n; k++) {
          const pr = packets[ord[k]];
          lb += minDeviation2(pr.lo, pr.hi, pr.mid2);
        }
        if (lb > Dstar) continue;
        gapsD[e] = d;
        wLo[e + 1] = ntLo;
        wHi[e + 1] = ntHi;
        dfsD(e + 1, nc0lo, nc0hi, S + d);
        if (stopD) return;
      }
    };

    dfsD(0, packets[ord[0]].baseCount, Math.min(packets[ord[0]].topCount, countUpper - n + 1), 0);
    if (bestGaps === null) return null;
    return { duration: bestS, gaps: bestGaps, c0: bestC0 };
  };

  /** Lexicographic comparison of two recovered orders by packet id. */
  const lexOrderCompare = (a: number[], b: number[]): number => {
    for (let i = 0; i < a.length; i++) {
      const c = compareId(packets[a[i]].id, packets[b[i]].id);
      if (c !== 0) return c;
    }
    return 0;
  };

  // Assemble the certified solution: smallest admissible c0, optimal times.
  let finalOrder: number[];
  let finalGaps: number[];
  let finalC0: number;
  let dormEdgeFinal = -1;
  let dormDuration = 0;

  if (dorm === null) {
    activeForcedEdge = -1;
    if (!greedyLexOrder()) {
      // Defensive: phases A/B certify a feasible choice at every position.
      throw new SolveError('NO_CONSISTENT_INTERPRETATION', 'internal failure reconstructing lex-min order');
    }
    finalOrder = chosen.slice();
    finalGaps = fixedGaps.slice();
    finalC0 = curC0lo;
  } else {
    // The lex-min id sequence (objective 3) ranges over all pause boundaries,
    // and the boundary itself is only the final tie-break (objective 5), so
    // the pause placement cannot be committed greedily: reconstruct the
    // lex-min order with the pause forced at each boundary and combine by
    // (id sequence, duration, boundary).
    let best: { order: number[]; duration: number; boundary: number; gaps: number[]; c0: number } | null = null;
    for (let k = 0; k < n - 1; k++) {
      activeForcedEdge = k;
      memoOpt = new Map();
      if (!greedyLexOrder()) continue;
      const orderK = chosen.slice();
      const dur = minDurationForOrderBoundary(orderK, k);
      if (dur === null) continue;
      const cmp = best === null ? -1 : lexOrderCompare(orderK, best.order);
      if (best === null || cmp < 0 || (cmp === 0 && dur.duration < best.duration)) {
        best = { order: orderK, duration: dur.duration, boundary: k, gaps: dur.gaps, c0: dur.c0 };
      }
    }
    activeForcedEdge = -1;
    if (best === null) {
      // Defensive: phases A/B certify a (Pstar, Dstar) completion at some boundary.
      throw new SolveError('NO_CONSISTENT_INTERPRETATION', 'internal failure reconstructing dormancy placement');
    }
    finalOrder = best.order;
    finalGaps = best.gaps;
    finalC0 = best.c0;
    dormEdgeFinal = best.boundary;
    dormDuration = best.duration;
  }

  const finalBounds = gapEdgeBounds(finalGaps, minInterval, maxInterval);
  if (dormEdgeFinal >= 0) {
    // The pause adjacency keeps its exact recovered duration.
    finalBounds.lo[dormEdgeFinal] += dormDuration;
    finalBounds.hi[dormEdgeFinal] += dormDuration;
  }
  const windows = tightenWindows(packets, finalOrder, finalBounds.lo, finalBounds.hi);
  if (!windows) {
    throw new SolveError('NO_CONSISTENT_INTERPRETATION', 'internal failure tightening final windows');
  }
  const { times, deviation2: dev2 } = optimalTimes(
    packets,
    finalOrder,
    windows,
    finalGaps,
    minInterval,
    maxInterval,
    dormEdgeFinal >= 0 ? finalBounds : undefined,
  );
  let gapSum = 0;
  for (const d of finalGaps) gapSum += d;

  return buildResult(
    packets,
    {
      gapSum,
      deviation2: dev2,
      times,
      order: finalOrder,
      c0: finalC0,
      gaps: finalGaps,
    },
    modulus,
    minInterval,
    maxInterval,
    dormEdgeFinal >= 0 ? { edge: dormEdgeFinal, duration: dormDuration } : undefined,
  );
}

function buildResult(
  packets: Packet[],
  cand: { gapSum: number; deviation2: number; times: number[]; order: number[]; c0: number; gaps: number[] },
  modulus: number,
  minInterval: number,
  maxInterval: number,
  dormancy?: { edge: number; duration: number },
): SolveResult {
  const n = cand.order.length;
  const order = cand.order.map((ix) => packets[ix].id);
  const assignments: AssignedPacket[] = [];
  const adjacency: AdjacencyEvidence[] = [];
  const missingSegments: MissingSegment[] = [];
  let dormancyInfo: SolveResult['dormancy'];

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
      const carriesDormancy = dormancy !== undefined && dormancy.edge === k - 1;
      const shift = carriesDormancy ? dormancy.duration : 0;
      if (carriesDormancy) {
        dormancyInfo = {
          duration: dormancy.duration,
          boundaryIndex: k - 1,
          fromId: prevP.id,
          toId: p.id,
          fromCount: prevCount,
          toCount: count,
        };
      }
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
        allowedTimeGap: { min: d * minInterval + shift, max: d * maxInterval + shift },
        missingBetween: d - 1,
        congruence: { remainder: p.remainder, modulus },
        absoluteCountCongruent: modNonNeg(count, modulus) === p.remainder,
        timeWithinInterval: {
          from: { lower: prevP.lo, upper: prevP.hi },
          to: { lower: p.lo, upper: p.hi },
        },
        ...(carriesDormancy
          ? {
              dormancy: {
                duration: dormancy.duration,
                baseAllowedTimeGap: { min: d * minInterval, max: d * maxInterval },
              },
            }
          : {}),
        satisfied:
          tGap >= d * minInterval + shift &&
          tGap <= d * maxInterval + shift &&
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

  return {
    order,
    assignments,
    missingSegments,
    missingCountTotal: cand.gapSum - (n - 1),
    adjacency,
    observedCountRange: { first: cand.c0, last: cand.c0 + cand.gapSum },
    ...(dormancyInfo ? { dormancy: dormancyInfo } : {}),
  };
}

function buildFailureEvidence(
  packets: Packet[],
  pair: PairFeas[][],
  pairDorm: PairFeas[][],
  bestDead: DeadState | null,
  modulus: number,
  countUpper: number,
  minInterval: number,
  maxInterval: number,
  dorm: { lower: number; upper: number } | null,
): SolveError {
  const make = (evidence: ConstraintFailureEvidence): SolveError =>
    new SolveError(
      'NO_CONSISTENT_INTERPRETATION',
      'no globally consistent interpretation exists within the search window',
      evidence,
    );

  const seedStatus = dorm ? ({ dormancyStatus: 'unused' } as const) : {};

  if (bestDead === null) {
    return make({
      stage: 'seed',
      partialLength: 0,
      partialOrder: [],
      candidateId: packets[0].id,
      reason: 'no packet can be seeded inside the absolute count search window',
      ...seedStatus,
    });
  }

  const n = packets.length;
  const { depth, placed, last, S, c0lo, c0hi, tLo, tHi, dormEdge } = bestDead;
  const partialOrder = placed.map((ix) => packets[ix].id);
  const usedNow = new Set(placed);
  const slotsAfter = n - 1 - depth;
  const dormUsed = dormEdge >= 0;
  const dormLo = dorm?.lower ?? 0;
  const dormHi = dorm?.upper ?? 0;

  // Reproduce the canonical successor scan at the deepest dead end. For each
  // unused successor derive the feasible counter-gap range implied by each
  // constraint class independently:
  //   time:  [Tlo, Thi] from the tightened timestamp windows
  //   count: [Clo, Chi] from the c0 window and remaining absolute slots
  // plus the intrinsic ceiling pair.dHi (raw pair intervals + search window)
  // and the congruence residue. Their intersection is empty at a dead end;
  // the first blocker in canonical order (cause, gap, id) is reported. While
  // the dormancy pause is unplaced, each successor is also scanned as a
  // pause-carrying candidate (time bounds shifted down by the pause range).
  type Blocker = {
    j: number;
    cause: 'TIME_GAP' | 'COUNT_WINDOW' | 'CONGRUENCE';
    dStar: number;
    delta: number;
    dorm: boolean;
    timeRange: { min: number; max: number };
    countRange: { min: number; max: number };
    intrinsicCeiling: number;
    achievable: { min: number; max: number };
  };
  const blockers: Blocker[] = [];

  /** Smallest value >= lo congruent to `delta` and <= hi, else Infinity. */
  const snap = (lo: number, hi: number, delta: number): number => {
    if (lo > hi) return Infinity;
    const v = ceilResidue(lo, delta, modulus);
    return v <= hi ? v : Infinity;
  };

  for (let j = 0; j < n; j++) {
    if (usedNow.has(j)) continue;
    const pj = packets[j];
    const Clo = pj.baseCount - S - c0hi;
    const Chi = Math.min(pj.topCount - S - c0lo, countUpper - slotsAfter - S - c0lo);

    for (const withDorm of [false, true]) {
      if (withDorm && (dorm === null || dormUsed)) continue;
      const pf = withDorm ? pairDorm[last][j] : pair[last][j];
      const shiftLo = withDorm ? dormLo : 0;
      const shiftHi = withDorm ? dormHi : 0;
      const d0 = pf.delta === 0 ? modulus : pf.delta;

      const Tlo = Math.ceil((pj.lo - tHi - shiftHi) / maxInterval);
      const Thi = Math.floor((pj.hi - tLo - shiftLo) / minInterval);
      const loAll = Math.max(d0, Tlo, Clo);
      const hiAll = Math.min(pf.dHi, Thi, Chi);

      const snapOrInf = (lo: number, hi: number): number => {
        if (lo > hi) return Infinity;
        const d = ceilResidue(lo, pf.delta, modulus);
        return d <= hi ? d : Infinity;
      };
      const dTime = snapOrInf(Math.max(d0, Tlo), Thi);
      const dCount = snapOrInf(Math.max(d0, Clo), Chi);
      const dBoth = snapOrInf(loAll, hiAll);

      let cause: Blocker['cause'];
      let dStar: number;
      if (dBoth !== Infinity) continue; // extendable; cannot occur at a dead end
      if (dCount !== Infinity) {
        // The smallest gap satisfying congruence + the count window exists;
        // the extension attempt at it fails on the time-difference range.
        cause = 'TIME_GAP';
        dStar = dCount;
      } else if (dTime !== Infinity) {
        // Timing admits a congruent gap but the absolute-count window does not.
        cause = 'COUNT_WINDOW';
        dStar = dTime;
      } else {
        // Neither range alone contains a congruent value.
        cause = Tlo > Thi ? 'TIME_GAP' : 'CONGRUENCE';
        dStar = Infinity;
      }

      blockers.push({
        j,
        cause,
        dStar,
        delta: pf.delta,
        dorm: withDorm,
        timeRange: { min: Tlo, max: Thi },
        countRange: { min: Clo, max: Chi },
        intrinsicCeiling: pf.dHi,
        achievable: { min: pj.lo - tHi, max: pj.hi - tLo },
      });
    }
  }

  const causeRank = { TIME_GAP: 0, COUNT_WINDOW: 1, CONGRUENCE: 2 } as const;
  blockers.sort(
    (a, b) =>
      causeRank[a.cause] - causeRank[b.cause] ||
      a.dStar - b.dStar ||
      compareId(packets[a.j].id, packets[b.j].id) ||
      Number(a.dorm) - Number(b.dorm),
  );

  /** Dormancy usage tag for the reported blocker. */
  const dormancyStatusOf = (dormBlocker: boolean): 'unused' | 'crossing' | 'used' =>
    dormBlocker ? 'crossing' : dormUsed ? 'used' : 'unused';

  /** Human-readable placement phrase appended to blocker reasons. */
  const dormancyPhrase = (dormBlocker: boolean): string => {
    if (dorm === null) return '';
    if (dormBlocker) {
      return ` (the dormancy pause of [${dormLo}, ${dormHi}] was placed on this boundary)`;
    }
    return dormUsed
      ? ' (the dormancy pause was already used on an earlier boundary)'
      : ' (the dormancy pause has not been placed on any earlier boundary)';
  };

  if (blockers.length > 0) {
    const b = blockers[0];
    const pj = packets[b.j];
    const prevId = String(packets[last].id);
    const finite = (x: number): number => (Number.isFinite(x) ? x : -1);
    const d = b.dStar;
    const shiftLo = b.dorm ? dormLo : 0;
    const shiftHi = b.dorm ? dormHi : 0;
    const dormancyStatus = dorm ? { dormancyStatus: dormancyStatusOf(b.dorm) } : {};

    if (b.cause === 'TIME_GAP') {
      // Smallest congruent gap that would satisfy the time-difference range.
      const firstPositive = b.delta === 0 ? modulus : b.delta;
      const dTiming = snap(Math.max(firstPositive, b.timeRange.min), b.timeRange.max, b.delta);
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
          `both constraints${dormancyPhrase(b.dorm)}`,
        ...dormancyStatus,
        detail: {
          cause: 'TIME_GAP',
          minimalCongruentGap: Number.isFinite(dCountVal) ? dCountVal : undefined,
          countGap: Number.isFinite(dCountVal) ? dCountVal : undefined,
          requiredTimeGap: Number.isFinite(dTiming)
            ? { min: dTiming * minInterval + shiftLo, max: dTiming * maxInterval + shiftHi }
            : undefined,
          actualTimeGapRange: b.achievable,
          countGapWindow: { min: b.countRange.min, max: b.countRange.max },
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
          `window only admits a counter gap in [${b.countRange.min}, ${b.countRange.max}] (intrinsic ` +
          `ceiling ${b.intrinsicCeiling}), but the time-difference constraint needs a gap in ` +
          `[${b.timeRange.min}, ${b.timeRange.max}]; the two ranges have no congruent value in ` +
          `common${dormancyPhrase(b.dorm)}`,
        ...dormancyStatus,
        detail: {
          cause: 'COUNT_WINDOW',
          minimalCongruentGap: Number.isFinite(d) ? d : undefined,
          countGapWindow: { min: b.countRange.min, max: b.countRange.max },
          requiredTimeGap: Number.isFinite(d)
            ? { min: d * minInterval + shiftLo, max: d * maxInterval + shiftHi }
            : undefined,
          actualTimeGapRange: b.achievable,
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
        `congruent to ${b.delta} modulo ${modulus}${dormancyPhrase(b.dorm)}`,
      ...dormancyStatus,
      detail: {
        cause: 'CONGRUENCE',
        minimalCongruentGap: Number.isFinite(d) ? d : undefined,
        countGapWindow: { min: b.countRange.min, max: b.countRange.max },
        actualTimeGapRange: b.achievable,
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
    ...(dorm ? { dormancyStatus: dormancyStatusOf(false) } : {}),
  });
}
