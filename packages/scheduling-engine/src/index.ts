// Public API for @dibslist/scheduling-engine.
// Lifted + adapted from cal.diy (@180ede28, MIT). See README.md.

export { default as dayjs } from "./dayjs";
export type { Dayjs, ConfigType } from "./dayjs";

export type {
  DateRange,
  DateOverride,
  WorkingHours,
  SchedulingType,
  IFromUser,
  IToUser,
  IOutOfOfficeData,
  IOutOfOfficeDataEntry,
} from "./types";

export {
  buildDateRanges,
  processWorkingHours,
  processDateOverride,
  groupByDate,
  intersect,
  subtract,
  mergeOverlappingRanges,
} from "./date-ranges";

export {
  getSlots,
  buildSlotsWithDateRanges,
} from "./slots";
export type { GetSlots, TimeFrame } from "./slots";

export {
  getAggregatedAvailability,
  filterRedundantDateRanges,
  mergeOverlappingDateRanges,
  IntervalTree,
  ContainmentSearchAlgorithm,
  createIntervalNodes,
} from "./aggregate";
export type { IntervalNode } from "./aggregate";

export { checkForConflicts } from "./conflicts";
export type { BufferedBusyTime, CurrentSeats } from "./conflicts";

export {
  scoreSlot,
  rankSlots,
  earliness,
  fragmentation,
  backToBackPenalty,
  focusViolation,
  loadImbalance,
  tzFairness,
  interviewerPreference,
  bufferComfort,
  DEFAULT_WEIGHTS,
  MIN_USEFUL_GAP_MS,
  TARGET_COMFORT_GAP_MS,
} from "./ranking";
export type {
  EnumeratedSlot,
  RankedSlot,
  BusyInterval,
  PreferredWindow,
  RankingContext,
  ScoringWeights,
} from "./ranking";
