import { describe, expect, it } from "vitest";
import {
  addBlock,
  blockTemp,
  copyDay,
  countChangedDays,
  countOtherUses,
  emptyWeek,
  formatDuration,
  formatHm,
  formatTime,
  heightPercent,
  mainSide,
  moveBlock,
  newBlockRange,
  parseTime,
  removeBlock,
  resizeEnd,
  resizeStart,
  sameItem,
  setBlockTemp,
  snapTemp,
  tempRatio,
  toDraftWeek,
  toUpdatePayload,
  updateBlock,
  validateBlock,
  weekIsValid,
  type DraftBlock,
  type ScheduleItem,
  type ValidationContext,
} from "./schedule-blocks";

const H = 3600;
const block = (from: number, to: number, data: DraftBlock["data"] = {}, key = 1): DraftBlock => ({
  key,
  from,
  to,
  data,
});
const ctx: ValidationContext = {
  climateMode: "auto",
  comfort: { heat: 21, cool: 24 },
  minTemp: 5,
  maxTemp: 35,
};

describe("time conversion", () => {
  it("parses times with seconds", () => {
    expect(parseTime("06:30:15")).toBe(23415);
  });
  it("parses end of day in both forms HA returns", () => {
    expect(parseTime("24:00:00")).toBe(86400);
    expect(parseTime("23:59:59.999999")).toBe(86400);
  });
  it("formats back without losing seconds or end of day", () => {
    expect(formatTime(23415)).toBe("06:30:15");
    expect(formatTime(86400)).toBe("24:00:00");
    expect(formatHm(86400)).toBe("24:00");
    expect(formatHm(23415)).toBe("06:30");
  });
  it("formats durations", () => {
    expect(formatDuration(90 * 60)).toBe("1 h 30 min");
    expect(formatDuration(2 * H)).toBe("2 h");
    expect(formatDuration(15 * 60)).toBe("15 min");
  });
});

describe("draft and payload", () => {
  const item: ScheduleItem = {
    id: "camera",
    name: "Camera",
    icon: "mdi:bed",
    monday: [
      { from: "17:00:00", to: "24:00:00", data: { heat_temperature: 21, other_key: "keep" } },
      { from: "06:30:15", to: "08:00:00" },
    ],
  };

  it("sorts blocks and fills missing days", () => {
    const week = toDraftWeek(item);
    expect(week.monday.map((b) => b.from)).toEqual([23415, 17 * H]);
    expect(week.tuesday).toEqual([]);
  });

  it("gives every block a distinct key", () => {
    const keys = toDraftWeek(item).monday.map((b) => b.key);
    expect(new Set(keys).size).toBe(2);
  });

  it("round-trips an untouched helper exactly", () => {
    const payload = toUpdatePayload("Camera", "mdi:bed", toDraftWeek(item));
    expect(payload).toEqual({
      name: "Camera",
      icon: "mdi:bed",
      monday: [
        { from: "06:30:15", to: "08:00:00" },
        { from: "17:00:00", to: "24:00:00", data: { heat_temperature: 21, other_key: "keep" } },
      ],
      tuesday: [],
      wednesday: [],
      thursday: [],
      friday: [],
      saturday: [],
      sunday: [],
    });
  });

  it("omits the icon when there is none", () => {
    expect(toUpdatePayload("X", undefined, emptyWeek())).not.toHaveProperty("icon");
  });
});

describe("temperatures", () => {
  it("reads split keys", () => {
    const data = { heat_temperature: 20, cool_temperature: 25 };
    expect(blockTemp(data, "heat")).toBe(20);
    expect(blockTemp(data, "cool")).toBe(25);
  });
  it("reads the old key for both sides", () => {
    expect(blockTemp({ temperature: 22 }, "heat")).toBe(22);
    expect(blockTemp({ temperature: 22 }, "cool")).toBe(22);
  });
  it("ignores the old key when a split key exists, like the backend", () => {
    const data = { temperature: 22, heat_temperature: 20 };
    expect(blockTemp(data, "heat")).toBe(20);
    expect(blockTemp(data, "cool")).toBeNull();
  });
  it("treats unusable values as comfort", () => {
    expect(blockTemp({ heat_temperature: "abc" }, "heat")).toBeNull();
    expect(blockTemp({}, "heat")).toBeNull();
  });
  it("converts the old key when a side is edited, keeping the other side and foreign keys", () => {
    const next = setBlockTemp({ temperature: 22, other_key: 1 }, "heat", 20);
    expect(next).toEqual({ heat_temperature: 20, cool_temperature: 22, other_key: 1 });
  });
  it("clears a side with null", () => {
    expect(setBlockTemp({ heat_temperature: 20, cool_temperature: 24 }, "heat", null)).toEqual({
      cool_temperature: 24,
    });
  });
  it("picks the main side from the climate mode", () => {
    expect(mainSide("auto")).toBe("heat");
    expect(mainSide("heat_only")).toBe("heat");
    expect(mainSide("cool_only")).toBe("cool");
  });
  it("snaps and clamps dragged temperatures", () => {
    expect(snapTemp(21.3, 0.5, 14, 26)).toBe(21.5);
    expect(snapTemp(30, 0.5, 14, 26)).toBe(26);
    expect(snapTemp(21.3, 1, 14, 26)).toBe(21);
  });
  it("maps height on the scale, with cooling inverted", () => {
    expect(tempRatio(20, "heat", [14, 26])).toBe(0.5);
    expect(tempRatio(20, "cool", [18, 30])).toBeCloseTo(0.8333, 3);
    expect(heightPercent(14, "heat", [14, 26])).toBe(12);
    expect(heightPercent(26, "heat", [14, 26])).toBe(92);
    expect(heightPercent(50, "heat", [14, 26])).toBe(92);
  });
});

describe("gesture limits", () => {
  const prev = block(6 * H, 8 * H, {}, 1);
  const cur = block(10 * H, 12 * H, {}, 2);
  const next = block(14 * H, 16 * H, {}, 3);
  const day = [prev, cur, next];

  it("snaps a resized start to 15 minutes", () => {
    expect(resizeStart(cur, day, 9 * H + 7 * 60)).toBe(9 * H);
    expect(resizeStart(cur, day, 9 * H + 8 * 60)).toBe(9 * H + 15 * 60);
  });
  it("stops the start at the previous block", () => {
    expect(resizeStart(cur, day, 7 * H)).toBe(8 * H);
  });
  it("keeps 15 minutes of duration", () => {
    expect(resizeStart(cur, day, 13 * H)).toBe(12 * H - 15 * 60);
    expect(resizeEnd(cur, day, 9 * H)).toBe(10 * H + 15 * 60);
  });
  it("stops the end at the next block and at midnight", () => {
    expect(resizeEnd(cur, day, 15 * H)).toBe(14 * H);
    expect(resizeEnd(next, day, 25 * H)).toBe(86400);
  });
  it("moves within the gap, keeping the duration", () => {
    expect(moveBlock(cur, day, 11 * H)).toEqual({ from: 11 * H, to: 13 * H });
    expect(moveBlock(cur, day, 13 * H)).toEqual({ from: 12 * H, to: 14 * H });
    expect(moveBlock(cur, day, 7 * H)).toEqual({ from: 8 * H, to: 10 * H });
  });
  it("leaves the block alone when the gap is too small", () => {
    const tight = block(8 * H, 14 * H, {}, 2);
    const crowded = [prev, tight, next];
    expect(moveBlock(tight, crowded, 9 * H)).toEqual({ from: 8 * H, to: 14 * H });
  });
});

describe("new blocks", () => {
  const day = [block(6.5 * H, 8 * H, {}, 1), block(15 * H, 16 * H, {}, 2)];
  it("starts at the previous half hour and lasts one hour", () => {
    expect(newBlockRange(day, 10 * H + 40 * 60)).toEqual({ from: 10.5 * H, to: 11.5 * H });
  });
  it("is shortened by the next block", () => {
    expect(newBlockRange(day, 14 * H + 40 * 60)).toEqual({ from: 14.5 * H, to: 15 * H });
  });
  it("stops at midnight", () => {
    expect(newBlockRange(day, 23 * H + 50 * 60)).toEqual({ from: 23.5 * H, to: 86400 });
  });
  it("returns null inside a block or when under 15 minutes remain", () => {
    expect(newBlockRange(day, 7 * H)).toBeNull();
    const tight = [block(14.5 * H + 5 * 60, 16 * H, {}, 1)];
    expect(newBlockRange(tight, 14.5 * H)).toBeNull();
  });
});

describe("week operations", () => {
  it("adds and sorts, returning the new key", () => {
    let week = emptyWeek();
    week = { ...week, monday: [block(10 * H, 11 * H, {}, 1)] };
    const added = addBlock(week, "monday", 6 * H, 7 * H);
    expect(added.week.monday.map((b) => b.from)).toEqual([6 * H, 10 * H]);
    expect(added.week.monday[0].key).toBe(added.key);
  });
  it("updates and re-sorts", () => {
    const week = {
      ...emptyWeek(),
      monday: [block(6 * H, 7 * H, {}, 1), block(10 * H, 11 * H, {}, 2)],
    };
    const next = updateBlock(week, "monday", 1, { from: 12 * H, to: 13 * H });
    expect(next.monday.map((b) => b.key)).toEqual([2, 1]);
  });
  it("removes", () => {
    const week = { ...emptyWeek(), monday: [block(6 * H, 7 * H, {}, 1)] };
    expect(removeBlock(week, "monday", 1).monday).toEqual([]);
  });
  it("copies a day with fresh keys and independent data", () => {
    const week = { ...emptyWeek(), monday: [block(6 * H, 7 * H, { heat_temperature: 20 }, 1)] };
    const next = copyDay(week, "monday", ["tuesday", "friday"]);
    expect(next.tuesday[0].from).toBe(6 * H);
    expect(next.tuesday[0].key).not.toBe(1);
    expect(next.tuesday[0].key).not.toBe(next.friday[0].key);
    expect(next.tuesday[0].data).not.toBe(week.monday[0].data);
    expect(next.tuesday[0].data).toEqual({ heat_temperature: 20 });
  });
  it("counts changed days, ignoring keys", () => {
    const a = { ...emptyWeek(), monday: [block(6 * H, 7 * H, {}, 1)] };
    const b = { ...emptyWeek(), monday: [block(6 * H, 7 * H, {}, 99)] };
    expect(countChangedDays(a, b)).toBe(0);
    expect(countChangedDays(a, { ...b, sunday: [block(1, 900, {}, 5)] })).toBe(1);
  });
  it("compares raw items", () => {
    const item: ScheduleItem = { id: "a", name: "A", monday: [] };
    expect(sameItem(item, { ...item })).toBe(true);
    expect(sameItem(item, { ...item, name: "B" })).toBe(false);
  });
});

describe("validation", () => {
  it("accepts a valid block", () => {
    const b = block(6 * H, 7 * H, { heat_temperature: 20, cool_temperature: 25 });
    expect(validateBlock(b, [b], ctx)).toEqual([]);
  });
  it("flags start not before end", () => {
    const b = block(7 * H, 7 * H);
    expect(validateBlock(b, [b], ctx)).toEqual([{ code: "time_order" }]);
  });
  it("flags overlaps and names the other block", () => {
    const a = block(6 * H, 8 * H, {}, 1);
    const b = block(7 * H, 9 * H, {}, 2);
    expect(validateBlock(b, [a, b], ctx)).toEqual([{ code: "overlap", from: 6 * H, to: 8 * H }]);
  });
  it("allows touching blocks", () => {
    const a = block(6 * H, 7 * H, {}, 1);
    const b = block(7 * H, 8 * H, {}, 2);
    expect(validateBlock(b, [a, b], ctx)).toEqual([]);
  });
  it("flags existing out-of-range and non-numeric values", () => {
    const b = block(6 * H, 7 * H, { heat_temperature: 110 });
    expect(validateBlock(b, [b], ctx)).toEqual([{ code: "temp_range", value: "110" }]);
    const c = block(6 * H, 7 * H, { temperature: "abc" });
    expect(validateBlock(c, [c], ctx)).toEqual([{ code: "temp_range", value: "abc" }]);
  });
  it("flags heating above effective cooling only in auto", () => {
    const b = block(6 * H, 7 * H, { heat_temperature: 25 });
    expect(validateBlock(b, [b], ctx)).toEqual([{ code: "heat_above_cool" }]);
    expect(validateBlock(b, [b], { ...ctx, climateMode: "heat_only" })).toEqual([]);
  });
  it("checks a whole week", () => {
    const good = { ...emptyWeek(), monday: [block(6 * H, 7 * H)] };
    expect(weekIsValid(good, ctx)).toBe(true);
    expect(weekIsValid({ ...good, sunday: [block(7 * H, 6 * H)] }, ctx)).toBe(false);
  });
});

describe("countOtherUses", () => {
  const rooms = {
    camera: { schedules: [{ entity_id: "schedule.a" }] },
    salotto: { schedules: [{ entity_id: "schedule.a" }], cover_schedules: [] },
    studio: { schedules: [], cover_schedules: [{ entity_id: "schedule.a" }] },
  };
  it("counts other rooms and every cover use, not this room's own temperature use", () => {
    expect(countOtherUses(rooms, "camera", "schedule.a")).toBe(2);
  });
  it("includes this room's cover use", () => {
    const own = { camera: { schedules: [], cover_schedules: [{ entity_id: "schedule.a" }] } };
    expect(countOtherUses(own, "camera", "schedule.a")).toBe(1);
  });
  it("returns 0 when unused elsewhere", () => {
    expect(countOtherUses(rooms, "camera", "schedule.b")).toBe(0);
  });
});
