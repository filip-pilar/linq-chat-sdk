import { describe, expect, it } from "vitest";

import { compareLinqTimestamps, parseLinqTimestamp } from "../src/timestamps.js";

describe("Linq RFC3339 timestamps", () => {
  it.each([
    ["2028-02-29T23:59:59Z", "2028-02-29T23:59:59.000Z"],
    ["2026-08-01t12:00:00z", "2026-08-01T12:00:00.000Z"],
    ["2026-08-01T12:00:00.1Z", "2026-08-01T12:00:00.100Z"],
    ["2026-08-01T12:00:00.123456789012Z", "2026-08-01T12:00:00.123Z"],
    ["2026-08-01T00:00:00+14:01", "2026-07-31T09:59:00.000Z"],
    ["2026-08-01T00:00:00-14:01", "2026-08-01T14:01:00.000Z"],
  ])("accepts RFC3339 instant %s", (value, iso) => {
    const timestamp = parseLinqTimestamp(value);

    expect(timestamp).toMatchObject({ raw: value });
    expect(timestamp?.date?.toISOString()).toBe(iso);
  });

  it.each([
    "2027-02-29T00:00:00Z",
    "2026-02-30T00:00:00Z",
    "2026-04-31T00:00:00Z",
    "2026-08-01T24:00:00Z",
    "2026-08-01T00:60:00Z",
    "2026-08-01T00:00:61Z",
    "2026-08-01T00:00:00+24:00",
    "2026-08-01T00:00:00+23:60",
    " 2026-08-01T00:00:00Z",
    "2026-08-01T00:00:00Z ",
    "2026-08-01 00:00:00Z",
    "2026-08-01T00:00:00",
    "2026-08-01",
    "not-a-date",
  ])("rejects invalid date-time %s", (value) => {
    expect(parseLinqTimestamp(value)).toBeNull();
  });

  it.each([undefined, null, 0, true, {}, []])("rejects malformed scalar %j", (value) => {
    expect(parseLinqTimestamp(value)).toBeNull();
  });

  it("retains schema-valid leap seconds losslessly without inventing a Date", () => {
    const utc = parseLinqTimestamp("2016-12-31T23:59:60.5Z");
    const offset = parseLinqTimestamp("2017-01-01T00:59:60.5+01:00");
    const before = parseLinqTimestamp("2016-12-31T23:59:59.999999999Z");
    const after = parseLinqTimestamp("2017-01-01T00:00:00Z");

    expect(utc).toMatchObject({ raw: "2016-12-31T23:59:60.5Z", date: null });
    expect(offset).toMatchObject({ raw: "2017-01-01T00:59:60.5+01:00", date: null });
    if (!utc || !offset || !before || !after) {
      throw new Error("Expected valid leap-second boundary timestamps");
    }
    expect(compareLinqTimestamps(utc, offset)).toBe(0);
    expect(compareLinqTimestamps(before, utc)).toBe(-1);
    expect(compareLinqTimestamps(utc, after)).toBe(-1);
    expect(parseLinqTimestamp("2016-12-30T23:59:60Z")).toBeNull();
  });

  it("compares the complete normalized instant and preserves exact-equality stability", () => {
    const earlier = parseLinqTimestamp("2026-08-01T12:00:00.123456780Z");
    const later = parseLinqTimestamp("2026-08-01T13:00:00.123456789+01:00");
    const equal = parseLinqTimestamp("2026-08-01T07:00:00.123456780-05:00");
    if (!earlier || !later || !equal) throw new Error("Expected valid timestamps");

    expect(compareLinqTimestamps(earlier, later)).toBe(-1);
    expect(compareLinqTimestamps(later, earlier)).toBe(1);
    expect(compareLinqTimestamps(earlier, equal)).toBe(0);
  });
});
