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
   * Optional low-battery dormancy model. When BOTH bounds are present the
   * batch contains exactly one sampling pause whose integer duration lies in
   * the closed interval [dormancyLower, dormancyUpper]; the pause is carried
   * by a single adjacency of the recovered order and adds its duration to
   * that adjacency's observed time difference. Both fields must be positive
   * integers with dormancyLower <= dormancyUpper; providing exactly one of
   * them is invalid. When both are absent the legacy model applies.
   */
  dormancyLower?: number;
  dormancyUpper?: number;
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
  /**
   * Present only on the adjacency that carries the dormancy pause. The
   * entry's `allowedTimeGap` already includes the dormancy duration;
   * `baseAllowedTimeGap` records the range implied by the counter gap alone.
   */
  dormancy?: {
    duration: number;
    baseAllowedTimeGap: { min: number; max: number };
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

/**
 * The single dormancy pause recovered for a dormancy-enabled request: the
 * chosen integer duration and the adjacency carrying it.
 */
export interface DormancyInfo {
  /** Chosen integer dormancy duration inside the requested closed interval. */
  duration: number;
  /** 0-based adjacency index carrying the pause (joins position i -> i+1). */
  boundaryIndex: number;
  /** Packet immediately before the pause. */
  fromId: string | number;
  /** Packet immediately after the pause. */
  toId: string | number;
  /** Absolute counter of the packet before the pause. */
  fromCount: number;
  /** Absolute counter of the packet after the pause. */
  toCount: number;
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

export interface SolveResult {
  order: (string | number)[];
  assignments: AssignedPacket[];
  /** Absolute counters inside [firstCount, lastCount] not assigned to a packet. */
  missingSegments: MissingSegment[];
  missingCountTotal: number;
  adjacency: AdjacencyEvidence[];
  /** Counts of the first/last observed packets. */
  observedCountRange: { first: number; last: number };
  /** Recovered dormancy pause; present only for dormancy-enabled requests. */
  dormancy?: DormancyInfo;
}

/** Stable business error codes. */
export type SolveErrorCode =
  | 'INVALID_REQUEST'
  | 'NO_CONSISTENT_INTERPRETATION';

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
   * Dormancy usage at the reported dead end; present only when the request
   * enabled the dormancy model.
   *  - 'unused':   the pause has not been placed on any prefix adjacency and
   *    the reported blocker concerns a regular (pause-free) extension;
   *  - 'crossing': the reported blocker concerns the extension that would
   *    itself carry the pause;
   *  - 'used':     the pause was already placed on an earlier adjacency.
   */
  dormancyStatus?: 'unused' | 'crossing' | 'used';
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
