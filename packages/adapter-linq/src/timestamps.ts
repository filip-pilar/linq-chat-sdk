const RFC3339_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

/** One validated provider instant with exact comparison precision and a Chat SDK Date when possible. */
export interface LinqTimestamp {
  readonly raw: string;
  readonly date: Date | null;
  readonly comparisonSecond: bigint;
  readonly fraction: string;
}

/** Parse one RFC3339 provider timestamp without relying on JavaScript's permissive string parser. */
export function parseLinqTimestamp(value: unknown): LinqTimestamp | null {
  if (typeof value !== "string") return null;

  const match = RFC3339_TIMESTAMP.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInGregorianMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 60 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return null;
  }

  const localSecond = new Date(0);
  localSecond.setUTCFullYear(year, month - 1, day);
  localSecond.setUTCHours(hour, minute, Math.min(second, 59), 0);

  const offsetDirection = match[8] === "-" ? -1 : 1;
  const offsetSeconds = offsetDirection * (offsetHour * 60 + offsetMinute) * 60;
  const normalizedSecond = Math.trunc(localSecond.getTime() / 1_000) - offsetSeconds;

  if (!Number.isSafeInteger(normalizedSecond)) {
    return null;
  }

  if (second === 60 && !isPossibleLeapSecond(normalizedSecond)) {
    return null;
  }

  // Doubling ordinary seconds leaves one exact comparison slot for an RFC3339
  // leap second between `:59` and the following minute.
  const comparisonSecond = BigInt(normalizedSecond) * 2n + (second === 60 ? 1n : 0n);
  const date =
    second === 60
      ? null
      : new Date(normalizedSecond * 1_000 + Number((fraction.slice(0, 3) + "000").slice(0, 3)));

  if (date !== null && Number.isNaN(date.getTime())) {
    return null;
  }

  return Object.freeze({ raw: value, date, comparisonSecond, fraction });
}

/** Prefer a valid provider send time, then its required creation-time fallback. */
export function selectLinqMessageTimestamp(
  sentAt: unknown,
  createdAt: unknown,
): LinqTimestamp | null {
  return parseLinqTimestamp(sentAt) ?? parseLinqTimestamp(createdAt);
}

/** Compare complete provider instants, including arbitrary fractional precision. */
export function compareLinqTimestamps(left: LinqTimestamp, right: LinqTimestamp): number {
  if (left.comparisonSecond < right.comparisonSecond) return -1;
  if (left.comparisonSecond > right.comparisonSecond) return 1;

  const width = Math.max(left.fraction.length, right.fraction.length);
  for (let index = 0; index < width; index += 1) {
    const leftDigit = left.fraction.charCodeAt(index) || 48;
    const rightDigit = right.fraction.charCodeAt(index) || 48;
    if (leftDigit < rightDigit) return -1;
    if (leftDigit > rightDigit) return 1;
  }

  return 0;
}

function daysInGregorianMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }

  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

// RFC3339 permits a leap second only at the end of a UTC month in which one can occur.
// Whether an authority announced one for a particular future year is not knowable from syntax alone.
function isPossibleLeapSecond(normalizedSecondBeforeLeap: number): boolean {
  const normalized = new Date(normalizedSecondBeforeLeap * 1_000);
  return (
    normalized.getUTCHours() === 23 &&
    normalized.getUTCMinutes() === 59 &&
    normalized.getUTCSeconds() === 59 &&
    ((normalized.getUTCMonth() === 5 && normalized.getUTCDate() === 30) ||
      (normalized.getUTCMonth() === 11 && normalized.getUTCDate() === 31))
  );
}
