/**
 * Domain types for the buoy telemetry recovery problem.
 *
 * Each observed packet carries:
 *  - a unique caller-assigned id (download order is meaningless)
 *  - a counter remainder modulo `modulus` (the rotation/wrap counter)
 *  - an integer closed time interval [timeLower, timeUpper] during which
 *    the packet was actually transmitted
 *
 * The service jointly assigns every packet:
 *  - a distinct absolute counter, congruent to its remainder modulo modulus,
 *    inside the absolute-count search window
 *  - an integer transmit timestamp inside its closed interval
 * such that for every pair of adjacent observed packets (in recovered order),
 * the observed time difference lies inside the sampling window implied by
 * their counter difference.
 */

export interface PacketInput {
  /** Caller-assigned unique packet identifier (string or number). */
  id: string | number;
  /** Observed counter remainder r, required: 0 <= r < modulus. */
  remainder: number;
  /** Inclusive integer lower bound of the transmit time interval. */
  timeLower: number;
  /** Inclusive integer upper bound of the transmit time interval. */
  timeUpper: number;
}

export interface SolveRequest {
  packets: PacketInput[];
  /** Counter modulus M (rotation period), integer >= 2. */
  modulus: number;
  /** Inclusive absolute-counter search window lower bound. */
  countLower: number;
  /** Inclusive absolute-counter search window upper bound. */
  countUpper: number;
  /** Minimum interval (inclusive) between adjacent samples. */
  minInterval: number;
  /** Maximum interval (inclusive) between adjacent samples. */
  maxInterval: number;
  /**
   * Optional closed integer range for the single low-power dormancy: when
   * present, exactly one pair of adjacent observed packets carries one pause
   * whose integer duration lies inside [lower, upper]. Either both fields are
   * supplied (positive integers, lower <= upper) or neither.
   */
  dormancy?: { lower: number; upper: number };
}

/** Per-adjacent-pair constraint check evidence. */
export interface AdjacencyEvidence {
  /** Position in the recovered order, 0-based (evidence[i] joins slot i -> i+1). */
  index: number;
  fromId: string | number;
  toId: string | number;
  fromCount: number;
  toCount: number;
  /** toCount - fromCount (always >= 1; observed packets are distinct). */
  countGap: number;
  fromTime: number;
  toTime: number;
  /** toTime - fromTime (always positive for a consistent solution). */
  timeGap: number;
  /** Inclusive feasible time-difference range for this counter gap. */
  allowedTimeGap: { min: number; max: number };
  /**
   * Dormancy carried by exactly this adjacency:
   *  - absent when no dormancy was requested for the batch,
   *  - `{ duration: 0, carriesDormancy: false }` on every edge but one,
   *  - `{ duration: s, carriesDormancy: true }` on the unique edge whose
   *    observed gap includes the counter-frozen pause of integer length s;
   *    `allowedTimeGap` already includes the pause on that edge.
   */
  dormancy?: { duration: number; carriesDormancy: boolean };
  /** Number of unobserved absolute counters strictly between the pair. */
  missingBetween: number;
  /** Congruence note for the destination packet. */
  congruence: { remainder: number; modulus: number };
  /** toCount mod modulus equals the destination packet's remainder. */
  absoluteCountCongruent: boolean;
  /** Closed-interval containment for the chosen timestamps. */
  timeWithinInterval: {
    from: { lower: number; upper: number };
    to: { lower: number; upper: number };
  };
  satisfied: boolean;
}

export interface MissingSegment {
  /** Inclusive first missing absolute counter. */
  fromCount: number;
  /** Inclusive last missing absolute counter. */
  toCount: number;
  /** Number of counters in the segment (toCount - fromCount + 1). */
  length: number;
}

export interface AssignedPacket {
  /** 0-based position in the recovered transmission order. */
  position: number;
  id: string | number;
  absoluteCount: number;
  time: number;
  remainder: number;
  timeInterval: { lower: number; upper: number };
}

/** Unique adjacency carrying the low-power dormancy, when requested. */
export interface DormancyInfo {
  /** Chosen integer pause duration (inside the requested closed range). */
  duration: number;
  /** Adjacency index (into `adjacency`) and recovered positions of the pair. */
  adjacencyIndex: number;
  fromPosition: number;
  toPosition: number;
  fromId: string | number;
  toId: string | number;
  /** Requested closed range the duration was chosen from. */
  range: { lower: number; upper: number };
}

export interface SolveResult {
  order: (string | number)[];
  assignments: AssignedPacket[];
  /** Absolute counters inside [firstCount, lastCount] not assigned to a packet. */
  missingSegments: MissingSegment[];
  missingCountTotal: number;
  adjacency: AdjacencyEvidence[];
  /** Counts of the first/last observed packets. */
  observedCountRange: { first: number; last: number };
  /** Present exactly when the request enabled dormancy. */
  dormancy?: DormancyInfo;
}

/** Stable business error codes. */
export type SolveErrorCode =
  | 'INVALID_REQUEST'
  | 'NO_CONSISTENT_INTERPRETATION';

/** Dormancy disposition at the first non-extendable state. */
export type DormancyStatus = 'NOT_USED' | 'CROSSING' | 'USED';

export interface ConstraintFailureEvidence {
  /** Recovery stage at which extension failed. */
  stage: 'seed' | 'extension';
  /** Number of packets already fixed in the partial order (0 for seed failure). */
  partialLength: number;
  /** Packet ids already fixed, in partial order. */
  partialOrder: (string | number)[];
  /** The packet that could not be appended / could not be seeded. */
  candidateId: string | number;
  /**
   * Human-readable, stable description of the first constraint that could
   * not be extended.
   */
  reason: string;
  /**
   * When dormancy was requested, marks whether the unique pause had not yet
   * been used by any fixed edge, was being carried by the edge that failed to
   * extend, or had already been used on an earlier edge.
   */
  dormancyStatus?: DormancyStatus;
  /** When status is USED, the earlier edge that already carries the pause. */
  dormancyEdge?: {
    index: number;
    fromId: string | number;
    toId: string | number;
  };
  /**
   * Numeric detail:
   *  - for 'extension' adjacency failures: the count gap that was rejected,
   *  - absent when no admissible candidate count exists at all.
   */
  detail?: {
    /** Which constraint class prevents the extension. */
    cause: 'TIME_GAP' | 'COUNT_WINDOW' | 'CONGRUENCE';
    /** Smallest congruent counter gap considered. */
    minimalCongruentGap?: number;
    countGap?: number;
    requiredTimeGap?: { min: number; max: number };
    actualTimeGapRange?: { min: number; max: number };
    /** Residual gap range allowed by the absolute-count search window. */
    countGapWindow?: { min: number; max: number };
    /** Requested closed dormancy duration range, when enabled. */
    dormancyRange?: { lower: number; upper: number };
    /**
     * For CROSSING failures: time-difference range required for the counter
     * gap alone, versus the range reachable after adding a pause duration
     * inside the requested interval.
     */
    dormancyTimeGap?: {
      withoutPause: { min: number; max: number };
      withPause: { min: number; max: number };
    };
  };
}

export class SolveError extends Error {
  readonly code: SolveErrorCode;
  readonly evidence?: ConstraintFailureEvidence;

  constructor(code: SolveErrorCode, message: string, evidence?: ConstraintFailureEvidence) {
    super(message);
    this.name = 'SolveError';
    this.code = code;
    this.evidence = evidence;
  }
}
