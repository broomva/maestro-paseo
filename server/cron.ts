// When a schedule runs: five-field cron expressions (Paseo's cron cadence,
// in its time zone) and launchd's StartCalendarInterval (in the Mac's own),
// both as one matcher, and the cadence in words. Pure, so every rule is
// tested. It answers when a run falls due, never whether one ran.
//
// Cron semantics are the usual ones: `*`, lists, ranges and steps, month
// and weekday names, Sunday as 0 or 7, and a day of the month OR a weekday
// when both are restricted. launchd's dictionaries read the same way, a key
// it leaves out being a wildcard (so `{ Hour: 2 }` runs every minute of
// 02:00 to 02:59, as launchd does).

/** One matcher: the minutes, hours, days, months and weekdays it allows. */
export interface CronSpec {
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  day: ReadonlySet<number>;
  month: ReadonlySet<number>;
  weekday: ReadonlySet<number>;
  /** Whether the day and the weekday were left open, which decides how the two combine. */
  anyDay: boolean;
  anyWeekday: boolean;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

function range(from: number, to: number, step = 1): number[] {
  const out: number[] = [];
  for (let value = from; value <= to; value += step) out.push(value);
  return out;
}

/** One field's values, or null when it does not read. */
function field(text: string, min: number, max: number, names: readonly string[] = []): Set<number> | null {
  const value = (token: string): number | null => {
    const named = names.indexOf(token.toLowerCase());
    if (named >= 0) return named + (min === 1 ? 1 : 0);
    if (!/^\d+$/.test(token)) return null;
    return Number(token);
  };
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const [base = "", stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return null;
    let from: number | null;
    let to: number | null;
    if (base === "*" || base === "?") {
      from = min;
      to = max;
    } else if (base.includes("-")) {
      const [a = "", b = ""] = base.split("-");
      from = value(a);
      to = value(b);
    } else {
      from = value(base);
      // `5/15` runs from 5 to the end, by 15.
      to = stepText === undefined ? from : max;
    }
    if (from === null || to === null || from < min || to > max || from > to) return null;
    for (const one of range(from, to, step)) out.add(one);
  }
  return out.size > 0 ? out : null;
}

/** A five-field cron expression (or a macro such as `@hourly`), or null when it does not read. */
export function parseCron(expression: string): CronSpec | null {
  const trimmed = expression.trim().toLowerCase();
  const fields = (MACROS[trimmed] ?? trimmed).split(/\s+/);
  if (fields.length !== 5) return null;
  const [m = "", h = "", d = "", mo = "", w = ""] = fields;
  const minute = field(m, 0, 59);
  const hour = field(h, 0, 23);
  const day = field(d, 1, 31);
  const month = field(mo, 1, 12, MONTHS);
  const weekdayRaw = field(w, 0, 7, WEEKDAYS);
  if (!minute || !hour || !day || !month || !weekdayRaw) return null;
  const weekday = new Set([...weekdayRaw].map((one) => one % 7));
  return { minute, hour, day, month, weekday, anyDay: d === "*" || d === "?", anyWeekday: w === "*" || w === "?" };
}

/** launchd's calendar keys. */
const CALENDAR_KEYS = ["Minute", "Hour", "Day", "Weekday", "Month"] as const;

/** One StartCalendarInterval dictionary as a matcher, or null when a value is not a whole number in range. */
export function calendarSpec(entry: Record<string, unknown>): CronSpec | null {
  const one = (key: (typeof CALENDAR_KEYS)[number], min: number, max: number): Set<number> | null | undefined => {
    const raw = entry[key];
    if (raw === undefined) return undefined;
    return typeof raw === "number" && Number.isInteger(raw) && raw >= min && raw <= max ? new Set([raw]) : null;
  };
  const minute = one("Minute", 0, 59);
  const hour = one("Hour", 0, 23);
  const day = one("Day", 1, 31);
  const weekday = one("Weekday", 0, 7);
  const month = one("Month", 1, 12);
  if ([minute, hour, day, weekday, month].includes(null)) return null;
  return {
    minute: minute ?? new Set(range(0, 59)),
    hour: hour ?? new Set(range(0, 23)),
    day: day ?? new Set(range(1, 31)),
    month: month ?? new Set(range(1, 12)),
    weekday: weekday ? new Set([...weekday].map((value) => value % 7)) : new Set(range(0, 6)),
    anyDay: day === undefined,
    anyWeekday: weekday === undefined,
  };
}

/** StartCalendarInterval as launchd takes it: one dictionary or a list of them. Null when any entry does not read. */
export function calendarSpecs(value: unknown): CronSpec[] | null {
  const entries = Array.isArray(value) ? value : [value];
  if (entries.length === 0) return null;
  const specs: CronSpec[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const spec = calendarSpec(entry as Record<string, unknown>);
    if (!spec) return null;
    specs.push(spec);
  }
  return specs;
}

interface Parts {
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
/** Minutes already read, per zone: the same days are walked on every read. Cleared, not grown, past its size. */
const seenParts = new Map<string, Parts>();
/** About two zones of the eight days walked back and the eight ahead, an hour a step where no matcher allows it. */
const SEEN_PARTS_MAX = 30_000;

/** The wall-clock fields of an instant in a time zone (the Mac's own when none is given). */
function partsOf(at: number, zone: string | undefined): Parts {
  const key = zone ?? "";
  const memo = `${key}|${at}`;
  const known = seenParts.get(memo);
  if (known) return known;
  if (seenParts.size >= SEEN_PARTS_MAX) seenParts.clear();
  const parts = readParts(at, key, zone);
  seenParts.set(memo, parts);
  return parts;
}

function readParts(at: number, key: string, zone: string | undefined): Parts {
  let format = formatters.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    formatters.set(key, format);
  }
  const parts: Record<string, string> = {};
  for (const part of format.formatToParts(at)) parts[part.type] = part.value;
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour) % 24,
    day: Number(parts.day),
    month: Number(parts.month),
    weekday: WEEKDAYS.indexOf((parts.weekday ?? "").slice(0, 3).toLowerCase()),
  };
}

/** Whether a time zone name is one this runtime knows. */
export function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function matches(spec: CronSpec, parts: Parts): boolean {
  return spec.minute.has(parts.minute) && inHour(spec, parts);
}

/** Whether the matcher allows some minute of this hour: all but the minute match. */
function inHour(spec: CronSpec, parts: Parts): boolean {
  if (!spec.hour.has(parts.hour) || !spec.month.has(parts.month)) return false;
  const day = spec.day.has(parts.day);
  const weekday = spec.weekday.has(parts.weekday);
  if (spec.anyDay && spec.anyWeekday) return true;
  if (spec.anyDay) return weekday;
  if (spec.anyWeekday) return day;
  return day || weekday;
}

const MINUTE = 60_000;

/**
 * The times any of the matchers falls due after `from` and up to `to`, each
 * on a whole minute, soonest first, at most `limit` of them. The minutes are
 * walked in real time, so a daylight-saving change is handled as the wall
 * clock moves. An hour no matcher allows any minute of is stepped over, but
 * only when the step lands on the next hour's minute 0. A clock change that
 * lands it anywhere else, as Chatham's 02:45 → 03:45 lands 02:00 + 60 min on
 * 04:00, is walked a minute at a time instead, so no due time is stepped over.
 */
export function dueTimes(
  specs: readonly CronSpec[],
  zone: string | undefined,
  from: number,
  to: number,
  limit: number,
) {
  const out: number[] = [];
  if (specs.length === 0 || limit <= 0) return out;
  for (let at = Math.floor(from / MINUTE) * MINUTE + MINUTE; at <= to && out.length < limit; ) {
    const parts = partsOf(at, zone);
    if (specs.some((spec) => matches(spec, parts))) out.push(at);
    const next = at + (60 - parts.minute) * MINUTE;
    const landed = specs.some((spec) => inHour(spec, parts)) ? null : partsOf(next, zone);
    at = landed?.minute === 0 && landed.hour === (parts.hour + 1) % 24 ? next : at + MINUTE;
  }
  return out;
}

// ── In words ─────────────────────────────────────────────────────────────────

/** "every 15 minutes", "every hour", "every 2 hours", "every 30 seconds". */
export function everyWords(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return seconds === 1 ? "every second" : `every ${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes % 1440 === 0) return minutes === 1440 ? "every day" : `every ${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? "every hour" : `every ${minutes / 60} hours`;
  return minutes === 1 ? "every minute" : `every ${minutes} minutes`;
}

const DAY_NAMES = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const two = (n: number) => String(n).padStart(2, "0");

/** One launchd calendar dictionary in words: "daily at 02:00", "Sundays at 02:30", "hourly at :30". */
export function calendarWords(entry: Record<string, unknown>): string {
  const n = (key: string) => (typeof entry[key] === "number" ? (entry[key] as number) : undefined);
  const minute = n("Minute");
  const hour = n("Hour");
  const day = n("Day");
  const weekday = n("Weekday");
  const month = n("Month");
  const time =
    hour !== undefined && minute !== undefined
      ? `at ${two(hour)}:${two(minute)}`
      : hour !== undefined
        ? `every minute from ${two(hour)}:00 to ${two(hour)}:59`
        : minute !== undefined
          ? `hourly at :${two(minute)}`
          : "every minute";
  const days: string[] = [];
  if (weekday !== undefined) days.push(DAY_NAMES[weekday % 7] ?? `weekday ${weekday}`);
  if (day !== undefined) days.push(`on day ${day}`);
  if (month !== undefined) days.push(`in ${MONTH_NAMES[month - 1] ?? `month ${month}`}`);
  if (days.length === 0) return hour !== undefined && minute !== undefined ? `daily ${time}` : time;
  return `${days.join(", ")} ${time}`;
}

/** StartCalendarInterval in words, one dictionary or several. */
export function calendarCadence(value: unknown): string {
  const entries = (Array.isArray(value) ? value : [value]).filter(
    (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null,
  );
  if (entries.length === 0) return "on a calendar";
  return entries.map(calendarWords).join("; ");
}
