// Lifted from cal.diy `packages/dayjs/index.ts` (@180ede28, MIT).
//
// The upstream wrapper also registers a local `business-days-plugin` plus a few
// display-only plugins (isToday, localizedFormat, relativeTime, toArray). None
// of those are exercised by the scheduling math lifted into this package, so we
// register only the plugin set the date-ranges / slots / aggregate / conflicts
// code actually depends on:
//   - utc, timezone     -> `.utc()`, `.tz()` (DST + half-hour-offset handling)
//   - isBetween         -> date-override windowing in `buildDateRanges`
//   - minMax            -> `dayjs.min` / `dayjs.max` in `processWorkingHours`
//   - customParseFormat -> robust parsing of `"YYYY-MM-DD hh:mm"` offset probe
//   - duration          -> kept for parity with the upstream instance
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import duration from "dayjs/plugin/duration";
import isBetween from "dayjs/plugin/isBetween";
import minMax from "dayjs/plugin/minMax";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";

dayjs.extend(customParseFormat);
dayjs.extend(isBetween);
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(minMax);
dayjs.extend(duration);

export type Dayjs = dayjs.Dayjs;

export type { ConfigType } from "dayjs";

export default dayjs;
