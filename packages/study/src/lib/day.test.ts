import { describe, expect, it } from "vitest";
import { dayEnd, dayStart } from "./day";

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
});
