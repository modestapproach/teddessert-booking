// Lifted from cal.diy (@180ede28, MIT), combining:
//   - `packages/features/availability/lib/getAggregatedAvailability/getAggregatedAvailability.ts`
//   - `.../date-range-utils/filterRedundantDateRanges.ts`
//   - `.../date-range-utils/mergeOverlappingDateRanges.ts`
//   - `packages/lib/intervalTree.ts` (dependency of filterRedundantDateRanges)
// Adapted on lift:
//   - `intersect` / `DateRange`        -> `./date-ranges` / `./types`
//   - `DEFAULT_GROUP_ID` (@calcom)     -> inlined "default_group_id"
//   - `SchedulingType` (Prisma enum)   -> inlined string-literal union; enum
//     member refs swapped to "COLLECTIVE" / "ROUND_ROBIN" literals
//   - interval tree copied verbatim (pure TS, no deps)
import { intersect } from "./date-ranges";
import type { DateRange, SchedulingType } from "./types";

// Was `DEFAULT_GROUP_ID` from `@calcom/lib/constants`.
const DEFAULT_GROUP_ID = "default_group_id";

// ---------------------------------------------------------------------------
// Interval tree (lifted verbatim from `@calcom/lib/intervalTree`)
// ---------------------------------------------------------------------------

export interface IntervalNode<T> {
  item: T;
  index: number;
  start: number;
  end: number;
  maxEnd: number;
  left?: IntervalNode<T>;
  right?: IntervalNode<T>;
}

export function createIntervalNodes<T>(
  items: T[],
  getStart: (item: T) => number,
  getEnd: (item: T) => number
): IntervalNode<T>[] {
  return items.map((item, index) => ({
    item,
    index,
    start: getStart(item),
    end: getEnd(item),
    maxEnd: getEnd(item),
  }));
}

export class IntervalTree<T> {
  private root?: IntervalNode<T>;

  constructor(nodes: IntervalNode<T>[]) {
    this.root = this.buildTree([...nodes]);
  }

  private buildTree(nodes: IntervalNode<T>[]): IntervalNode<T> | undefined {
    if (nodes.length === 0) return undefined;

    const mid = Math.floor(nodes.length / 2);
    const node = nodes[mid];

    const leftNodes = nodes.slice(0, mid);
    const rightNodes = nodes.slice(mid + 1);

    node.left = this.buildTree(leftNodes);
    node.right = this.buildTree(rightNodes);

    node.maxEnd = Math.max(node.end, node.left?.maxEnd ?? 0, node.right?.maxEnd ?? 0);

    return node;
  }

  getRoot(): IntervalNode<T> | undefined {
    return this.root;
  }
}

export class ContainmentSearchAlgorithm<T> {
  private tree: IntervalTree<T>;

  constructor(tree: IntervalTree<T>) {
    this.tree = tree;
  }

  findContainingIntervals(targetStart: number, targetEnd: number, targetIndex: number): IntervalNode<T>[] {
    const result: IntervalNode<T>[] = [];
    this.searchContaining(this.tree.getRoot(), targetStart, targetEnd, targetIndex, result);
    return result;
  }

  private searchContaining(
    node: IntervalNode<T> | undefined,
    targetStart: number,
    targetEnd: number,
    targetIndex: number,
    result: IntervalNode<T>[]
  ): void {
    if (!node) return;

    if (node.end < node.start) {
      this.searchContaining(node.left, targetStart, targetEnd, targetIndex, result);
      this.searchContaining(node.right, targetStart, targetEnd, targetIndex, result);
      return;
    }

    if (node.start <= targetStart && node.end >= targetEnd && node.index !== targetIndex) {
      result.push(node);
    }

    if (node.left && node.left.maxEnd >= targetStart) {
      this.searchContaining(node.left, targetStart, targetEnd, targetIndex, result);
    }

    if (node.right && node.start <= targetEnd) {
      this.searchContaining(node.right, targetStart, targetEnd, targetIndex, result);
    }
  }
}

// ---------------------------------------------------------------------------
// mergeOverlappingDateRanges (lifted verbatim)
// ---------------------------------------------------------------------------

export function mergeOverlappingDateRanges(dateRanges: DateRange[]) {
  dateRanges.sort((a, b) => a.start.valueOf() - b.start.valueOf());

  const mergedDateRanges: DateRange[] = [];

  let currentRange = dateRanges[0];
  if (!currentRange) {
    return [];
  }

  for (let i = 1; i < dateRanges.length; i++) {
    const nextRange = dateRanges[i];

    if (isCurrentRangeOverlappingNext(currentRange, nextRange)) {
      currentRange = {
        start: currentRange.start,
        end: currentRange.end.valueOf() > nextRange.end.valueOf() ? currentRange.end : nextRange.end,
      };
    } else {
      mergedDateRanges.push(currentRange);
      currentRange = nextRange;
    }
  }
  mergedDateRanges.push(currentRange);

  return mergedDateRanges;
}

function isCurrentRangeOverlappingNext(currentRange: DateRange, nextRange: DateRange): boolean {
  return (
    currentRange.start.valueOf() <= nextRange.start.valueOf() &&
    currentRange.end.valueOf() > nextRange.start.valueOf()
  );
}

// ---------------------------------------------------------------------------
// filterRedundantDateRanges (lifted verbatim)
// ---------------------------------------------------------------------------

/**
 * Filters out date ranges that are completely covered by other date ranges.
 * Uses an interval tree for O(n log n) worst-case complexity.
 * Unlike mergeOverlappingDateRanges, this doesn't merge overlapping ranges,
 * it only removes ranges that are completely contained within others.
 */
export function filterRedundantDateRanges(dateRanges: DateRange[]): DateRange[] {
  if (dateRanges.length <= 1) return dateRanges;

  const sortedRanges = [...dateRanges].sort((a, b) => a.start.valueOf() - b.start.valueOf());
  const intervalNodes = createIntervalNodes(
    sortedRanges,
    (range) => range.start.valueOf(),
    (range) => range.end.valueOf()
  );
  const intervalTree = new IntervalTree(intervalNodes);
  const searchAlgorithm = new ContainmentSearchAlgorithm(intervalTree);

  return sortedRanges.filter((range, index) => {
    if (range.end.valueOf() < range.start.valueOf()) {
      return true;
    }

    const containingIntervals = searchAlgorithm.findContainingIntervals(
      range.start.valueOf(),
      range.end.valueOf(),
      index
    );

    for (const containingNode of containingIntervals) {
      const otherRange = containingNode.item;
      const otherIndex = containingNode.index;

      if (
        otherRange.start.valueOf() === range.start.valueOf() &&
        otherRange.end.valueOf() === range.end.valueOf()
      ) {
        return otherIndex > index; // Keep current range only if other range has higher index
      }

      // If we reach here, the other range actually contains this range
      return false;
    }

    return true; // Keep this range
  });
}

// ---------------------------------------------------------------------------
// getAggregatedAvailability (lifted; SchedulingType enum -> string literals)
// ---------------------------------------------------------------------------

function uniqueAndSortedDateRanges(ranges: DateRange[]): DateRange[] {
  const seen = new Set<string>();

  return ranges
    .sort((a, b) => {
      const startDiff = a.start.valueOf() - b.start.valueOf();
      return startDiff !== 0 ? startDiff : a.end.valueOf() - b.end.valueOf();
    })
    .filter((range) => {
      const key = `${range.start.valueOf()}-${range.end.valueOf()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export const getAggregatedAvailability = (
  userAvailability: {
    dateRanges: DateRange[];
    oooExcludedDateRanges: DateRange[];
    user?: { isFixed?: boolean; groupId?: string | null };
  }[],
  schedulingType: SchedulingType | null
): DateRange[] => {
  const isTeamEvent =
    schedulingType === "COLLECTIVE" || schedulingType === "ROUND_ROBIN" || userAvailability.length > 1;

  const fixedHosts = userAvailability.filter(
    ({ user }) => !schedulingType || schedulingType === "COLLECTIVE" || user?.isFixed
  );

  const fixedDateRanges = mergeOverlappingDateRanges(
    intersect(fixedHosts.map((s) => (!isTeamEvent ? s.dateRanges : s.oooExcludedDateRanges)))
  );
  const dateRangesToIntersect = fixedDateRanges.length ? [fixedDateRanges] : [];
  const roundRobinHosts = userAvailability.filter(({ user }) => user?.isFixed !== true);
  if (roundRobinHosts.length) {
    // Group round robin hosts by their groupId
    const hostsByGroup = roundRobinHosts.reduce(
      (groups, host) => {
        const groupId = host.user?.groupId || DEFAULT_GROUP_ID;
        if (!groups[groupId]) {
          groups[groupId] = [];
        }
        groups[groupId].push(host);
        return groups;
      },
      {} as Record<string, typeof roundRobinHosts>
    );

    // at least one host from each group needs to be available
    Object.values(hostsByGroup).forEach((groupHosts) => {
      if (groupHosts.length > 0) {
        const groupDateRanges = groupHosts.flatMap((s) =>
          !isTeamEvent ? s.dateRanges : s.oooExcludedDateRanges
        );
        dateRangesToIntersect.push(groupDateRanges ?? []);
      }
    });
  }

  const availability = intersect(dateRangesToIntersect);

  const uniqueRanges = uniqueAndSortedDateRanges(availability);

  return filterRedundantDateRanges(uniqueRanges);
};
