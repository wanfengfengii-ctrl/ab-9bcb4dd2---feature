import type { SolveRequest } from '../../src/core/types.js';

/**
 * Canonical cross-week + missing-packet scenario shared by unit tests, the
 * verify service and the HTTP smoke check.
 *
 * Ground truth (transmission order), modulus 10, interval 9..11 per step:
 *
 *   A    B    C    D    E    F    G
 *    8 -> 9 ->12 ->21 ->22 ->30 ->31
 *   r=8  r=9  r=2  r=1  r=2  r=0  r=1
 *
 * Missing spans: 10-11, 13-20, 23-29. True transmit time = 10 * count, each
 * reported as the closed interval [true-3, true+3]. Packets below are listed
 * in scrambled "download" order so the download order cannot be the answer.
 */
export const sampleRequest: SolveRequest = {
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

export const sampleExpected = {
  order: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
  counts: [8, 9, 12, 21, 22, 30, 31],
  times: [80, 90, 120, 210, 220, 300, 310],
  missingTotal: 17,
  missingSegments: [
    { fromCount: 10, toCount: 11, length: 2 },
    { fromCount: 13, toCount: 20, length: 8 },
    { fromCount: 23, toCount: 29, length: 7 },
  ],
};

/**
 * Low-battery dormancy scenario shared by unit tests, the verify service and
 * the HTTP smoke check. Same counter truth as the canonical sample, but the
 * buoy paused sampling once between D and E without advancing the counter;
 * the pause shifted every later packet's wall-clock time.
 *
 * Ground truth (transmission order), modulus 10, interval 9..11 per step:
 *
 *   A    B    C    D    E    F    G
 *    8 -> 9 ->12 ->21 ->22 ->30 ->31
 *   r=8  r=9  r=2  r=1  r=2  r=0  r=1
 *
 * True transmit times 80, 90, 120, 210, 271, 351, 361: the D->E difference
 * (61) exceeds the pause-free range for a unit counter gap ([9, 11]) and is
 * only explainable by a dormancy pause inside [40, 60]. Without the dormancy
 * fields this instance has NO_CONSISTENT_INTERPRETATION. Reported intervals
 * are [true-3, true+3]; packets are listed in scrambled download order.
 */
export const dormantSampleRequest: SolveRequest = {
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

export const dormantSampleExpected = {
  order: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
  counts: [8, 9, 12, 21, 22, 30, 31],
  times: [80, 90, 120, 210, 271, 351, 361],
  missingTotal: 17,
  /** Shortest pause consistent with the midpoint-exact D->E difference 61. */
  duration: 50,
  boundaryIndex: 3,
  fromId: 'D',
  toId: 'E',
};
