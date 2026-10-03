import type { PacketInput } from '../../src/core/types.js';

export interface RefSolution {
  missing: number;
  deviation: number;
  idSeq: (string | number)[];
}

export function lexIds(a: (string | number)[], b: (string | number)[]): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x - y;
    } else if (typeof x === 'number') return -1;
    else if (typeof y === 'number') return 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Independent exhaustive reference with deliberately simple, separate logic:
 * every packet order, then every strictly increasing congruent count
 * assignment, then every integer timestamp in each closed interval, with
 * adjacency bounds pruned inline. Returns the lexicographically optimal
 * (missing, deviation, id sequence) tuple or null when nothing is feasible.
 */
export function bruteSolve(
  packets: PacketInput[],
  modulus: number,
  countLower: number,
  countUpper: number,
  minInterval: number,
  maxInterval: number,
): RefSolution | null {
  const n = packets.length;
  const mod = (a: number): number => ((a % modulus) + modulus) % modulus;
  let best: RefSolution | null = null;

  const order: number[] = [];
  const usedPkt = new Uint8Array(n);
  const counts = new Array<number>(n);
  const times = new Array<number>(n);

  const considerLeaf = (): void => {
    let gapSum = 0;
    for (let k = 1; k < n; k++) gapSum += counts[k] - counts[k - 1];
    let dev = 0;
    for (let k = 0; k < n; k++) {
      const p = packets[order[k]];
      dev += Math.abs(2 * times[k] - (p.timeLower + p.timeUpper));
    }
    const cand: RefSolution = {
      missing: gapSum - (n - 1),
      deviation: dev,
      idSeq: order.map((ix) => packets[ix].id),
    };
    if (
      best === null ||
      cand.missing < best.missing ||
      (cand.missing === best.missing &&
        (cand.deviation < best.deviation ||
          (cand.deviation === best.deviation && lexIds(cand.idSeq, best.idSeq) < 0)))
    ) {
      best = cand;
    }
  };

  const chooseTime = (k: number): void => {
    const pix = order[k];
    const p = packets[pix];
    for (let t = p.timeLower; t <= p.timeUpper; t++) {
      if (k > 0) {
        const d = counts[k] - counts[k - 1];
        const g = t - times[k - 1];
        if (g < d * minInterval || g > d * maxInterval) continue;
      }
      times[k] = t;
      if (k === n - 1) considerLeaf();
      else chooseTime(k + 1);
    }
  };

  const chooseCount = (k: number): void => {
    if (k === n) {
      chooseTime(0);
      return;
    }
    const pix = order[k];
    const p = packets[pix];
    const from = k === 0 ? countLower : counts[k - 1] + 1;
    for (let c = from; c <= countUpper; c++) {
      if (mod(c) !== p.remainder) continue;
      if (c + (n - 1 - k) > countUpper) break;
      if (k > 0) {
        const d = c - counts[k - 1];
        if (p.timeLower - packets[order[k - 1]].timeUpper > d * maxInterval) continue;
        if (p.timeUpper - packets[order[k - 1]].timeLower < d * minInterval) continue;
      }
      counts[k] = c;
      chooseCount(k + 1);
    }
  };

  const choosePacket = (k: number): void => {
    if (k === n) {
      chooseCount(0);
      return;
    }
    for (let i = 0; i < n; i++) {
      if (usedPkt[i]) continue;
      usedPkt[i] = 1;
      order[k] = i;
      choosePacket(k + 1);
      usedPkt[i] = 0;
    }
  };

  choosePacket(0);
  return best;
}

export function makeRng(start: number): () => number {
  let seed = start;
  return () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
}

export interface DormRefSolution extends RefSolution {
  dormEdge: number;
  dormDuration: number;
}

/**
 * Exhaustive reference with the single dormancy pause. Every packet order,
 * every increasing congruent count assignment, every carrying edge
 * position, every integer pause duration in [dLo, dHi] and every timestamp
 * is enumerated; the lexicographic optimum
 *   (missing, deviation, id sequence, pause duration, carrying edge)
 * is returned, or null when no interpretation exists.
 */
export function bruteSolveDormancy(
  packets: PacketInput[],
  modulus: number,
  countLower: number,
  countUpper: number,
  minInterval: number,
  maxInterval: number,
  dRange: { lower: number; upper: number },
): DormRefSolution | null {
  const n = packets.length;
  const mod = (a: number): number => ((a % modulus) + modulus) % modulus;
  let best: DormRefSolution | null = null;

  const order: number[] = [];
  const usedPkt = new Uint8Array(n);
  const counts = new Array<number>(n);
  const times = new Array<number>(n);

  const considerLeaf = (dormEdge: number, dormDuration: number): void => {
    let gapSum = 0;
    for (let k = 1; k < n; k++) gapSum += counts[k] - counts[k - 1];
    let dev = 0;
    for (let k = 0; k < n; k++) {
      const p = packets[order[k]];
      dev += Math.abs(2 * times[k] - (p.timeLower + p.timeUpper));
    }
    const cand: DormRefSolution = {
      missing: gapSum - (n - 1),
      deviation: dev,
      idSeq: order.map((ix) => packets[ix].id),
      dormEdge,
      dormDuration,
    };
    const better =
      best === null ||
      cand.missing < best.missing ||
      (cand.missing === best.missing &&
        (cand.deviation < best.deviation ||
          (cand.deviation === best.deviation &&
            (lexIds(cand.idSeq, best.idSeq) < 0 ||
              (lexIds(cand.idSeq, best.idSeq) === 0 &&
                (cand.dormDuration < best.dormDuration ||
                  (cand.dormDuration === best.dormDuration && cand.dormEdge < best.dormEdge)))))));
    if (better) best = cand;
  };

  const chooseTime = (k: number, dormEdge: number, dormDuration: number): void => {
    const pix = order[k];
    const p = packets[pix];
    for (let t = p.timeLower; t <= p.timeUpper; t++) {
      if (k > 0) {
        const d = counts[k] - counts[k - 1];
        const pause = k - 1 === dormEdge ? dormDuration : 0;
        const g = t - times[k - 1];
        if (g < d * minInterval + pause || g > d * maxInterval + pause) continue;
      }
      times[k] = t;
      if (k === n - 1) considerLeaf(dormEdge, dormDuration);
      else chooseTime(k + 1, dormEdge, dormDuration);
    }
  };

  const chooseCount = (k: number, dormEdge: number, dormDuration: number): void => {
    if (k === n) {
      chooseTime(0, dormEdge, dormDuration);
      return;
    }
    const pix = order[k];
    const p = packets[pix];
    const from = k === 0 ? countLower : counts[k - 1] + 1;
    for (let c = from; c <= countUpper; c++) {
      if (mod(c) !== p.remainder) continue;
      if (c + (n - 1 - k) > countUpper) break;
      if (k > 0) {
        const d = c - counts[k - 1];
        const pause = k - 1 === dormEdge ? dormDuration : 0;
        if (p.timeLower - packets[order[k - 1]].timeUpper > d * maxInterval + pause) continue;
        if (p.timeUpper - packets[order[k - 1]].timeLower < d * minInterval + pause) continue;
      }
      counts[k] = c;
      chooseCount(k + 1, dormEdge, dormDuration);
    }
  };

  const choosePacket = (k: number): void => {
    if (k === n) {
      // Exactly one carrying adjacency; enumerate its position and duration.
      for (let dormEdge = 0; dormEdge < n - 1; dormEdge++) {
        for (let dormDuration = dRange.lower; dormDuration <= dRange.upper; dormDuration++) {
          chooseCount(0, dormEdge, dormDuration);
        }
      }
      return;
    }
    for (let i = 0; i < n; i++) {
      if (usedPkt[i]) continue;
      usedPkt[i] = 1;
      order[k] = i;
      choosePacket(k + 1);
      usedPkt[i] = 0;
    }
  };

  choosePacket(0);
  return best;
}
