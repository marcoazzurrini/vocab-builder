import { describe, expect, it } from "bun:test";
import { dayEnd, dayStart, studyDay } from "./day";

describe("the study day", () => {
  it("is the calendar day when the rollover is midnight", () => {
    const nineAm = new Date("2026-08-10T09:00:00");
    expect(dayStart(nineAm, 0)).toEqual(new Date("2026-08-10T00:00:00"));
    expect(dayEnd(nineAm, 0)).toEqual(new Date("2026-08-10T23:59:59.999"));
  });

  it("has not rolled over at one in the morning when the day starts at four", () => {
    // The whole point: a 00:05 sitting is still yesterday's sitting.
    const oneAm = new Date("2026-08-11T01:00:00");
    expect(dayStart(oneAm, 4)).toEqual(new Date("2026-08-10T04:00:00"));
    expect(dayEnd(oneAm, 4)).toEqual(new Date("2026-08-11T03:59:59.999"));
  });

  it("has rolled over by breakfast", () => {
    const nineAm = new Date("2026-08-11T09:00:00");
    expect(dayStart(nineAm, 4)).toEqual(new Date("2026-08-11T04:00:00"));
    expect(dayEnd(nineAm, 4)).toEqual(new Date("2026-08-12T03:59:59.999"));
  });

  it("treats the rollover moment itself as the new day", () => {
    const fourSharp = new Date("2026-08-11T04:00:00");
    expect(dayStart(fourSharp, 4)).toEqual(new Date("2026-08-11T04:00:00"));
  });

  it("rejects invalid dates without mutating them", () => {
    for (const boundary of [studyDay, dayStart, dayEnd]) {
      const invalid = new Date(Number.NaN);
      expect(() => boundary(invalid, 4)).toThrow(RangeError);
      expect(Number.isNaN(invalid.getTime())).toBe(true);
    }
  });

  it("rejects invalid rollover hours without mutating the input", () => {
    const now = new Date("2026-08-11T09:00:00Z");
    const timestamp = now.getTime();
    for (const hour of [-1, 24, 1.5, Number.NaN, Infinity, -Infinity]) {
      for (const boundary of [studyDay, dayStart, dayEnd]) {
        expect(() => boundary(now, hour)).toThrow(RangeError);
        expect(now.getTime()).toBe(timestamp);
      }
    }
  });
});

type CalendarCase = { hour: number; boundaries: string[] };

function transitionCases(
  dates: [string, string, string],
  offsets: [string, string],
  rollovers: [number, string][],
): CalendarCase[] {
  return rollovers.map(([hour, transition]) => {
    const clock = `${String(hour).padStart(2, "0")}:00:00`;
    return {
      hour,
      boundaries: [
        `${dates[0]}T${clock}${offsets[0]}`,
        `${dates[1]}T${transition}`,
        `${dates[2]}T${clock}${offsets[1]}`,
      ],
    };
  });
}

const calendars: { timezone: string; cases: CalendarCase[] }[] = [
  {
    timezone: "Atlantic/Azores",
    cases: [
      {
        hour: 4,
        boundaries: [
          "1916-06-16T04:00:00-02:00",
          "1916-06-17T04:00:00-02:00",
          "1916-06-18T04:00:00-01:00",
        ],
      },
      {
        hour: 23,
        boundaries: [
          "1916-06-16T23:00:00-02:00",
          "1916-06-18T00:00:00-01:00",
          "1916-06-18T23:00:00-01:00",
        ],
      },
    ], // A late-evening gap must not move unrelated morning rollovers.
  },
  {
    timezone: "Antarctica/Casey",
    cases: [
      {
        hour: 0,
        boundaries: [
          "2010-03-04T00:00:00+11:00",
          "2010-03-05T00:00:00+11:00",
          "2010-03-06T00:00:00+08:00",
        ],
      },
    ], // The three-hour rollback crosses midnight into the previous civil date.
  },
  {
    timezone: "Pacific/Apia",
    cases: [0, 4, 23].map((hour) => {
      const clock = `${String(hour).padStart(2, "0")}:00:00`;
      return {
        hour,
        boundaries: [
          `2011-12-29T${clock}-10:00`,
          `2011-12-31T${clock}+14:00`,
          `2012-01-01T${clock}+14:00`,
        ],
      };
    }),
  },
  {
    timezone: "Australia/Lord_Howe",
    cases: [
      {
        hour: 2,
        boundaries: [
          "2026-10-03T02:00:00+10:30",
          "2026-10-04T02:30:00+11:00",
          "2026-10-05T02:00:00+11:00",
        ],
      },
      {
        hour: 2,
        boundaries: [
          "2026-04-04T02:00:00+11:00",
          "2026-04-05T02:00:00+10:30",
          "2026-04-06T02:00:00+10:30",
        ],
      },
    ],
  },
  {
    timezone: "Europe/Rome",
    cases: [
      ...transitionCases(
        ["2026-03-28", "2026-03-29", "2026-03-30"],
        ["+01:00", "+02:00"],
        [
          [0, "00:00:00+01:00"],
          [2, "03:00:00+02:00"], // The missing 02:00 shifts forward, only on March 29.
          [4, "04:00:00+02:00"],
          [23, "23:00:00+02:00"],
        ],
      ),
      ...transitionCases(
        ["2026-10-24", "2026-10-25", "2026-10-26"],
        ["+02:00", "+01:00"],
        [
          [0, "00:00:00+02:00"],
          [2, "02:00:00+02:00"], // The earlier occurrence of the repeated hour.
          [4, "04:00:00+01:00"],
          [23, "23:00:00+01:00"],
        ],
      ),
    ],
  },
  {
    timezone: "America/New_York",
    cases: [
      ...transitionCases(
        ["2026-03-07", "2026-03-08", "2026-03-09"],
        ["-05:00", "-04:00"],
        [
          [0, "00:00:00-05:00"],
          [2, "03:00:00-04:00"],
          [4, "04:00:00-04:00"],
          [23, "23:00:00-04:00"],
        ],
      ),
      ...transitionCases(
        ["2026-10-31", "2026-11-01", "2026-11-02"],
        ["-04:00", "-05:00"],
        [
          [0, "00:00:00-04:00"],
          [1, "01:00:00-04:00"],
          [4, "04:00:00-05:00"],
          [23, "23:00:00-05:00"],
        ],
      ),
    ],
  },
  ...(
    [
      ["UTC", "+00:00"],
      ["Asia/Kolkata", "+05:30"],
    ] as const
  ).map(([timezone, offset]) => ({
    timezone,
    cases: [
      ["2026-03-28", "2026-03-29", "2026-03-30"],
      ["2026-10-24", "2026-10-25", "2026-10-26"],
      ["2026-12-31", "2027-01-01", "2027-01-02"],
      ["2028-02-28", "2028-02-29", "2028-03-01"],
      ...(timezone === "UTC" ? [["0099-12-31", "0100-01-01", "0100-01-02"]] : []),
    ].flatMap((dates) =>
      [0, 4, 23].map((hour) => ({
        hour,
        boundaries: dates.map((date) => `${date}T${String(hour).padStart(2, "0")}:00:00${offset}`),
      })),
    ),
  })),
];

describe("device-local calendar boundaries", () => {
  for (const { timezone, cases } of calendars) {
    it(`uses independent calendar rollovers in ${timezone}`, () => {
      // Each subprocess owns its TZ. Never change the test runner's global timezone.
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          "--eval",
          `
          import assert from "node:assert/strict";
          import { studyDay, dayStart, dayEnd } from ${JSON.stringify(new URL("./day.ts", import.meta.url).href)};
          const cases = ${JSON.stringify(cases)};
          for (const { hour, boundaries } of cases) {
            for (let i = 0; i < boundaries.length - 1; i++) {
              const start = new Date(boundaries[i]).getTime();
              const nextStart = new Date(boundaries[i + 1]).getTime();
              // Include both occurrences of an ambiguous hour, plus exact edges.
              const samples = [start, start + 1, start + 3600000, start + 5400000, start + 9000000,
                Math.floor((start + nextStart) / 2), nextStart - 1];
              for (const timestamp of samples) {
                const now = new Date(timestamp);
                const actual = studyDay(now, hour);
                const context = JSON.stringify({ timezone: process.env.TZ, hour, now });
                assert.equal(actual.start.getTime(), start, context);
                assert.equal(actual.nextStart.getTime(), nextStart, context);
                assert.equal(dayStart(now, hour).getTime(), start, context);
                assert.equal(dayEnd(now, hour).getTime(), nextStart - 1, context);
                assert.ok(actual.start <= now && now < actual.nextStart, context);
                assert.equal(now.getTime(), timestamp, context);
                assert.notEqual(actual.start, now);
                assert.notEqual(actual.nextStart, now);
                assert.notEqual(actual.start, actual.nextStart);
                actual.start.setTime(0);
                actual.nextStart.setTime(1);
                assert.equal(now.getTime(), timestamp);
                assert.equal(studyDay(now, hour).start.getTime(), start);
              }
              assert.equal(studyDay(new Date(start - 1), hour).nextStart.getTime(), start);
              assert.equal(dayEnd(new Date(start - 1), hour).getTime(), start - 1);
              assert.equal(studyDay(new Date(nextStart), hour).start.getTime(), nextStart);
            }
          }
        `,
        ],
        env: { ...process.env, TZ: timezone },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
    });
  }
});
