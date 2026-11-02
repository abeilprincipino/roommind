# Visual Schedule Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users create and edit a room's weekly temperature schedule from the RoomMind panel, on a timeline they operate by dragging.

**Architecture:** The panel calls Home Assistant's `schedule/*` WebSocket commands directly and stores everything in the existing `schedule.*` helpers, so the control engine does not change. Pure logic lives in `schedule-blocks.ts`, WebSocket calls in `schedule-api.ts`, gestures in `rs-schedule-timeline`, and the draft and saving in `rs-schedule-editor`.

**Tech Stack:** TypeScript, Lit 3, Vite, vitest (new, logic only), pytest for the one backend test.

**Spec:** `docs/superpowers/specs/2026-11-02-schedule-editor-design.md`. **Approved visual reference:** <https://claude.ai/artifact/GnUdp8ur5Dz3torb7UBxju> (version 2).

## Global Constraints

- Work on branch `roomscheduling`. Do not push.
- Commit messages: short, one line, type prefix (`feat:`, `fix:`, `docs:`, `chore:`), ending with a `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer.
- The control engine does not change. The only backend change in this plan is a test.
- The editor always writes `heat_temperature` and `cool_temperature`, never `temperature`.
- `schedule/update` replaces the entire helper: every payload contains `name`, `icon` when present, and all seven days, and preserves unrelated `data` keys.
- Block temperatures are in HA's display unit. Room `comfort_*` and `eco_*` values are in Celsius, so convert them with `toDisplay` before comparing or showing them.
- All panel strings go through `localize()`, with keys in all of `frontend/src/locales/{en,de,fr,it}.json`.
- Use HA CSS variables for surfaces and text. Heating derives from `--warning-color`, cooling from `#2196f3`.
- Frontend format: Prettier (`npx prettier --write src/`) before each commit. Run frontend commands from `frontend/`.
- `dev/check` does not work with a Windows venv. Use the commands given in each task.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `frontend/src/utils/schedule-blocks.ts` | Create | Pure logic: conversion, validation, gesture limits, copy, payload |
| `frontend/src/utils/schedule-blocks.test.ts` | Create | vitest tests for the above |
| `frontend/src/utils/schedule-api.ts` | Create | WebSocket calls |
| `frontend/src/components/rs-schedule-timeline.ts` | Create | Weekly grid and gestures, emits events only |
| `frontend/src/components/rs-schedule-editor.ts` | Create | Draft, block panel, day copy, saving, errors |
| `frontend/package.json`, `.github/workflows/ci.yml` | Modify | vitest and its CI step |
| `frontend/src/types/index.ts` | Modify | `HomeAssistant.user` |
| `frontend/src/locales/{en,de,fr,it}.json` | Modify | New strings |
| `frontend/src/components/rs-schedule-settings.ts` | Modify | Edit and New schedule buttons; status text fix |
| `frontend/src/components/rs-room-detail.ts` | Modify | Opens the editor, creates helpers, help text |
| `frontend/src/roommind-panel.ts` | Modify | Passes `.rooms` |
| `tests/utils/test_schedule_utils.py` | Modify | `find_active_block` with `time.max` |
| `README.md` | Modify | Describes the editor |

---

### Task 1: Pure schedule logic with tests

**Files:**
- Modify: `frontend/package.json`, `frontend/package-lock.json`, `.github/workflows/ci.yml`
- Create: `frontend/src/utils/schedule-blocks.ts`
- Test: `frontend/src/utils/schedule-blocks.test.ts`

**Interfaces:**
- Consumes: `ClimateMode` from `frontend/src/types/index.ts`.
- Produces: everything exported from `schedule-blocks.ts` below. Later tasks rely on these exact names.

- [ ] **Step 1: Install vitest and add the script**

Run from `frontend/`:

```bash
npm install --save-dev vitest
npm pkg set scripts.test="vitest run"
```

Add this step to `.github/workflows/ci.yml` right after the `Prettier check` step, at the same indentation:

```yaml
      - name: Unit tests
        working-directory: frontend
        run: npm test
```

- [ ] **Step 2: Write the failing tests**

Create `frontend/src/utils/schedule-blocks.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, cannot resolve `./schedule-blocks`.

- [ ] **Step 4: Write the implementation**

Create `frontend/src/utils/schedule-blocks.ts`:

```ts
/**
 * Pure logic for the schedule editor: no Lit and no Home Assistant calls.
 * Times are seconds from midnight (0–86400). Temperatures are in HA's display
 * unit, the unit schedule block data is written in.
 */
import type { ClimateMode } from "../types";

export const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export type TempSide = "heat" | "cool";
export type TempScale = [number, number];
export type BlockData = Record<string, boolean | string | number>;

export const DAY_SECONDS = 86400;
export const SNAP_SECONDS = 900;

/** Height scale of the timeline in °C, converted for °F systems by the caller. */
export const SCALE_CELSIUS: Record<TempSide, TempScale> = { heat: [14, 26], cool: [18, 30] };

export interface RawBlock {
  from: string;
  to: string;
  data?: BlockData;
}

/** A helper as `schedule/list` returns it. */
export type ScheduleItem = { id: string; name: string; icon?: string } & Partial<
  Record<Weekday, RawBlock[]>
>;

export interface DraftBlock {
  /** Stable identity for selection and keyed rendering. Never saved. */
  key: number;
  from: number;
  to: number;
  data: BlockData;
}
export type DraftWeek = Record<Weekday, DraftBlock[]>;
export type BlockPatch = Partial<Pick<DraftBlock, "from" | "to" | "data">>;

export interface Temps {
  heat: number;
  cool: number;
}

export interface ValidationContext {
  climateMode: ClimateMode;
  comfort: Temps;
  minTemp: number;
  maxTemp: number;
}

export type BlockProblem =
  | { code: "time_order" }
  | { code: "overlap"; from: number; to: number }
  | { code: "temp_range"; value: string }
  | { code: "heat_above_cool" };

const TEMP_FIELDS = ["temperature", "heat_temperature", "cool_temperature"];

let nextKey = 1;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const pad = (n: number) => String(n).padStart(2, "0");
const snap = (seconds: number) => Math.round(seconds / SNAP_SECONDS) * SNAP_SECONDS;
const byStart = (a: DraftBlock, b: DraftBlock) => a.from - b.from;

// ─── Time ────────────────────────────────────────────────────────

export function parseTime(raw: string): number {
  // schedule.get_schedule serializes the end of the day (time.max) this way over WebSocket.
  if (raw.startsWith("23:59:59.")) return DAY_SECONDS;
  const [h, m, s = "0"] = raw.split(":");
  return Number(h) * 3600 + Number(m) * 60 + Math.floor(Number(s));
}

export function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${pad(h)}:${pad(m)}:${pad(seconds % 60)}`;
}

export function formatHm(seconds: number): string {
  return formatTime(seconds).slice(0, 5);
}

export function formatDuration(seconds: number): string {
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h} h ${m} min`;
  return h ? `${h} h` : `${m} min`;
}

/** Localised weekday name, via Intl so it needs no locale keys. */
export function weekdayName(language: string, index: number, style: "short" | "long"): string {
  // 2024-01-01 was a Monday, so +index lands on the right weekday.
  const date = new Date(Date.UTC(2024, 0, 1 + index));
  return new Intl.DateTimeFormat(language, { weekday: style, timeZone: "UTC" }).format(date);
}

// ─── Draft and payload ───────────────────────────────────────────

export function emptyWeek(): DraftWeek {
  return {
    monday: [],
    tuesday: [],
    wednesday: [],
    thursday: [],
    friday: [],
    saturday: [],
    sunday: [],
  };
}

export function toDraftWeek(item: Partial<Record<Weekday, RawBlock[]>>): DraftWeek {
  const week = emptyWeek();
  for (const day of WEEKDAYS) {
    week[day] = (item[day] ?? [])
      .map((raw) => ({
        key: nextKey++,
        from: parseTime(raw.from),
        to: parseTime(raw.to),
        data: { ...(raw.data ?? {}) },
      }))
      .sort(byStart);
  }
  return week;
}

function toRawDay(blocks: DraftBlock[]): RawBlock[] {
  return [...blocks].sort(byStart).map((b) => ({
    from: formatTime(b.from),
    to: formatTime(b.to),
    ...(Object.keys(b.data).length ? { data: { ...b.data } } : {}),
  }));
}

/** Fields for `schedule/update`, which replaces the whole helper. */
export function toUpdatePayload(
  name: string,
  icon: string | undefined,
  week: DraftWeek,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { name };
  if (icon) payload.icon = icon;
  for (const day of WEEKDAYS) payload[day] = toRawDay(week[day]);
  return payload;
}

export function countChangedDays(a: DraftWeek, b: DraftWeek): number {
  return WEEKDAYS.filter(
    (day) => JSON.stringify(toRawDay(a[day])) !== JSON.stringify(toRawDay(b[day])),
  ).length;
}

export function sameItem(a: ScheduleItem, b: ScheduleItem): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ─── Temperatures ────────────────────────────────────────────────

export function mainSide(mode: ClimateMode): TempSide {
  return mode === "cool_only" ? "cool" : "heat";
}

/**
 * The block's own temperature for a side, or null when comfort applies. Mirrors
 * the backend's _schedule_targets_at_time: a split key makes `temperature` ignored.
 */
export function blockTemp(data: BlockData, side: TempSide): number | null {
  const hasSplit = data.heat_temperature != null || data.cool_temperature != null;
  const raw = hasSplit
    ? data[side === "heat" ? "heat_temperature" : "cool_temperature"]
    : data.temperature;
  if (raw == null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** New data with one side set, or cleared with null. Converts the old `temperature` key. */
export function setBlockTemp(data: BlockData, side: TempSide, value: number | null): BlockData {
  const next = { ...data };
  if (next.temperature != null) {
    if (next.heat_temperature == null && next.cool_temperature == null) {
      next.heat_temperature = next.temperature;
      next.cool_temperature = next.temperature;
    }
    delete next.temperature;
  }
  const key = side === "heat" ? "heat_temperature" : "cool_temperature";
  if (value == null) delete next[key];
  else next[key] = value;
  return next;
}

export function snapTemp(raw: number, step: number, lo: number, hi: number): number {
  return clamp(Math.round(raw / step) * step, lo, hi);
}

/** Position on the scale from 0 to 1. Cooling is inverted: a lower target is more demand. */
export function tempRatio(temp: number, side: TempSide, [lo, hi]: TempScale): number {
  return clamp(side === "heat" ? (temp - lo) / (hi - lo) : (hi - temp) / (hi - lo), 0, 1);
}

export function heightPercent(temp: number, side: TempSide, scale: TempScale): number {
  return 12 + tempRatio(temp, side, scale) * 80;
}

// ─── Gesture limits ──────────────────────────────────────────────

function bounds(block: DraftBlock, day: DraftBlock[]): { lo: number; hi: number } {
  const others = day.filter((o) => o.key !== block.key);
  return {
    lo: Math.max(0, ...others.filter((o) => o.to <= block.from).map((o) => o.to)),
    hi: Math.min(DAY_SECONDS, ...others.filter((o) => o.from >= block.to).map((o) => o.from)),
  };
}

export function resizeStart(block: DraftBlock, day: DraftBlock[], seconds: number): number {
  return clamp(snap(seconds), bounds(block, day).lo, block.to - SNAP_SECONDS);
}

export function resizeEnd(block: DraftBlock, day: DraftBlock[], seconds: number): number {
  return clamp(snap(seconds), block.from + SNAP_SECONDS, bounds(block, day).hi);
}

export function moveBlock(
  block: DraftBlock,
  day: DraftBlock[],
  seconds: number,
): { from: number; to: number } {
  const { lo, hi } = bounds(block, day);
  const length = block.to - block.from;
  if (hi - lo < length) return { from: block.from, to: block.to };
  const from = clamp(snap(seconds), lo, hi - length);
  return { from, to: from + length };
}

/** A new block from the previous half hour, one hour long, or null where none fits. */
export function newBlockRange(
  day: DraftBlock[],
  seconds: number,
): { from: number; to: number } | null {
  const from = Math.min(Math.floor(seconds / 1800) * 1800, DAY_SECONDS - 1800);
  if (day.some((b) => b.from <= from && from < b.to)) return null;
  const next = day.filter((b) => b.from > from).map((b) => b.from);
  const to = Math.min(from + 3600, DAY_SECONDS, ...next);
  return to - from < SNAP_SECONDS ? null : { from, to };
}

// ─── Week operations ─────────────────────────────────────────────

export function addBlock(
  week: DraftWeek,
  day: Weekday,
  from: number,
  to: number,
): { week: DraftWeek; key: number } {
  const key = nextKey++;
  const blocks = [...week[day], { key, from, to, data: {} }].sort(byStart);
  return { week: { ...week, [day]: blocks }, key };
}

export function updateBlock(
  week: DraftWeek,
  day: Weekday,
  key: number,
  patch: BlockPatch,
): DraftWeek {
  const blocks = week[day].map((b) => (b.key === key ? { ...b, ...patch } : b)).sort(byStart);
  return { ...week, [day]: blocks };
}

export function removeBlock(week: DraftWeek, day: Weekday, key: number): DraftWeek {
  return { ...week, [day]: week[day].filter((b) => b.key !== key) };
}

export function copyDay(week: DraftWeek, source: Weekday, targets: Weekday[]): DraftWeek {
  const next = { ...week };
  for (const target of targets) {
    next[target] = week[source].map((b) => ({ ...b, key: nextKey++, data: { ...b.data } }));
  }
  return next;
}

// ─── Validation ──────────────────────────────────────────────────

export function validateBlock(
  block: DraftBlock,
  day: DraftBlock[],
  ctx: ValidationContext,
): BlockProblem[] {
  const problems: BlockProblem[] = [];
  if (block.from >= block.to) problems.push({ code: "time_order" });
  const other = day.find((o) => o.key !== block.key && o.from < block.to && block.from < o.to);
  if (other) problems.push({ code: "overlap", from: other.from, to: other.to });
  for (const field of TEMP_FIELDS) {
    const raw = block.data[field];
    if (raw == null) continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < ctx.minTemp || value > ctx.maxTemp) {
      problems.push({ code: "temp_range", value: String(raw) });
    }
  }
  // An out-of-range value is already reported: comparing it against the other side adds only noise.
  if (ctx.climateMode === "auto" && !problems.some((p) => p.code === "temp_range")) {
    const heat = blockTemp(block.data, "heat") ?? ctx.comfort.heat;
    const cool = blockTemp(block.data, "cool") ?? ctx.comfort.cool;
    if (heat > cool) problems.push({ code: "heat_above_cool" });
  }
  return problems;
}

export function weekIsValid(week: DraftWeek, ctx: ValidationContext): boolean {
  return WEEKDAYS.every((day) =>
    week[day].every((block) => validateBlock(block, week[day], ctx).length === 0),
  );
}

// ─── Helper usage ────────────────────────────────────────────────

/** Uses of a helper besides this room's own temperature schedule. */
export function countOtherUses(
  rooms: Record<
    string,
    { schedules?: { entity_id: string }[]; cover_schedules?: { entity_id: string }[] }
  >,
  areaId: string,
  entityId: string,
): number {
  let uses = 0;
  for (const [id, room] of Object.entries(rooms)) {
    if (id !== areaId && room.schedules?.some((s) => s.entity_id === entityId)) uses++;
    if (room.cover_schedules?.some((s) => s.entity_id === entityId)) uses++;
  }
  return uses;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, all tests green.

- [ ] **Step 6: Run the type check and lint**

Run: `npx prettier --write src/utils/schedule-blocks.ts src/utils/schedule-blocks.test.ts && npx tsc --noEmit && npx eslint src/`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/package.json frontend/package-lock.json .github/workflows/ci.yml frontend/src/utils/schedule-blocks.ts frontend/src/utils/schedule-blocks.test.ts
git commit -m "feat: add schedule editor block logic with vitest" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Backend pin and status text fix

**Files:**
- Test: `tests/utils/test_schedule_utils.py`
- Modify: `frontend/src/components/rs-schedule-settings.ts:527-535`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing used later.

- [ ] **Step 1: Prepare the Python environment if needed**

Run from the repo root:

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements-dev.txt
```

Skip this if `.venv` already works.

- [ ] **Step 2: Add the test**

In `tests/utils/test_schedule_utils.py`, add this import after `from datetime import UTC, datetime`:

```python
from datetime import time as dt_time
```

Add this class right before the class containing `_SUNDAY_BLOCK`, using the module's existing `_utc_ts` and `_ha_time_zone` helpers:

```python
class TestFindActiveBlockEndOfDay:
    """schedule.get_schedule returns time.max for a block ending at midnight."""

    _MONDAY_EVENING = {"monday": [{"from": dt_time(20, 0), "to": dt_time.max, "data": {"temperature": 21.0}}]}

    def test_block_ending_at_midnight_is_active_until_the_end_of_the_day(self):
        ts = _utc_ts(2024, 7, 8, 23, 59)  # a Monday
        with _ha_time_zone("UTC"):
            block = find_active_block(self._MONDAY_EVENING, ts)
        assert block is not None
        assert block["temperature"] == 21.0

    def test_block_ending_at_midnight_does_not_leak_into_the_next_day(self):
        ts = _utc_ts(2024, 7, 9, 0, 0)  # the Tuesday after
        with _ha_time_zone("UTC"):
            assert find_active_block(self._MONDAY_EVENING, ts) is None
```

- [ ] **Step 3: Run the test**

Run: `.venv/Scripts/python -m pytest tests/utils/test_schedule_utils.py -k EndOfDay -v`
Expected: PASS. This pins existing behavior. If it fails, stop and report it: the engine would then need a fix the spec did not plan for.

- [ ] **Step 4: Fix the status text**

In `frontend/src/components/rs-schedule-settings.ts`, inside `_getStatusText`, replace:

```ts
      if (heatTemp != null || coolTemp != null) {
        // heatTemp/coolTemp are entity attributes (already display units); the
```

with:

```ts
      if ((heatTemp != null || coolTemp != null) && this.climateMode !== "auto") {
        // A single-mode room acts on one side only, so show only that side.
        const own = this.climateMode === "cool_only" ? coolTemp : heatTemp;
        if (own != null) {
          return localize("schedule.from_schedule", l, {
            temp: String(own),
            unit: tempUnit(this.hass),
          });
        }
      } else if (heatTemp != null || coolTemp != null) {
        // heatTemp/coolTemp are entity attributes (already display units); the
```

When `own` is null, execution falls through to the existing `schedule.fallback` return, which already shows the comfort value of the room's side.

- [ ] **Step 5: Check**

Run from the repo root: `.venv/Scripts/ruff check tests/ && .venv/Scripts/ruff format --check tests/`
Run from `frontend/`: `npx prettier --write src/components/rs-schedule-settings.ts && npx tsc --noEmit`
Expected: no errors. If ruff format reports the test file, run `.venv/Scripts/ruff format tests/utils/test_schedule_utils.py`.

- [ ] **Step 6: Commit**

```bash
git add tests/utils/test_schedule_utils.py frontend/src/components/rs-schedule-settings.ts
git commit -m "fix: show one target in single-mode rooms and pin midnight block ends" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: WebSocket calls, types and strings

**Files:**
- Create: `frontend/src/utils/schedule-api.ts`
- Modify: `frontend/src/types/index.ts:220-232`
- Modify: `frontend/src/locales/en.json`, `de.json`, `fr.json`, `it.json` (after the `schedule.eco_detail` line)

**Interfaces:**
- Consumes: `ScheduleItem`, `Weekday`, `WEEKDAYS` from `schedule-blocks.ts`.
- Produces:
  - `loadSchedule(hass, entityId): Promise<{ item: ScheduleItem; editable: boolean }>`
  - `fetchSchedule(hass, id): Promise<ScheduleItem>`
  - `createSchedule(hass, name): Promise<ScheduleItem>`
  - `updateSchedule(hass, id, payload): Promise<ScheduleItem>`
  - `findScheduleEntityId(hass, id): Promise<string>`
  - `isNotFound(err): boolean`
  - `HomeAssistant.user?: { is_admin: boolean }`
  - The locale keys below.

- [ ] **Step 1: Add the user to the HA type**

In `frontend/src/types/index.ts`, inside `interface HomeAssistant`, after `language: string;`, add:

```ts
  user?: { is_admin: boolean };
```

- [ ] **Step 2: Create the API module**

Create `frontend/src/utils/schedule-api.ts`:

```ts
/** Home Assistant's WebSocket commands for schedule helpers. */
import type { HomeAssistant } from "../types";
import type { ScheduleItem } from "./schedule-blocks";

interface RegistryEntry {
  entity_id: string;
  platform: string;
  unique_id: string;
}

export class ScheduleNotFoundError extends Error {}

export function isNotFound(err: unknown): boolean {
  return (
    err instanceof ScheduleNotFoundError || (err as { code?: string } | null)?.code === "not_found"
  );
}

export async function fetchSchedule(hass: HomeAssistant, id: string): Promise<ScheduleItem> {
  const items = await hass.callWS<ScheduleItem[]>({ type: "schedule/list" });
  const item = items.find((i) => i.id === id);
  if (!item) throw new ScheduleNotFoundError(id);
  return item;
}

/** YAML helpers are not in `schedule/list`, so they are read through the entity service. */
export async function loadSchedule(
  hass: HomeAssistant,
  entityId: string,
): Promise<{ item: ScheduleItem; editable: boolean }> {
  const attrs = hass.states[entityId]?.attributes;
  if (attrs?.editable === false) {
    const result = await hass.callWS<{ response: Record<string, Omit<ScheduleItem, "id" | "name">> }>(
      {
        type: "call_service",
        domain: "schedule",
        service: "get_schedule",
        target: { entity_id: entityId },
        return_response: true,
      },
    );
    const name = (attrs.friendly_name as string | undefined) ?? entityId;
    return { item: { id: "", name, ...result.response[entityId] }, editable: false };
  }
  const entry = await hass.callWS<RegistryEntry>({
    type: "config/entity_registry/get",
    entity_id: entityId,
  });
  return { item: await fetchSchedule(hass, entry.unique_id), editable: true };
}

export function createSchedule(hass: HomeAssistant, name: string): Promise<ScheduleItem> {
  return hass.callWS<ScheduleItem>({ type: "schedule/create", name });
}

export function updateSchedule(
  hass: HomeAssistant,
  id: string,
  payload: Record<string, unknown>,
): Promise<ScheduleItem> {
  return hass.callWS<ScheduleItem>({ type: "schedule/update", schedule_id: id, ...payload });
}

/** The entity of a newly created helper. Retries briefly in case the registry entry lags. */
export async function findScheduleEntityId(hass: HomeAssistant, id: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const entries = await hass.callWS<RegistryEntry[]>({ type: "config/entity_registry/list" });
    const entry = entries.find((e) => e.platform === "schedule" && e.unique_id === id);
    if (entry) return entry.entity_id;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new ScheduleNotFoundError(id);
}
```

- [ ] **Step 3: Add the English strings**

In `frontend/src/locales/en.json`, insert after the `"schedule.eco_detail"` line:

```json
  "schedule.edit": "Edit",
  "schedule.new": "New schedule",
  "schedule.help_editor": "Use <strong>Edit</strong> or <strong>New schedule</strong> to shape a schedule on a timeline, without writing YAML. The sections below show how the same data looks in YAML.",
  "schedule_editor.heading": "Schedule editor",
  "schedule_editor.name_label": "Schedule name",
  "schedule_editor.loading": "Loading schedule…",
  "schedule_editor.load_error": "Could not load this schedule: {message}",
  "schedule_editor.readonly_notice": "This schedule is defined in YAML, so you can only view it here. To change it, edit your Home Assistant configuration.",
  "schedule_editor.shared_notice": "This schedule has {count} other use(s), in other rooms or for covers. Your changes apply to all of them.",
  "schedule_editor.gesture_hint": "Drag the sides to change the times, the block to move it, the top handle to change the temperature. Tap an empty slot to add a block.",
  "schedule_editor.legend_block": "Block temperature",
  "schedule_editor.legend_comfort": "Comfort {temp}{unit}",
  "schedule_editor.legend_eco": "Outside blocks: eco {temp}{unit}",
  "schedule_editor.all_day_eco": "Eco all day",
  "schedule_editor.day_empty": "No blocks: the eco temperature applies",
  "schedule_editor.day_blocks": "Blocks: {count}",
  "schedule_editor.add_block": "Add block",
  "schedule_editor.delete_block": "Delete block",
  "schedule_editor.start": "Start",
  "schedule_editor.end": "End",
  "schedule_editor.until_midnight": "Until midnight",
  "schedule_editor.time_invalid": "times to correct",
  "schedule_editor.heat": "Heating",
  "schedule_editor.cool": "Cooling",
  "schedule_editor.comfort": "Comfort",
  "schedule_editor.lower": "Lower",
  "schedule_editor.raise": "Raise",
  "schedule_editor.copy_title": "Copy {day} to other days",
  "schedule_editor.shortcut_weekdays": "Weekdays",
  "schedule_editor.shortcut_weekend": "Weekend",
  "schedule_editor.shortcut_all": "All",
  "schedule_editor.copy_pick": "Choose the days to replace",
  "schedule_editor.copy_apply": "Replace days with {day} ({count})",
  "schedule_editor.copied": "Copied {day} to {count} day(s). Save to confirm.",
  "schedule_editor.problem_time_order": "The start must be before the end.",
  "schedule_editor.problem_overlap": "Overlaps the {from}–{to} block. Shorten one of them.",
  "schedule_editor.problem_temp_range": "{value} is outside the valid range {min}–{max}{unit}.",
  "schedule_editor.problem_heat_above_cool": "Heating cannot be above cooling.",
  "schedule_editor.footer_none": "No changes",
  "schedule_editor.footer_changes": "Changes to save: {count}",
  "schedule_editor.footer_invalid": "Correct the blocks marked in red to save.",
  "schedule_editor.cancel": "Cancel",
  "schedule_editor.save": "Save",
  "schedule_editor.close": "Close",
  "schedule_editor.saved": "Schedule saved. RoomMind applies it within 30 seconds.",
  "schedule_editor.discard_question": "Unsaved changes: {count}. Discard them?",
  "schedule_editor.keep_editing": "Keep editing",
  "schedule_editor.discard": "Discard",
  "schedule_editor.conflict": "This schedule was changed elsewhere after you opened it.",
  "schedule_editor.conflict_reload": "Reload and lose my changes",
  "schedule_editor.conflict_overwrite": "Overwrite",
  "schedule_editor.not_found": "This schedule no longer exists in Home Assistant, so it cannot be saved.",
  "schedule_editor.save_error": "Could not save: {message}",
```

- [ ] **Step 4: Add the Italian strings**

In `frontend/src/locales/it.json`, insert after the `"schedule.eco_detail"` line:

```json
  "schedule.edit": "Modifica",
  "schedule.new": "Nuovo programma",
  "schedule.help_editor": "Usa <strong>Modifica</strong> o <strong>Nuovo programma</strong> per disegnare un programma su una timeline, senza scrivere YAML. Le sezioni seguenti mostrano come appaiono gli stessi dati in YAML.",
  "schedule_editor.heading": "Editor del programma",
  "schedule_editor.name_label": "Nome del programma",
  "schedule_editor.loading": "Caricamento del programma…",
  "schedule_editor.load_error": "Impossibile caricare il programma: {message}",
  "schedule_editor.readonly_notice": "Questo programma è definito in YAML, quindi qui puoi solo consultarlo. Per cambiarlo modifica la configurazione di Home Assistant.",
  "schedule_editor.shared_notice": "Questo programma ha altri {count} utilizzi, in altre stanze o per le tapparelle. Le modifiche valgono per tutti.",
  "schedule_editor.gesture_hint": "Trascina i lati per cambiare gli orari, il blocco per spostarlo, la maniglia in alto per la temperatura. Tocca una fascia vuota per aggiungere un blocco.",
  "schedule_editor.legend_block": "Temperatura del blocco",
  "schedule_editor.legend_comfort": "Comfort {temp}{unit}",
  "schedule_editor.legend_eco": "Fuori dai blocchi: eco {temp}{unit}",
  "schedule_editor.all_day_eco": "Eco tutto il giorno",
  "schedule_editor.day_empty": "Nessun blocco: vale la temperatura eco",
  "schedule_editor.day_blocks": "Blocchi: {count}",
  "schedule_editor.add_block": "Aggiungi blocco",
  "schedule_editor.delete_block": "Elimina blocco",
  "schedule_editor.start": "Inizio",
  "schedule_editor.end": "Fine",
  "schedule_editor.until_midnight": "Fino a mezzanotte",
  "schedule_editor.time_invalid": "orario da correggere",
  "schedule_editor.heat": "Caldo",
  "schedule_editor.cool": "Freddo",
  "schedule_editor.comfort": "Comfort",
  "schedule_editor.lower": "Abbassa",
  "schedule_editor.raise": "Alza",
  "schedule_editor.copy_title": "Copia {day} su altri giorni",
  "schedule_editor.shortcut_weekdays": "Feriali",
  "schedule_editor.shortcut_weekend": "Weekend",
  "schedule_editor.shortcut_all": "Tutti",
  "schedule_editor.copy_pick": "Scegli i giorni da sostituire",
  "schedule_editor.copy_apply": "Sostituisci i giorni con {day} ({count})",
  "schedule_editor.copied": "Copiato {day} su {count} giorni. Salva per confermare.",
  "schedule_editor.problem_time_order": "L'inizio deve essere prima della fine.",
  "schedule_editor.problem_overlap": "Si sovrappone al blocco {from}–{to}. Accorcia uno dei due.",
  "schedule_editor.problem_temp_range": "{value} è fuori dall'intervallo valido {min}–{max}{unit}.",
  "schedule_editor.problem_heat_above_cool": "Il caldo non può superare il freddo.",
  "schedule_editor.footer_none": "Nessuna modifica",
  "schedule_editor.footer_changes": "Modifiche da salvare: {count}",
  "schedule_editor.footer_invalid": "Correggi i blocchi segnati in rosso per salvare.",
  "schedule_editor.cancel": "Annulla",
  "schedule_editor.save": "Salva",
  "schedule_editor.close": "Chiudi",
  "schedule_editor.saved": "Programma salvato. RoomMind lo applica entro 30 secondi.",
  "schedule_editor.discard_question": "Modifiche non salvate: {count}. Vuoi scartarle?",
  "schedule_editor.keep_editing": "Continua a modificare",
  "schedule_editor.discard": "Scarta",
  "schedule_editor.conflict": "Questo programma è stato cambiato altrove dopo che lo hai aperto.",
  "schedule_editor.conflict_reload": "Ricarica e perdi le modifiche",
  "schedule_editor.conflict_overwrite": "Sovrascrivi",
  "schedule_editor.not_found": "Questo programma non esiste più in Home Assistant, quindi non si può salvare.",
  "schedule_editor.save_error": "Salvataggio non riuscito: {message}",
```

- [ ] **Step 5: Add the German strings**

In `frontend/src/locales/de.json`, insert after the `"schedule.eco_detail"` line:

```json
  "schedule.edit": "Bearbeiten",
  "schedule.new": "Neuer Zeitplan",
  "schedule.help_editor": "Mit <strong>Bearbeiten</strong> oder <strong>Neuer Zeitplan</strong> gestaltest du einen Zeitplan auf einer Zeitleiste, ganz ohne YAML. Die folgenden Abschnitte zeigen, wie dieselben Daten in YAML aussehen.",
  "schedule_editor.heading": "Zeitplan-Editor",
  "schedule_editor.name_label": "Name des Zeitplans",
  "schedule_editor.loading": "Zeitplan wird geladen…",
  "schedule_editor.load_error": "Zeitplan konnte nicht geladen werden: {message}",
  "schedule_editor.readonly_notice": "Dieser Zeitplan ist in YAML definiert und kann hier nur angezeigt werden. Ändere dafür deine Home-Assistant-Konfiguration.",
  "schedule_editor.shared_notice": "Dieser Zeitplan wird noch {count}-mal verwendet, in anderen Räumen oder für Rollläden. Deine Änderungen gelten überall.",
  "schedule_editor.gesture_hint": "Ziehe die Seiten für die Zeiten, den Block zum Verschieben und den oberen Griff für die Temperatur. Tippe auf einen freien Bereich, um einen Block hinzuzufügen.",
  "schedule_editor.legend_block": "Blocktemperatur",
  "schedule_editor.legend_comfort": "Komfort {temp}{unit}",
  "schedule_editor.legend_eco": "Außerhalb der Blöcke: Eco {temp}{unit}",
  "schedule_editor.all_day_eco": "Ganztägig Eco",
  "schedule_editor.day_empty": "Keine Blöcke: Es gilt die Eco-Temperatur",
  "schedule_editor.day_blocks": "Blöcke: {count}",
  "schedule_editor.add_block": "Block hinzufügen",
  "schedule_editor.delete_block": "Block löschen",
  "schedule_editor.start": "Beginn",
  "schedule_editor.end": "Ende",
  "schedule_editor.until_midnight": "Bis Mitternacht",
  "schedule_editor.time_invalid": "Zeiten korrigieren",
  "schedule_editor.heat": "Heizen",
  "schedule_editor.cool": "Kühlen",
  "schedule_editor.comfort": "Komfort",
  "schedule_editor.lower": "Senken",
  "schedule_editor.raise": "Erhöhen",
  "schedule_editor.copy_title": "{day} auf andere Tage kopieren",
  "schedule_editor.shortcut_weekdays": "Werktage",
  "schedule_editor.shortcut_weekend": "Wochenende",
  "schedule_editor.shortcut_all": "Alle",
  "schedule_editor.copy_pick": "Wähle die zu ersetzenden Tage",
  "schedule_editor.copy_apply": "Tage durch {day} ersetzen ({count})",
  "schedule_editor.copied": "{day} auf {count} Tag(e) kopiert. Zum Bestätigen speichern.",
  "schedule_editor.problem_time_order": "Der Beginn muss vor dem Ende liegen.",
  "schedule_editor.problem_overlap": "Überschneidet sich mit dem Block {from}–{to}. Kürze einen der beiden.",
  "schedule_editor.problem_temp_range": "{value} liegt außerhalb des gültigen Bereichs {min}–{max}{unit}.",
  "schedule_editor.problem_heat_above_cool": "Heizen darf nicht über Kühlen liegen.",
  "schedule_editor.footer_none": "Keine Änderungen",
  "schedule_editor.footer_changes": "Zu speichernde Änderungen: {count}",
  "schedule_editor.footer_invalid": "Korrigiere die rot markierten Blöcke, um zu speichern.",
  "schedule_editor.cancel": "Abbrechen",
  "schedule_editor.save": "Speichern",
  "schedule_editor.close": "Schließen",
  "schedule_editor.saved": "Zeitplan gespeichert. RoomMind übernimmt ihn innerhalb von 30 Sekunden.",
  "schedule_editor.discard_question": "Ungespeicherte Änderungen: {count}. Verwerfen?",
  "schedule_editor.keep_editing": "Weiter bearbeiten",
  "schedule_editor.discard": "Verwerfen",
  "schedule_editor.conflict": "Dieser Zeitplan wurde an anderer Stelle geändert, nachdem du ihn geöffnet hast.",
  "schedule_editor.conflict_reload": "Neu laden, Änderungen verlieren",
  "schedule_editor.conflict_overwrite": "Überschreiben",
  "schedule_editor.not_found": "Dieser Zeitplan existiert in Home Assistant nicht mehr und kann nicht gespeichert werden.",
  "schedule_editor.save_error": "Speichern fehlgeschlagen: {message}",
```

- [ ] **Step 6: Add the French strings**

In `frontend/src/locales/fr.json`, insert after the `"schedule.eco_detail"` line:

```json
  "schedule.edit": "Modifier",
  "schedule.new": "Nouveau programme",
  "schedule.help_editor": "Utilisez <strong>Modifier</strong> ou <strong>Nouveau programme</strong> pour dessiner un programme sur une frise, sans écrire de YAML. Les sections suivantes montrent les mêmes données en YAML.",
  "schedule_editor.heading": "Éditeur de programme",
  "schedule_editor.name_label": "Nom du programme",
  "schedule_editor.loading": "Chargement du programme…",
  "schedule_editor.load_error": "Impossible de charger ce programme : {message}",
  "schedule_editor.readonly_notice": "Ce programme est défini en YAML : vous pouvez seulement le consulter ici. Pour le changer, modifiez la configuration de Home Assistant.",
  "schedule_editor.shared_notice": "Ce programme a {count} autre(s) utilisation(s), dans d'autres pièces ou pour les volets. Vos modifications s'appliquent partout.",
  "schedule_editor.gesture_hint": "Faites glisser les côtés pour changer les horaires, le bloc pour le déplacer, la poignée du haut pour la température. Touchez une plage vide pour ajouter un bloc.",
  "schedule_editor.legend_block": "Température du bloc",
  "schedule_editor.legend_comfort": "Confort {temp}{unit}",
  "schedule_editor.legend_eco": "Hors des blocs : éco {temp}{unit}",
  "schedule_editor.all_day_eco": "Éco toute la journée",
  "schedule_editor.day_empty": "Aucun bloc : la température éco s'applique",
  "schedule_editor.day_blocks": "Blocs : {count}",
  "schedule_editor.add_block": "Ajouter un bloc",
  "schedule_editor.delete_block": "Supprimer le bloc",
  "schedule_editor.start": "Début",
  "schedule_editor.end": "Fin",
  "schedule_editor.until_midnight": "Jusqu'à minuit",
  "schedule_editor.time_invalid": "horaires à corriger",
  "schedule_editor.heat": "Chauffage",
  "schedule_editor.cool": "Refroidissement",
  "schedule_editor.comfort": "Confort",
  "schedule_editor.lower": "Baisser",
  "schedule_editor.raise": "Augmenter",
  "schedule_editor.copy_title": "Copier {day} sur d'autres jours",
  "schedule_editor.shortcut_weekdays": "Semaine",
  "schedule_editor.shortcut_weekend": "Week-end",
  "schedule_editor.shortcut_all": "Tous",
  "schedule_editor.copy_pick": "Choisissez les jours à remplacer",
  "schedule_editor.copy_apply": "Remplacer les jours par {day} ({count})",
  "schedule_editor.copied": "{day} copié sur {count} jour(s). Enregistrez pour confirmer.",
  "schedule_editor.problem_time_order": "Le début doit précéder la fin.",
  "schedule_editor.problem_overlap": "Chevauche le bloc {from}–{to}. Raccourcissez l'un des deux.",
  "schedule_editor.problem_temp_range": "{value} est hors de la plage valide {min}–{max}{unit}.",
  "schedule_editor.problem_heat_above_cool": "Le chauffage ne peut pas dépasser le refroidissement.",
  "schedule_editor.footer_none": "Aucune modification",
  "schedule_editor.footer_changes": "Modifications à enregistrer : {count}",
  "schedule_editor.footer_invalid": "Corrigez les blocs marqués en rouge pour enregistrer.",
  "schedule_editor.cancel": "Annuler",
  "schedule_editor.save": "Enregistrer",
  "schedule_editor.close": "Fermer",
  "schedule_editor.saved": "Programme enregistré. RoomMind l'applique sous 30 secondes.",
  "schedule_editor.discard_question": "Modifications non enregistrées : {count}. Les abandonner ?",
  "schedule_editor.keep_editing": "Continuer",
  "schedule_editor.discard": "Abandonner",
  "schedule_editor.conflict": "Ce programme a été modifié ailleurs après son ouverture.",
  "schedule_editor.conflict_reload": "Recharger et perdre mes modifications",
  "schedule_editor.conflict_overwrite": "Écraser",
  "schedule_editor.not_found": "Ce programme n'existe plus dans Home Assistant et ne peut pas être enregistré.",
  "schedule_editor.save_error": "Échec de l'enregistrement : {message}",
```

- [ ] **Step 7: Check**

Run: `npx prettier --write src/utils/schedule-api.ts src/types/index.ts && npx tsc --noEmit && npx eslint src/`
Expected: no errors. `resolveJsonModule` also fails the type check if a locale file is invalid JSON.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/utils/schedule-api.ts frontend/src/types/index.ts frontend/src/locales
git commit -m "feat: add schedule helper API calls and editor strings" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Timeline component

**Files:**
- Create: `frontend/src/components/rs-schedule-timeline.ts`

**Interfaces:**
- Consumes: from `schedule-blocks.ts`: `WEEKDAYS`, `DAY_SECONDS`, `SNAP_SECONDS`, `blockTemp`, `setBlockTemp`, `snapTemp`, `heightPercent`, `tempRatio`, `mainSide`, `moveBlock`, `resizeStart`, `resizeEnd`, `newBlockRange`, `validateBlock`, `formatHm`, `formatDuration`, `weekdayName`, and the types `DraftBlock`, `DraftWeek`, `BlockPatch`, `Temps`, `TempScale`, `TempSide`, `ValidationContext`, `Weekday`.
- Produces: `<rs-schedule-timeline>` with properties `week: DraftWeek`, `validation: ValidationContext`, `eco: Temps`, `scale: Record<TempSide, TempScale>`, `step: number`, `selection: TimelineSelection | null`, `readonly: boolean`, `language: string`, `emptyLabel: string`, `flashDays: Set<Weekday>`. Exported type `TimelineSelection = { day: Weekday; key: number | null }`. Non-bubbling events: `block-select` `{ day, key }`, `day-select` `{ day }`, `block-add` `{ day, from, to }`, `block-change` `{ day, key, patch: BlockPatch }`.

The parent replaces `week` on every `block-change`. Keyed rendering with `repeat` keeps the same DOM node during a gesture, which a touch drag requires.

- [ ] **Step 1: Create the component**

Create `frontend/src/components/rs-schedule-timeline.ts`:

```ts
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { styleMap } from "lit/directives/style-map.js";
import {
  DAY_SECONDS,
  SNAP_SECONDS,
  WEEKDAYS,
  blockTemp,
  formatDuration,
  formatHm,
  heightPercent,
  mainSide,
  moveBlock,
  newBlockRange,
  resizeEnd,
  resizeStart,
  setBlockTemp,
  snapTemp,
  tempRatio,
  validateBlock,
  weekdayName,
  type BlockPatch,
  type DraftBlock,
  type DraftWeek,
  type TempScale,
  type TempSide,
  type Temps,
  type ValidationContext,
  type Weekday,
} from "../utils/schedule-blocks";

export type TimelineSelection = { day: Weekday; key: number | null };

type GripKind = "left" | "right" | "temp";
interface DragState {
  kind: GripKind | "move";
  day: Weekday;
  key: number;
  active: boolean;
  startX: number;
  startY: number;
  trackWidth: number;
  trackHeight: number;
  origin: { from: number; to: number; temp: number };
}

@customElement("rs-schedule-timeline")
export class RsScheduleTimeline extends LitElement {
  @property({ attribute: false }) public week!: DraftWeek;
  @property({ attribute: false }) public validation!: ValidationContext;
  @property({ attribute: false }) public eco!: Temps;
  @property({ attribute: false }) public scale!: Record<TempSide, TempScale>;
  @property({ type: Number }) public step = 0.5;
  @property({ attribute: false }) public selection: TimelineSelection | null = null;
  @property({ type: Boolean }) public readonly = false;
  @property({ type: String }) public language = "en";
  @property({ type: String }) public emptyLabel = "";
  @property({ attribute: false }) public flashDays: Set<Weekday> = new Set();

  @state() private _bubble: { day: Weekday; left: number; bottom: number; text: string } | null =
    null;
  @state() private _ghost: { day: Weekday; from: number; to: number } | null = null;
  @state() private _intro = true;
  @state() private _tick = 0;

  private _drag: DragState | null = null;
  private _swallowClick = false;
  private _clock?: ReturnType<typeof setInterval>;

  static styles = css`
    :host {
      display: block;
      --rs-heat-base: var(--warning-color, #ff9800);
      --rs-cool-base: #2196f3;
    }
    .week {
      display: grid;
      gap: 9px;
      user-select: none;
      -webkit-user-select: none;
    }
    .hours,
    .row {
      display: grid;
      grid-template-columns: 44px minmax(0, 1fr);
      gap: 10px;
      align-items: stretch;
    }
    .scale {
      position: relative;
      height: 22px;
      color: var(--secondary-text-color);
      font-size: 11px;
      font-variant-numeric: tabular-nums;
    }
    .scale span {
      position: absolute;
      top: 4px;
      transform: translateX(-50%);
    }
    .scale span.first {
      transform: none;
    }
    .scale span.last {
      transform: translateX(-100%);
    }
    .scale .now-label {
      top: 0;
      padding: 2px 7px;
      border-radius: 10px;
      background: var(--primary-text-color);
      color: var(--card-background-color);
      font-weight: 500;
      z-index: 4;
    }
    .day {
      background: none;
      border: 0;
      padding: 0;
      cursor: pointer;
      border-radius: 10px;
      font: inherit;
      font-weight: 500;
      font-size: 13px;
      color: var(--secondary-text-color);
      text-transform: capitalize;
    }
    .day:hover,
    .row.on .day {
      color: var(--primary-text-color);
      background: var(--secondary-background-color);
    }
    .row.today .day {
      color: var(--primary-color);
    }
    .track {
      position: relative;
      height: 78px;
      border-radius: 10px;
      cursor: copy;
      background:
        linear-gradient(90deg, var(--divider-color) 1px, transparent 1px) 0 0 / 25% 100%,
        linear-gradient(
            90deg,
            color-mix(in oklab, var(--divider-color) 50%, transparent) 1px,
            transparent 1px
          )
          0 0 / 12.5% 100%,
        var(--secondary-background-color);
    }
    .week.readonly .track {
      cursor: default;
    }
    .track::after {
      content: "";
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: var(--eco-height);
      pointer-events: none;
      border-radius: 0 0 10px 10px;
      border-top: 1px solid var(--divider-color);
      background: repeating-linear-gradient(
        135deg,
        color-mix(in oklab, var(--secondary-text-color) 22%, transparent) 0 2px,
        transparent 2px 6px
      );
    }
    .empty {
      position: absolute;
      left: 0;
      right: 0;
      top: 18%;
      text-align: center;
      font-size: 12px;
      color: var(--secondary-text-color);
      pointer-events: none;
    }
    .block {
      position: absolute;
      bottom: 0;
      z-index: 1;
      cursor: grab;
      outline: none;
      touch-action: pan-y;
    }
    .week.readonly .block {
      cursor: pointer;
    }
    .fill {
      position: absolute;
      inset: 0;
      overflow: hidden;
      container-type: inline-size;
      transform-origin: bottom;
      display: flex;
      flex-direction: column;
      gap: 1px;
      padding: 6px 0 0 7px;
      box-sizing: border-box;
      border-radius: 7px 7px 2px 2px;
      color: rgba(0, 0, 0, 0.85);
      background: linear-gradient(180deg, var(--c), color-mix(in oklab, var(--c) 80%, black));
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.4),
        0 1px 3px rgba(0, 0, 0, 0.18);
      transition:
        box-shadow 0.12s,
        opacity 0.12s;
    }
    .block.comfort .fill {
      border-top: 2px dashed currentColor;
    }
    .has-selection .block:not(.selected) .fill {
      opacity: 0.78;
    }
    .block:hover .fill {
      opacity: 1;
    }
    .block.selected {
      z-index: 2;
    }
    .block.selected .fill {
      touch-action: none;
      box-shadow:
        0 0 0 2px var(--card-background-color),
        0 0 0 4px var(--primary-color),
        0 6px 16px rgba(0, 0, 0, 0.3);
    }
    .block:focus-visible .fill {
      box-shadow:
        0 0 0 2px var(--card-background-color),
        0 0 0 4px var(--primary-color);
    }
    .block.invalid .fill {
      box-shadow:
        0 0 0 2px var(--card-background-color),
        0 0 0 4px var(--error-color);
    }
    .temp-label {
      font-size: 14px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      line-height: 1.1;
    }
    .time-label {
      font-size: 11px;
      font-weight: 500;
      opacity: 0.8;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    @container (max-width: 92px) {
      .time-label {
        display: none;
      }
    }
    @container (max-width: 34px) {
      .temp-label {
        display: none;
      }
    }
    .grip {
      position: absolute;
      z-index: 3;
      touch-action: none;
      display: none;
    }
    .block.selected .grip {
      display: block;
    }
    @media (hover: hover) {
      .block:hover .grip {
        display: block;
      }
    }
    .grip::after {
      content: "";
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: #fff;
      border-radius: 3px;
      box-shadow:
        0 0 0 1px rgba(0, 0, 0, 0.35),
        0 1px 3px rgba(0, 0, 0, 0.35);
    }
    .grip.left,
    .grip.right {
      top: 0;
      bottom: 0;
      width: 26px;
      cursor: ew-resize;
    }
    .grip.left {
      left: -13px;
    }
    .grip.right {
      right: -13px;
    }
    .grip.left::after,
    .grip.right::after {
      width: 5px;
      height: 24px;
    }
    .grip.temp {
      top: -13px;
      left: 26px;
      right: 26px;
      min-width: 18px;
      height: 26px;
      cursor: ns-resize;
    }
    .grip.temp::after {
      width: 24px;
      height: 5px;
    }
    .bubble {
      position: absolute;
      z-index: 6;
      transform: translateX(-50%);
      padding: 5px 10px;
      border-radius: 8px;
      background: var(--primary-text-color);
      color: var(--card-background-color);
      font-size: 13px;
      font-weight: 500;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      pointer-events: none;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
    }
    .ghost {
      position: absolute;
      top: 5px;
      bottom: 5px;
      z-index: 1;
      border: 1.5px dashed var(--primary-color);
      border-radius: 7px;
      box-sizing: border-box;
      color: var(--primary-color);
      font-size: 11px;
      font-weight: 500;
      display: grid;
      place-items: center;
      pointer-events: none;
      overflow: hidden;
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
      background: color-mix(in oklab, var(--primary-color) 10%, transparent);
    }
    .now {
      position: absolute;
      top: -4px;
      bottom: 0;
      width: 2px;
      margin-left: -1px;
      background: var(--primary-text-color);
      z-index: 3;
      pointer-events: none;
    }
    .intro .fill {
      animation: rise 0.5s cubic-bezier(0.2, 0.8, 0.2, 1) backwards;
    }
    @keyframes rise {
      from {
        transform: scaleY(0.3);
      }
    }
    .row.flash .track {
      animation: flash 0.9s ease-out;
    }
    @keyframes flash {
      0% {
        box-shadow: 0 0 0 2px var(--primary-color);
      }
      100% {
        box-shadow: 0 0 0 2px transparent;
      }
    }
    @media (max-width: 600px) {
      .hours,
      .row {
        grid-template-columns: 30px minmax(0, 1fr);
        gap: 8px;
      }
      .track {
        height: 66px;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .intro .fill,
      .row.flash .track {
        animation: none;
      }
      .fill {
        transition: none;
      }
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this._clock = setInterval(() => this._tick++, 60000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    clearInterval(this._clock);
    this._removeDragListeners();
  }

  firstUpdated(): void {
    setTimeout(() => (this._intro = false), 800);
  }

  private get _side(): TempSide {
    return mainSide(this.validation.climateMode);
  }

  private _emit(name: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  private _value(block: DraftBlock, side: TempSide): number {
    return blockTemp(block.data, side) ?? this.validation.comfort[side];
  }

  private _formatTemp(value: number): string {
    return new Intl.NumberFormat(this.language, { maximumFractionDigits: 1 }).format(value);
  }

  private _color(value: number): string {
    const side = this._side;
    const percent = Math.round(tempRatio(value, side, this.scale[side]) * 100);
    const base = `var(--rs-${side}-base)`;
    return `color-mix(in oklab, ${base} ${percent}%, color-mix(in oklab, ${base} 35%, white))`;
  }

  // ─── Rendering ───────────────────────────────────────────────────

  render() {
    const side = this._side;
    const now = new Date();
    const today = WEEKDAYS[(now.getDay() + 6) % 7];
    const nowSeconds = now.getHours() * 3600 + now.getMinutes() * 60;
    const nowPercent = (nowSeconds / DAY_SECONDS) * 100;
    const classes = [
      "week",
      this.readonly ? "readonly" : "",
      this._intro ? "intro" : "",
      this.selection?.key != null ? "has-selection" : "",
    ].join(" ");
    return html`
      <div
        class=${classes}
        style=${styleMap({
          "--eco-height": `${heightPercent(this.eco[side], side, this.scale[side])}%`,
        })}
      >
        <div class="hours">
          <i></i>
          <div class="scale">
            <span class="first" style="left:0">00</span>
            <span style="left:25%">06</span>
            <span style="left:50%">12</span>
            <span style="left:75%">18</span>
            <span class="last" style="left:100%">24</span>
            <span class="now-label" style="left:clamp(20px, ${nowPercent}%, calc(100% - 20px))"
              >${formatHm(nowSeconds)}</span
            >
          </div>
        </div>
        ${WEEKDAYS.map((day, index) => this._renderRow(day, index, today, nowPercent))}
      </div>
    `;
  }

  private _renderRow(day: Weekday, index: number, today: Weekday, nowPercent: number) {
    const blocks = this.week[day];
    const rowClasses = [
      "row",
      this.selection?.day === day ? "on" : "",
      day === today ? "today" : "",
      this.flashDays.has(day) ? "flash" : "",
    ].join(" ");
    return html`
      <div class=${rowClasses}>
        <button
          class="day"
          aria-label=${weekdayName(this.language, index, "long")}
          @click=${() => this._emit("day-select", { day })}
        >
          ${weekdayName(this.language, index, "short")}
        </button>
        <div
          class="track"
          @click=${(e: MouseEvent) => this._onTrackClick(e, day)}
          @pointermove=${(e: PointerEvent) => this._onTrackHover(e, day)}
          @pointerleave=${() => (this._ghost = null)}
        >
          ${blocks.length === 0 ? html`<span class="empty">${this.emptyLabel}</span>` : nothing}
          ${repeat(
            blocks,
            (b) => b.key,
            (b) => this._renderBlock(day, b),
          )}
          ${day === today ? html`<span class="now" style="left:${nowPercent}%"></span>` : nothing}
          ${this._ghost?.day === day ? this._renderGhost() : nothing}
          ${this._bubble?.day === day
            ? html`<span
                class="bubble"
                style="left:${this._bubble.left}%;bottom:calc(${this._bubble.bottom}% + 12px)"
                >${this._bubble.text}</span
              >`
            : nothing}
        </div>
      </div>
    `;
  }

  private _renderBlock(day: Weekday, block: DraftBlock) {
    const side = this._side;
    const value = this._value(block, side);
    const comfort = blockTemp(block.data, side) === null;
    const left = (block.from / DAY_SECONDS) * 100;
    const width = Math.max(((block.to - block.from) / DAY_SECONDS) * 100, 0.6);
    const invalid = validateBlock(block, this.week[day], this.validation).length > 0;
    const range = `${formatHm(block.from)}–${formatHm(block.to)}`;
    const classes = [
      "block",
      comfort ? "comfort" : "",
      this.selection?.key === block.key ? "selected" : "",
      invalid ? "invalid" : "",
    ].join(" ");
    return html`
      <div
        class=${classes}
        role="button"
        tabindex="0"
        aria-label="${range}, ${this._formatTemp(value)}°"
        style=${styleMap({
          left: `${left}%`,
          width: `${width}%`,
          height: `${heightPercent(value, side, this.scale[side])}%`,
          "--c": this._color(value),
        })}
        @click=${(e: MouseEvent) => this._onBlockClick(e, day, block)}
        @pointerdown=${(e: PointerEvent) => this._onBlockPointerDown(e, day, block)}
        @keydown=${(e: KeyboardEvent) => this._onBlockKey(e, day, block)}
      >
        <div class="fill">
          <span class="temp-label">${this._formatTemp(value)}°</span>
          <span class="time-label">${range}</span>
        </div>
        ${this.readonly
          ? nothing
          : html`<span class="grip left" data-grip="left"></span>
              <span class="grip right" data-grip="right"></span>
              <span class="grip temp" data-grip="temp"></span>`}
      </div>
    `;
  }

  private _renderGhost() {
    const ghost = this._ghost!;
    const style = styleMap({
      left: `${(ghost.from / DAY_SECONDS) * 100}%`,
      width: `${((ghost.to - ghost.from) / DAY_SECONDS) * 100}%`,
    });
    return html`<span class="ghost" style=${style}>+ ${formatHm(ghost.from)}</span>`;
  }

  // ─── Clicks and hover ────────────────────────────────────────────

  private _secondsAt(e: MouseEvent, track: HTMLElement): number {
    const rect = track.getBoundingClientRect();
    return ((e.clientX - rect.left) / rect.width) * DAY_SECONDS;
  }

  private _onTrackClick(e: MouseEvent, day: Weekday): void {
    if (this.readonly || this._swallowClick) return;
    const range = newBlockRange(this.week[day], this._secondsAt(e, e.currentTarget as HTMLElement));
    if (range) this._emit("block-add", { day, ...range });
    this._ghost = null;
  }

  private _onTrackHover(e: PointerEvent, day: Weekday): void {
    if (this.readonly || this._drag || e.pointerType !== "mouse") return;
    if ((e.target as HTMLElement).closest(".block")) {
      this._ghost = null;
      return;
    }
    const range = newBlockRange(this.week[day], this._secondsAt(e, e.currentTarget as HTMLElement));
    this._ghost = range ? { day, ...range } : null;
  }

  private _onBlockClick(e: MouseEvent, day: Weekday, block: DraftBlock): void {
    e.stopPropagation();
    if (!this._swallowClick) this._emit("block-select", { day, key: block.key });
  }

  // ─── Keyboard ────────────────────────────────────────────────────

  private _onBlockKey(e: KeyboardEvent, day: Weekday, block: DraftBlock): void {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      this._emit("block-select", { day, key: block.key });
      return;
    }
    if (this.readonly) return;
    const dayBlocks = this.week[day];
    let patch: BlockPatch | null = null;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const delta = e.key === "ArrowRight" ? SNAP_SECONDS : -SNAP_SECONDS;
      patch = e.shiftKey
        ? { to: resizeEnd(block, dayBlocks, block.to + delta) }
        : moveBlock(block, dayBlocks, block.from + delta);
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const side = this._side;
      const delta = e.key === "ArrowUp" ? this.step : -this.step;
      const value = snapTemp(
        this._value(block, side) + delta,
        this.step,
        this.validation.minTemp,
        this.validation.maxTemp,
      );
      patch = { data: setBlockTemp(block.data, side, value) };
    }
    if (!patch) return;
    e.preventDefault();
    this._emit("block-select", { day, key: block.key });
    this._emit("block-change", { day, key: block.key, patch });
  }

  // ─── Dragging ────────────────────────────────────────────────────

  private _onBlockPointerDown(e: PointerEvent, day: Weekday, block: DraftBlock): void {
    if (this.readonly || e.button !== 0) return;
    const grip = (e.target as HTMLElement).dataset.grip as GripKind | undefined;
    // On touch only the selected block can be moved, so a swipe over the others scrolls the page.
    if (!grip && e.pointerType !== "mouse" && this.selection?.key !== block.key) return;
    const track = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect();
    this._drag = {
      kind: grip ?? "move",
      day,
      key: block.key,
      active: false,
      startX: e.clientX,
      startY: e.clientY,
      trackWidth: track.width,
      trackHeight: track.height,
      origin: { from: block.from, to: block.to, temp: this._value(block, this._side) },
    };
    window.addEventListener("pointermove", this._onDragMove);
    window.addEventListener("pointerup", this._onDragEnd);
    window.addEventListener("pointercancel", this._onDragEnd);
    if (grip) e.preventDefault();
  }

  private _onDragMove = (e: PointerEvent): void => {
    const drag = this._drag;
    if (!drag) return;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 4) return;
      drag.active = true;
      this._ghost = null;
      if (this.selection?.key !== drag.key) {
        this._emit("block-select", { day: drag.day, key: drag.key });
      }
    }
    const dayBlocks = this.week[drag.day];
    const block = dayBlocks.find((b) => b.key === drag.key);
    if (!block) return;
    const patch = this._dragPatch(drag, block, dayBlocks, e);
    this._emit("block-change", { day: drag.day, key: drag.key, patch });
    this._showBubble(drag, { ...block, ...patch });
  };

  private _dragPatch(
    drag: DragState,
    block: DraftBlock,
    dayBlocks: DraftBlock[],
    e: PointerEvent,
  ): BlockPatch {
    const delta = ((e.clientX - drag.startX) / drag.trackWidth) * DAY_SECONDS;
    if (drag.kind === "left") {
      return { from: resizeStart(block, dayBlocks, drag.origin.from + delta) };
    }
    if (drag.kind === "right") return { to: resizeEnd(block, dayBlocks, drag.origin.to + delta) };
    if (drag.kind === "move") return moveBlock(block, dayBlocks, drag.origin.from + delta);

    const side = this._side;
    const [lo, hi] = this.scale[side];
    const perDegree = (drag.trackHeight * 0.8) / (hi - lo);
    const dy = e.clientY - drag.startY;
    const raw = drag.origin.temp + (side === "heat" ? -dy : dy) / perDegree;
    const upper =
      this.validation.climateMode === "auto" && side === "heat"
        ? Math.min(hi, this._value(block, "cool"))
        : hi;
    return { data: setBlockTemp(block.data, side, snapTemp(raw, this.step, lo, upper)) };
  }

  private _showBubble(drag: DragState, block: DraftBlock): void {
    const side = this._side;
    const value = this._value(block, side);
    const center = ((block.from + block.to) / 2 / DAY_SECONDS) * 100;
    this._bubble = {
      day: drag.day,
      left: Math.min(88, Math.max(12, center)),
      bottom: heightPercent(value, side, this.scale[side]),
      text:
        drag.kind === "temp"
          ? `${this._formatTemp(value)}°`
          : `${formatHm(block.from)} – ${formatHm(block.to)} · ${formatDuration(block.to - block.from)}`,
    };
  }

  private _onDragEnd = (): void => {
    const wasActive = this._drag?.active ?? false;
    this._drag = null;
    this._bubble = null;
    this._removeDragListeners();
    if (wasActive) {
      // The browser still fires click after pointerup: it must not select or add a block.
      this._swallowClick = true;
      setTimeout(() => (this._swallowClick = false), 0);
    }
  };

  private _removeDragListeners(): void {
    window.removeEventListener("pointermove", this._onDragMove);
    window.removeEventListener("pointerup", this._onDragEnd);
    window.removeEventListener("pointercancel", this._onDragEnd);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "rs-schedule-timeline": RsScheduleTimeline;
  }
}
```

- [ ] **Step 2: Check**

Run: `npx prettier --write src/components/rs-schedule-timeline.ts && npx tsc --noEmit && npx eslint src/`
Expected: no errors. The component is not imported yet, so behavior is tested in Task 6.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/rs-schedule-timeline.ts
git commit -m "feat: add draggable schedule timeline component" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Editor component

**Files:**
- Create: `frontend/src/components/rs-schedule-editor.ts`

**Interfaces:**
- Consumes:
  - `<rs-schedule-timeline>` and `TimelineSelection` from Task 4;
  - `loadSchedule`, `fetchSchedule`, `updateSchedule`, `isNotFound` from Task 3;
  - from `schedule-blocks.ts`: `SCALE_CELSIUS`, `WEEKDAYS`, `addBlock`, `blockTemp`, `copyDay`, `countChangedDays`, `countOtherUses`, `emptyWeek`, `formatDuration`, `formatHm`, `mainSide`, `newBlockRange`, `parseTime`, `removeBlock`, `sameItem`, `setBlockTemp`, `snapTemp`, `toDraftWeek`, `toUpdatePayload`, `updateBlock`, `validateBlock`, `weekIsValid`, `weekdayName`, and types;
  - from `utils/temperature.ts`: `toDisplay`, `tempStep`, `tempUnit`, `MIN_TARGET_TEMP_C`, `MAX_TARGET_TEMP_C`.
- Produces: `<rs-schedule-editor>` with properties `hass`, `entityId: string`, `climateMode: ClimateMode`, `comfortHeat`, `comfortCool`, `ecoHeat`, `ecoCool` (all °C), `rooms: Record<string, RoomConfig>`, `areaId: string`, `selectName: boolean`; public method `requestClose(): void`; non-bubbling event `editor-closed`.

- [ ] **Step 1: Create the component**

Create `frontend/src/components/rs-schedule-editor.ts`:

```ts
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { ClimateMode, HomeAssistant, RoomConfig } from "../types";
import { localize, type TranslationKey } from "../utils/localize";
import { fetchSchedule, isNotFound, loadSchedule, updateSchedule } from "../utils/schedule-api";
import {
  SCALE_CELSIUS,
  WEEKDAYS,
  addBlock,
  blockTemp,
  copyDay,
  countChangedDays,
  countOtherUses,
  emptyWeek,
  formatDuration,
  formatHm,
  mainSide,
  newBlockRange,
  parseTime,
  removeBlock,
  sameItem,
  setBlockTemp,
  snapTemp,
  toDraftWeek,
  toUpdatePayload,
  updateBlock,
  validateBlock,
  weekIsValid,
  weekdayName,
  type BlockPatch,
  type BlockProblem,
  type DraftBlock,
  type DraftWeek,
  type ScheduleItem,
  type TempSide,
  type Temps,
  type ValidationContext,
  type Weekday,
} from "../utils/schedule-blocks";
import {
  MAX_TARGET_TEMP_C,
  MIN_TARGET_TEMP_C,
  tempStep,
  tempUnit,
  toDisplay,
} from "../utils/temperature";
import "./rs-schedule-timeline";
import type { TimelineSelection } from "./rs-schedule-timeline";

const ICON_FIRE =
  "M17.66 11.2C17.43 10.9 17.15 10.64 16.89 10.38C16.22 9.78 15.46 9.35 14.82 8.72C13.33 7.26 13 4.85 13.95 3C13 3.23 12.17 3.75 11.46 4.32C8.87 6.4 7.85 10.07 9.07 13.22C9.11 13.32 9.15 13.42 9.15 13.55C9.15 13.77 9 13.97 8.8 14.05C8.57 14.15 8.33 14.09 8.14 13.93C8.08 13.88 8.04 13.83 8 13.76C6.87 12.33 6.69 10.28 7.45 8.64C5.78 10 4.87 12.3 5 14.47C5.06 14.97 5.12 15.47 5.29 15.97C5.43 16.57 5.7 17.17 6 17.7C7.08 19.43 8.95 20.67 10.96 20.92C13.1 21.19 15.39 20.8 17.03 19.32C18.86 17.66 19.5 15 18.56 12.72L18.43 12.46C18.22 12 17.66 11.2 17.66 11.2Z";
const ICON_SNOW =
  "M20.79,13.95L18.46,14.57L16.46,13.44V10.56L18.46,9.43L20.79,10.05L21.31,8.12L19.54,7.65L20,5.88L18.07,5.36L17.45,7.69L15.45,8.82L13,7.38V5.12L14.71,3.41L13.29,2L12,3.29L10.71,2L9.29,3.41L11,5.12V7.38L8.5,8.82L6.5,7.69L5.92,5.36L4,5.88L4.47,7.65L2.7,8.12L3.22,10.05L5.55,9.43L7.55,10.56V13.45L5.55,14.58L3.22,13.96L2.7,15.89L4.47,16.36L4,18.12L5.93,18.64L6.55,16.31L8.55,15.18L11,16.62V18.88L9.29,20.59L10.71,22L12,20.71L13.29,22L14.7,20.59L13,18.88V16.62L15.5,15.17L17.5,16.3L18.12,18.63L20,18.12L19.53,16.35L21.3,15.88L20.79,13.95M9.5,10.56L12,9.11L14.5,10.56V13.44L12,14.89L9.5,13.44V10.56Z";

@customElement("rs-schedule-editor")
export class RsScheduleEditor extends LitElement {
  @property({ attribute: false }) public hass!: HomeAssistant;
  @property({ type: String }) public entityId = "";
  @property({ type: String }) public climateMode: ClimateMode = "auto";
  @property({ type: Number }) public comfortHeat = 21;
  @property({ type: Number }) public comfortCool = 24;
  @property({ type: Number }) public ecoHeat = 17;
  @property({ type: Number }) public ecoCool = 27;
  @property({ attribute: false }) public rooms: Record<string, RoomConfig> = {};
  @property({ type: String }) public areaId = "";
  @property({ type: Boolean }) public selectName = false;

  @state() private _loading = true;
  @state() private _loadError = "";
  @state() private _readonly = false;
  @state() private _name = "";
  @state() private _week: DraftWeek = emptyWeek();
  @state() private _savedWeek: DraftWeek = emptyWeek();
  @state() private _savedName = "";
  @state() private _selection: TimelineSelection = { day: "monday", key: null };
  @state() private _copyTargets: Set<Weekday> = new Set();
  @state() private _flashDays: Set<Weekday> = new Set();
  @state() private _confirming = false;
  @state() private _conflict = false;
  @state() private _saving = false;
  @state() private _error = "";
  @state() private _message = "";

  private _item: ScheduleItem | null = null;

  static styles = css`
    :host {
      display: block;
    }
    .stack {
      display: grid;
      gap: 16px;
      min-width: 0;
    }
    button {
      font: inherit;
      color: inherit;
      background: none;
      border: 0;
      padding: 0;
      cursor: pointer;
    }
    .name {
      width: 100%;
      box-sizing: border-box;
      background: none;
      border: 0;
      border-bottom: 1px solid var(--divider-color);
      color: var(--primary-text-color);
      font: inherit;
      font-size: 18px;
      font-weight: 500;
      padding: 4px 0;
    }
    .name:focus {
      outline: none;
      border-bottom-color: var(--primary-color);
    }
    .notice {
      padding: 10px 14px;
      border-radius: 8px;
      background: rgba(255, 152, 0, 0.08);
      color: var(--warning-color, #ff9800);
      font-size: 13px;
    }
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 16px;
      font-size: 12px;
      color: var(--secondary-text-color);
    }
    .legend span {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .swatch {
      width: 18px;
      height: 10px;
      border-radius: 3px;
      display: inline-block;
      box-sizing: border-box;
    }
    .swatch.block {
      background: linear-gradient(
        90deg,
        color-mix(in oklab, var(--swatch) 35%, white),
        var(--swatch)
      );
    }
    .swatch.comfort {
      background: color-mix(in oklab, var(--swatch) 60%, white);
      border-top: 2px dashed var(--primary-text-color);
    }
    .swatch.eco {
      border: 1px solid var(--divider-color);
      background: repeating-linear-gradient(
        135deg,
        color-mix(in oklab, var(--secondary-text-color) 30%, transparent) 0 2px,
        transparent 2px 5px
      );
    }
    .hint {
      margin: -6px 0 0;
      font-size: 12px;
      color: var(--secondary-text-color);
    }
    .panel {
      display: grid;
      gap: 14px;
      padding: 14px;
      border: 1px solid var(--divider-color);
      border-radius: 12px;
      min-width: 0;
    }
    .panel-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .panel-title h3 {
      margin: 0;
      font-size: 15px;
      font-weight: 500;
      text-transform: capitalize;
    }
    .panel-title p {
      margin: 2px 0 0;
      color: var(--secondary-text-color);
      font-size: 13px;
      font-variant-numeric: tabular-nums;
    }
    .delete {
      color: var(--error-color);
      font-weight: 500;
      font-size: 13px;
      padding: 8px 4px;
      white-space: nowrap;
    }
    .fields {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      gap: 14px;
    }
    .times {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      align-content: start;
    }
    .field {
      display: grid;
      gap: 4px;
      font-size: 12px;
      color: var(--secondary-text-color);
      min-width: 0;
    }
    input[type="time"] {
      width: 100%;
      box-sizing: border-box;
      min-height: 40px;
      padding: 6px 8px;
      border: 1px solid var(--divider-color);
      border-radius: 8px;
      background: var(--card-background-color);
      color: var(--primary-text-color);
      font: inherit;
      font-variant-numeric: tabular-nums;
      color-scheme: light dark;
    }
    input[type="time"]:disabled {
      opacity: 0.5;
    }
    .midnight {
      grid-column: 1 / -1;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
    }
    .midnight input {
      width: 18px;
      height: 18px;
      accent-color: var(--primary-color);
    }
    .temp {
      display: grid;
      gap: 6px;
      min-width: 0;
    }
    .temp header {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--secondary-text-color);
    }
    .temp svg {
      width: 18px;
      height: 18px;
      fill: currentColor;
    }
    .temp.heat svg {
      color: var(--warning-color, #ff9800);
    }
    .temp.cool svg {
      color: #2196f3;
    }
    .comfort-chip {
      margin-left: auto;
      font-size: 12px;
      padding: 3px 9px;
      border-radius: 12px;
      border: 1px solid var(--divider-color);
      color: var(--secondary-text-color);
    }
    .comfort-chip[aria-pressed="true"] {
      background: var(--secondary-background-color);
      color: var(--primary-text-color);
      font-weight: 500;
    }
    .stepper {
      display: grid;
      grid-template-columns: 44px minmax(0, 1fr) 44px;
      align-items: center;
      background: var(--secondary-background-color);
      border-radius: 10px;
    }
    .stepper button {
      height: 48px;
      font-size: 22px;
      font-weight: 300;
      border-radius: 10px;
    }
    .stepper button:hover {
      background: var(--divider-color);
    }
    .stepper output {
      text-align: center;
      font-size: 30px;
      font-weight: 300;
      font-variant-numeric: tabular-nums;
      line-height: 1;
    }
    .stepper output small {
      font-size: 15px;
      color: var(--secondary-text-color);
    }
    .stepper.is-comfort output {
      color: var(--secondary-text-color);
    }
    .problem {
      margin: 0;
      color: var(--error-color);
      font-size: 13px;
    }
    .add {
      justify-self: start;
      padding: 8px 14px;
      border-radius: 8px;
      border: 1px solid var(--divider-color);
      font-weight: 500;
    }
    .copy {
      display: grid;
      gap: 8px;
      padding-top: 12px;
      border-top: 1px solid var(--divider-color);
    }
    .copy h4 {
      margin: 0;
      font-size: 13px;
      font-weight: 500;
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }
    .chip {
      min-width: 42px;
      min-height: 34px;
      padding: 4px 10px;
      border-radius: 17px;
      border: 1px solid var(--divider-color);
      font-size: 13px;
      text-transform: capitalize;
    }
    .chip[aria-pressed="true"] {
      background: var(--primary-color);
      border-color: var(--primary-color);
      color: var(--text-primary-color, #fff);
      font-weight: 500;
    }
    .chip:disabled {
      opacity: 0.35;
      cursor: default;
    }
    .shortcut {
      font-size: 12px;
      color: var(--primary-color);
      font-weight: 500;
      padding: 6px 4px;
    }
    .apply {
      padding: 8px 14px;
      border-radius: 8px;
      background: var(--secondary-background-color);
      font-weight: 500;
      font-size: 13px;
      justify-self: start;
    }
    .apply:disabled {
      opacity: 0.45;
      cursor: default;
    }
    .footer {
      position: sticky;
      bottom: 0;
      z-index: 5;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
      padding: 12px 0;
      background: var(--card-background-color);
      border-top: 1px solid var(--divider-color);
    }
    .footer p {
      margin: 0 auto 0 0;
      font-size: 13px;
      color: var(--secondary-text-color);
      min-width: 0;
    }
    .footer p.error {
      color: var(--error-color);
    }
    .action {
      min-height: 38px;
      padding: 7px 16px;
      border-radius: 8px;
      font-weight: 500;
    }
    .action.primary {
      background: var(--primary-color);
      color: var(--text-primary-color, #fff);
    }
    .action:disabled {
      opacity: 0.45;
      cursor: default;
    }
    :focus-visible {
      outline: 2px solid var(--primary-color);
      outline-offset: 2px;
    }
  `;

  firstUpdated(): void {
    void this._load();
  }

  /** Called by the host dialog for its close button, the backdrop and Esc. */
  public requestClose(): void {
    if (!this._readonly && this._changeCount() > 0) {
      this._confirming = true;
      return;
    }
    this._close();
  }

  private _close(): void {
    this.dispatchEvent(new CustomEvent("editor-closed"));
  }

  private _t(key: TranslationKey, params?: Record<string, string | number>): string {
    return localize(key, this.hass.language, params);
  }

  // ─── Loading ─────────────────────────────────────────────────────

  private async _load(): Promise<void> {
    this._loading = true;
    this._loadError = "";
    try {
      const { item, editable } = await loadSchedule(this.hass, this.entityId);
      this._applyLoaded(item);
      this._readonly = !editable;
    } catch (err) {
      this._loadError = this._t("schedule_editor.load_error", { message: this._messageOf(err) });
    }
    this._loading = false;
    if (this.selectName) {
      await this.updateComplete;
      this.renderRoot.querySelector<HTMLInputElement>(".name")?.select();
    }
  }

  private _applyLoaded(item: ScheduleItem): void {
    this._item = item;
    this._name = item.name;
    this._savedName = item.name;
    this._week = toDraftWeek(item);
    this._savedWeek = this._week;
    this._selection = { day: "monday", key: null };
    this._conflict = false;
  }

  private _messageOf(err: unknown): string {
    return (err as { message?: string } | null)?.message ?? String(err);
  }

  // ─── Derived values ──────────────────────────────────────────────

  private get _comfort(): Temps {
    return {
      heat: toDisplay(this.comfortHeat, this.hass),
      cool: toDisplay(this.comfortCool, this.hass),
    };
  }

  private get _eco(): Temps {
    return { heat: toDisplay(this.ecoHeat, this.hass), cool: toDisplay(this.ecoCool, this.hass) };
  }

  private get _validation(): ValidationContext {
    return {
      climateMode: this.climateMode,
      comfort: this._comfort,
      minTemp: toDisplay(MIN_TARGET_TEMP_C, this.hass),
      maxTemp: toDisplay(MAX_TARGET_TEMP_C, this.hass),
    };
  }

  private get _scale() {
    const convert = ([lo, hi]: [number, number]): [number, number] => [
      toDisplay(lo, this.hass),
      toDisplay(hi, this.hass),
    ];
    return { heat: convert(SCALE_CELSIUS.heat), cool: convert(SCALE_CELSIUS.cool) };
  }

  private get _step(): number {
    return Number(tempStep(this.hass));
  }

  private get _selectedBlock(): DraftBlock | null {
    const { day, key } = this._selection;
    return this._week[day].find((b) => b.key === key) ?? null;
  }

  private _changeCount(): number {
    return (
      countChangedDays(this._week, this._savedWeek) + (this._name !== this._savedName ? 1 : 0)
    );
  }

  private _dayName(day: Weekday, style: "short" | "long"): string {
    return weekdayName(this.hass.language, WEEKDAYS.indexOf(day), style);
  }

  // ─── Rendering ───────────────────────────────────────────────────

  render() {
    if (this._loading) return html`<p>${this._t("schedule_editor.loading")}</p>`;
    if (this._loadError) {
      return html`<p class="problem">${this._loadError}</p>
        <div class="footer">
          <p></p>
          <button class="action" @click=${this._close}>${this._t("schedule_editor.close")}</button>
        </div>`;
    }
    const uses = countOtherUses(this.rooms, this.areaId, this.entityId);
    return html`
      <div class="stack">
        <input
          class="name"
          aria-label=${this._t("schedule_editor.name_label")}
          .value=${this._name}
          ?readonly=${this._readonly}
          @input=${this._onNameInput}
        />
        ${this._readonly
          ? html`<div class="notice">${this._t("schedule_editor.readonly_notice")}</div>`
          : nothing}
        ${!this._readonly && uses > 0
          ? html`<div class="notice">
              ${this._t("schedule_editor.shared_notice", { count: uses })}
            </div>`
          : nothing}
        ${this._renderLegend()}
        <rs-schedule-timeline
          .week=${this._week}
          .validation=${this._validation}
          .eco=${this._eco}
          .scale=${this._scale}
          .step=${this._step}
          .selection=${this._selection}
          .readonly=${this._readonly}
          .language=${this.hass.language}
          .emptyLabel=${this._t("schedule_editor.all_day_eco")}
          .flashDays=${this._flashDays}
          @block-select=${this._onBlockSelect}
          @day-select=${this._onDaySelect}
          @block-add=${this._onBlockAdd}
          @block-change=${this._onBlockChange}
        ></rs-schedule-timeline>
        ${this._readonly
          ? nothing
          : html`<p class="hint">${this._t("schedule_editor.gesture_hint")}</p>
              ${this._renderPanel()}`}
        ${this._renderFooter()}
      </div>
    `;
  }

  private _renderLegend() {
    const side = mainSide(this.climateMode);
    const unit = tempUnit(this.hass);
    const format = (value: number) =>
      new Intl.NumberFormat(this.hass.language, { maximumFractionDigits: 1 }).format(value);
    const swatch = side === "heat" ? "var(--warning-color, #ff9800)" : "#2196f3";
    return html`<div class="legend" style="--swatch:${swatch}">
      <span><i class="swatch block"></i>${this._t("schedule_editor.legend_block")}</span>
      <span
        ><i class="swatch comfort"></i>${this._t("schedule_editor.legend_comfort", {
          temp: format(this._comfort[side]),
          unit,
        })}</span
      >
      <span
        ><i class="swatch eco"></i>${this._t("schedule_editor.legend_eco", {
          temp: format(this._eco[side]),
          unit,
        })}</span
      >
    </div>`;
  }

  private _renderPanel() {
    const { day } = this._selection;
    const block = this._selectedBlock;
    return html`<section class="panel">
      ${block ? this._renderBlockFields(day, block) : this._renderDaySummary(day)}
      ${this._renderCopy(day)}
    </section>`;
  }

  private _renderDaySummary(day: Weekday) {
    const count = this._week[day].length;
    return html`<div class="panel-title">
        <div>
          <h3>${this._dayName(day, "long")}</h3>
          <p>
            ${count
              ? this._t("schedule_editor.day_blocks", { count })
              : this._t("schedule_editor.day_empty")}
          </p>
        </div>
      </div>
      <button class="add" @click=${this._onAddClick}>${this._t("schedule_editor.add_block")}</button>`;
  }

  private _renderBlockFields(day: Weekday, block: DraftBlock) {
    const untilMidnight = block.to === 86400;
    const summary =
      block.to > block.from
        ? formatDuration(block.to - block.from)
        : this._t("schedule_editor.time_invalid");
    return html`<div class="panel-title">
        <div>
          <h3>${this._dayName(day, "long")}</h3>
          <p>${formatHm(block.from)} – ${formatHm(block.to)} · ${summary}</p>
        </div>
        <button class="delete" @click=${this._onDeleteClick}>
          ${this._t("schedule_editor.delete_block")}
        </button>
      </div>
      <div class="fields">
        <div class="times">
          <label class="field"
            >${this._t("schedule_editor.start")}
            <input
              type="time"
              .value=${formatHm(block.from)}
              @change=${(e: Event) => this._onTimeChange(e, "from")}
            />
          </label>
          <label class="field"
            >${this._t("schedule_editor.end")}
            <input
              type="time"
              .value=${untilMidnight ? "" : formatHm(block.to)}
              ?disabled=${untilMidnight}
              @change=${(e: Event) => this._onTimeChange(e, "to")}
            />
          </label>
          <label class="midnight">
            <input type="checkbox" .checked=${untilMidnight} @change=${this._onMidnightChange} />
            ${this._t("schedule_editor.until_midnight")}
          </label>
        </div>
        ${this.climateMode !== "cool_only" ? this._renderStepper(block, "heat") : nothing}
        ${this.climateMode !== "heat_only" ? this._renderStepper(block, "cool") : nothing}
      </div>
      ${validateBlock(block, this._week[day], this._validation).map(
        (problem) => html`<p class="problem" role="alert">${this._problemText(problem)}</p>`,
      )}`;
  }

  private _renderStepper(block: DraftBlock, side: TempSide) {
    const own = blockTemp(block.data, side);
    const value = own ?? this._comfort[side];
    const formatted = new Intl.NumberFormat(this.hass.language, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(value);
    return html`<div class="temp ${side}">
      <header>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d=${side === "heat" ? ICON_FIRE : ICON_SNOW}></path>
        </svg>
        ${this._t(side === "heat" ? "schedule_editor.heat" : "schedule_editor.cool")}
        <button
          class="comfort-chip"
          aria-pressed=${own === null ? "true" : "false"}
          @click=${() => this._onComfortToggle(side)}
        >
          ${this._t("schedule_editor.comfort")}
        </button>
      </header>
      <div class="stepper ${own === null ? "is-comfort" : ""}">
        <button
          aria-label=${this._t("schedule_editor.lower")}
          @click=${() => this._onStep(side, -this._step)}
        >
          −
        </button>
        <output>${formatted}<small>${tempUnit(this.hass)}</small></output>
        <button
          aria-label=${this._t("schedule_editor.raise")}
          @click=${() => this._onStep(side, this._step)}
        >
          +
        </button>
      </div>
    </div>`;
  }

  private _problemText(problem: BlockProblem): string {
    switch (problem.code) {
      case "time_order":
        return this._t("schedule_editor.problem_time_order");
      case "overlap":
        return this._t("schedule_editor.problem_overlap", {
          from: formatHm(problem.from),
          to: formatHm(problem.to),
        });
      case "temp_range":
        return this._t("schedule_editor.problem_temp_range", {
          value: problem.value,
          min: Math.round(this._validation.minTemp),
          max: Math.round(this._validation.maxTemp),
          unit: tempUnit(this.hass),
        });
      case "heat_above_cool":
        return this._t("schedule_editor.problem_heat_above_cool");
    }
  }

  private _renderCopy(day: Weekday) {
    const dayName = this._dayName(day, "long");
    const count = this._copyTargets.size;
    return html`<div class="copy">
      <h4>${this._t("schedule_editor.copy_title", { day: dayName })}</h4>
      <div class="chips">
        ${WEEKDAYS.map(
          (target) => html`<button
            class="chip"
            aria-pressed=${this._copyTargets.has(target) ? "true" : "false"}
            ?disabled=${target === day}
            @click=${() => this._onToggleTarget(target)}
          >
            ${this._dayName(target, "short")}
          </button>`,
        )}
        <button class="shortcut" @click=${() => this._onShortcut(WEEKDAYS.slice(0, 5))}>
          ${this._t("schedule_editor.shortcut_weekdays")}
        </button>
        <button class="shortcut" @click=${() => this._onShortcut(WEEKDAYS.slice(5))}>
          ${this._t("schedule_editor.shortcut_weekend")}
        </button>
        <button class="shortcut" @click=${() => this._onShortcut([...WEEKDAYS])}>
          ${this._t("schedule_editor.shortcut_all")}
        </button>
      </div>
      <button class="apply" ?disabled=${count === 0} @click=${this._onApplyCopy}>
        ${count
          ? this._t("schedule_editor.copy_apply", { day: dayName, count })
          : this._t("schedule_editor.copy_pick")}
      </button>
    </div>`;
  }

  private _renderFooter() {
    if (this._readonly) {
      return html`<div class="footer">
        <p></p>
        <button class="action" @click=${this._close}>${this._t("schedule_editor.close")}</button>
      </div>`;
    }
    const changes = this._changeCount();
    if (this._conflict) {
      return html`<div class="footer">
        <p class="error">${this._t("schedule_editor.conflict")}</p>
        <button class="action" @click=${this._onReload}>
          ${this._t("schedule_editor.conflict_reload")}
        </button>
        <button class="action primary" @click=${() => this._save(true)}>
          ${this._t("schedule_editor.conflict_overwrite")}
        </button>
      </div>`;
    }
    if (this._confirming) {
      return html`<div class="footer">
        <p>${this._t("schedule_editor.discard_question", { count: changes })}</p>
        <button class="action" @click=${() => (this._confirming = false)}>
          ${this._t("schedule_editor.keep_editing")}
        </button>
        <button class="action primary" @click=${this._close}>
          ${this._t("schedule_editor.discard")}
        </button>
      </div>`;
    }
    const valid = weekIsValid(this._week, this._validation) && this._name.trim() !== "";
    const status = this._error
      ? this._error
      : !valid
        ? this._t("schedule_editor.footer_invalid")
        : changes
          ? this._t("schedule_editor.footer_changes", { count: changes })
          : this._message || this._t("schedule_editor.footer_none");
    return html`<div class="footer">
      <p class=${this._error || !valid ? "error" : ""} role="status">${status}</p>
      <button class="action" @click=${() => this.requestClose()}>
        ${this._t("schedule_editor.cancel")}
      </button>
      <button
        class="action primary"
        ?disabled=${!changes || !valid || this._saving}
        @click=${() => this._save(false)}
      >
        ${this._t("schedule_editor.save")}
      </button>
    </div>`;
  }

  // ─── Editing ─────────────────────────────────────────────────────

  private _setWeek(week: DraftWeek): void {
    this._week = week;
    this._error = "";
    this._message = "";
    this._confirming = false;
  }

  private _patchSelected(patch: BlockPatch): void {
    const { day, key } = this._selection;
    if (key !== null) this._setWeek(updateBlock(this._week, day, key, patch));
  }

  private _selectDay(day: Weekday, key: number | null): void {
    if (this._selection.day !== day) {
      const targets = new Set(this._copyTargets);
      targets.delete(day);
      this._copyTargets = targets;
    }
    this._selection = { day, key };
  }

  private _onNameInput(e: Event): void {
    this._name = (e.target as HTMLInputElement).value;
    this._error = "";
    this._message = "";
  }

  private _onBlockSelect(e: CustomEvent<{ day: Weekday; key: number }>): void {
    this._selectDay(e.detail.day, e.detail.key);
  }

  private _onDaySelect(e: CustomEvent<{ day: Weekday }>): void {
    this._selectDay(e.detail.day, null);
  }

  private _onBlockAdd(e: CustomEvent<{ day: Weekday; from: number; to: number }>): void {
    const { day, from, to } = e.detail;
    const added = addBlock(this._week, day, from, to);
    this._setWeek(added.week);
    this._selectDay(day, added.key);
  }

  private _onBlockChange(e: CustomEvent<{ day: Weekday; key: number; patch: BlockPatch }>): void {
    const { day, key, patch } = e.detail;
    this._setWeek(updateBlock(this._week, day, key, patch));
  }

  private _onAddClick(): void {
    const { day } = this._selection;
    for (let seconds = 8 * 3600; seconds < 86400; seconds += 1800) {
      const range = newBlockRange(this._week[day], seconds);
      if (range) {
        const added = addBlock(this._week, day, range.from, range.to);
        this._setWeek(added.week);
        this._selectDay(day, added.key);
        return;
      }
    }
  }

  private _onDeleteClick(): void {
    const { day, key } = this._selection;
    if (key === null) return;
    this._setWeek(removeBlock(this._week, day, key));
    this._selection = { day, key: null };
  }

  private _onTimeChange(e: Event, field: "from" | "to"): void {
    const value = (e.target as HTMLInputElement).value;
    if (value) this._patchSelected({ [field]: parseTime(value) });
  }

  private _onMidnightChange(e: Event): void {
    const block = this._selectedBlock;
    if (!block) return;
    const checked = (e.target as HTMLInputElement).checked;
    this._patchSelected({ to: checked ? 86400 : Math.min(block.from + 3600, 85500) });
  }

  private _onStep(side: TempSide, delta: number): void {
    const block = this._selectedBlock;
    if (!block) return;
    const { minTemp, maxTemp, comfort } = this._validation;
    const current = blockTemp(block.data, side) ?? comfort[side];
    const value = snapTemp(current + delta, this._step, minTemp, maxTemp);
    this._patchSelected({ data: setBlockTemp(block.data, side, value) });
  }

  private _onComfortToggle(side: TempSide): void {
    const block = this._selectedBlock;
    if (!block) return;
    const isComfort = blockTemp(block.data, side) === null;
    const value = isComfort ? this._comfort[side] : null;
    this._patchSelected({ data: setBlockTemp(block.data, side, value) });
  }

  private _onToggleTarget(target: Weekday): void {
    const targets = new Set(this._copyTargets);
    if (targets.has(target)) targets.delete(target);
    else targets.add(target);
    this._copyTargets = targets;
  }

  private _onShortcut(days: readonly Weekday[]): void {
    this._copyTargets = new Set(days.filter((d) => d !== this._selection.day));
  }

  private _onApplyCopy(): void {
    const { day } = this._selection;
    const targets = [...this._copyTargets];
    this._setWeek(copyDay(this._week, day, targets));
    this._flashDays = new Set(targets);
    this._copyTargets = new Set();
    setTimeout(() => (this._flashDays = new Set()), 900);
    this._message = this._t("schedule_editor.copied", {
      day: this._dayName(day, "long"),
      count: targets.length,
    });
  }

  // ─── Saving ──────────────────────────────────────────────────────

  private async _onReload(): Promise<void> {
    this._loading = true;
    try {
      const latest = await fetchSchedule(this.hass, this._item!.id);
      this._applyLoaded(latest);
    } catch (err) {
      this._conflict = false;
      this._error = isNotFound(err)
        ? this._t("schedule_editor.not_found")
        : this._t("schedule_editor.save_error", { message: this._messageOf(err) });
    }
    this._loading = false;
  }

  private async _save(overwrite: boolean): Promise<void> {
    const item = this._item;
    if (!item) return;
    this._saving = true;
    this._error = "";
    try {
      if (!overwrite) {
        const latest = await fetchSchedule(this.hass, item.id);
        if (!sameItem(latest, item)) {
          this._conflict = true;
          return;
        }
      }
      const payload = toUpdatePayload(this._name.trim(), item.icon, this._week);
      this._item = await updateSchedule(this.hass, item.id, payload);
      this._name = this._name.trim();
      this._savedName = this._name;
      this._savedWeek = this._week;
      this._conflict = false;
      this._message = this._t("schedule_editor.saved");
    } catch (err) {
      this._conflict = false;
      this._error = isNotFound(err)
        ? this._t("schedule_editor.not_found")
        : this._t("schedule_editor.save_error", { message: this._messageOf(err) });
    } finally {
      this._saving = false;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "rs-schedule-editor": RsScheduleEditor;
  }
}
```

- [ ] **Step 2: Check**

Run: `npx prettier --write src/components/rs-schedule-editor.ts && npx tsc --noEmit && npx eslint src/`
Expected: no errors. If the `switch` in `_problemText` fails a lint rule about missing returns, keep it exhaustive and adjust only the lint-reported line.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/rs-schedule-editor.ts
git commit -m "feat: add schedule editor component" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Panel integration and real test

**Files:**
- Modify: `frontend/src/components/rs-schedule-settings.ts` (imports area, `_renderEditMode`, `_renderScheduleList`, event helpers)
- Modify: `frontend/src/components/rs-room-detail.ts:38,44,75,363-365,655-663,712-733`
- Modify: `frontend/src/roommind-panel.ts:486-501`
- Modify: `README.md:21,69`

**Interfaces:**
- Consumes: `<rs-schedule-editor>` and its `requestClose()` and `editor-closed` from Task 5; `createSchedule`, `findScheduleEntityId` from Task 3.
- Produces: `rs-schedule-settings` events `schedule-edit` `{ entityId }` and `schedule-create`, both bubbling and composed; `rs-room-detail` property `rooms`.

- [ ] **Step 1: Add the buttons to the schedule settings**

In `frontend/src/components/rs-schedule-settings.ts`, in `_renderScheduleList`, insert before `${this._renderScheduleControls(`:

```ts
              ${
                this.hass.user?.is_admin
                  ? html`<ha-icon-button
                      .path=${ICON_EDIT}
                      .label=${localize("schedule.edit", l)}
                      @click=${() => this._emitEdit(schedule.entity_id)}
                    ></ha-icon-button>`
                  : nothing
              }
```

In `_renderEditMode`, insert right after the `_renderAddRow(...)` expression:

```ts
      ${
        this.hass.user?.is_admin
          ? html`<button class="new-schedule" @click=${this._emitCreate}>
              <ha-icon icon="mdi:calendar-plus"></ha-icon>
              ${localize("schedule.new", l)}
            </button>`
          : nothing
      }
```

Add after the `WEEKDAYS` constant:

```ts
const ICON_EDIT =
  "M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z";
```

Add these methods right before `private _addSchedule`:

```ts
  private _emitEdit(entityId: string) {
    this.dispatchEvent(
      new CustomEvent("schedule-edit", {
        detail: { entityId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _emitCreate() {
    this.dispatchEvent(new CustomEvent("schedule-create", { bubbles: true, composed: true }));
  }
```

Add inside the component's `css` block, after `.preheat-toggle { ... }`:

```css
      .new-schedule {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin-top: 12px;
        padding: 8px 14px;
        border: 1px solid var(--divider-color);
        border-radius: 8px;
        background: none;
        color: var(--primary-color);
        font: inherit;
        font-weight: 500;
        cursor: pointer;
      }
      .new-schedule ha-icon {
        --mdc-icon-size: 18px;
      }
```

- [ ] **Step 2: Open the editor from the room**

In `frontend/src/components/rs-room-detail.ts`:

Add to the imports:

```ts
import "./rs-schedule-editor";
import type { RsScheduleEditor } from "./rs-schedule-editor";
import { createSchedule, findScheduleEntityId } from "../utils/schedule-api";
```

Replace the `EditableSection` type:

```ts
type EditableSection =
  | "schedule"
  | "scheduleEditor"
  | "devices"
  | "sensors"
  | "presence"
  | "covers"
  | "heatSource";
```

Add after `public config`:

```ts
  @property({ attribute: false }) public rooms: Record<string, RoomConfig> = {};
```

Add after `_editing`:

```ts
  @state() private _editorEntity = "";
  @state() private _editorSelectName = false;
  @state() private _createError = "";
```

Add after `_closeEdit`:

```ts
  private _onScheduleEdit = (e: CustomEvent<{ entityId: string }>) => {
    this._editorEntity = e.detail.entityId;
    this._editorSelectName = false;
    this._createError = "";
    this._editing = "scheduleEditor";
  };

  private _onScheduleCreate = async () => {
    this._createError = "";
    try {
      const name = this._displayName || this.area.name;
      const item = await createSchedule(this.hass, name);
      const entityId = await findScheduleEntityId(this.hass, item.id);
      this._schedules = [...this._schedules, { entity_id: entityId }];
      this._autoSave();
      this._editorEntity = entityId;
      this._editorSelectName = true;
      this._editing = "scheduleEditor";
    } catch (err) {
      this._createError = (err as { message?: string } | null)?.message ?? String(err);
    }
  };

  private _requestEditorClose = () => {
    this.renderRoot.querySelector<RsScheduleEditor>("rs-schedule-editor")?.requestClose();
  };
```

In `_renderEditDialog`, add this case before `case "schedule":`:

```ts
      case "scheduleEditor":
        return html`<rs-edit-dialog
          open
          icon="mdi:calendar-edit"
          .heading=${localize("schedule_editor.heading", lang)}
          @rs-dialog-closed=${this._requestEditorClose}
        >
          <rs-schedule-editor
            .hass=${this.hass}
            .entityId=${this._editorEntity}
            .climateMode=${this._climateMode}
            .comfortHeat=${this._comfortHeat}
            .comfortCool=${this._comfortCool}
            .ecoHeat=${this._ecoHeat}
            .ecoCool=${this._ecoCool}
            .rooms=${this.rooms}
            .areaId=${this.area.area_id}
            .selectName=${this._editorSelectName}
            @editor-closed=${() => (this._editing = "schedule")}
          ></rs-schedule-editor>
        </rs-edit-dialog>`;
```

In the `case "schedule":` dialog, insert right after `<div slot="info">`:

```ts
            <p>${unsafeHTML(localize("schedule.help_editor", lang))}</p>
```

Insert right before the `<rs-schedule-settings` element of that same dialog, the one with `.editing=${true}`:

```ts
          ${this._createError ? html`<div class="error">${this._createError}</div>` : nothing}
```

On that same element, add after `@preheat-changed=${this._onPreheatChanged}`:

```ts
            @schedule-edit=${this._onScheduleEdit}
            @schedule-create=${this._onScheduleCreate}
```

- [ ] **Step 3: Pass the rooms**

In `frontend/src/roommind-panel.ts`, on `<rs-room-detail`, add after `.config=${config}`:

```ts
            .rooms=${this._rooms}
```

- [ ] **Step 4: Update the README**

In `README.md`, insert after the `**Multi-Scheduler**` line (line 21):

```markdown
- **Visual Schedule Editor** - Create and edit a room's weekly schedule on a timeline in the panel: drag a block's sides, body and top handle to change its times and temperature, and copy a day to other days. Schedules stay in standard `schedule.*` helpers.
```

Replace step 5 of the quick start (line 69):

```markdown
5. **Add a schedule** - in the room's schedule section, select **New schedule** to draw one on a timeline, or assign an existing `schedule.*` helper
```

- [ ] **Step 5: Run all checks**

Run from `frontend/`:

```bash
npx prettier --write src/
npm test
npm run lint
npm run build
```

Expected: every command succeeds, and `custom_components/roommind/frontend/roommind-panel.js` is built.

Run from the repo root:

```bash
.venv/Scripts/python -m pytest tests/ -q --cov=custom_components/roommind --cov-fail-under=95
.venv/Scripts/ruff check custom_components/ tests/
.venv/Scripts/ruff format --check custom_components/ tests/
.venv/Scripts/mypy custom_components/roommind/
```

Expected: tests pass with coverage at 95% or above; ruff and mypy report no errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/rs-schedule-settings.ts frontend/src/components/rs-room-detail.ts frontend/src/roommind-panel.ts README.md
git commit -m "feat: open the visual schedule editor from the room panel" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Test in a real Home Assistant**

Deploying to the user's Home Assistant changes a live system, so confirm with the user first. Use `deploy.sh` or the `.devcontainer` environment, whichever the user chooses, then hard-refresh the browser. Check each item and report failures with what you saw:

1. **Create:** in a test room, **New schedule** creates the helper, assigns it and opens the editor with the name selected.
2. **Draw:** tapping a slot adds a block; dragging the sides, body and top handle updates the times, bubble and temperature, with a mouse.
3. **Limits:** blocks stop at neighbors and at the day boundaries; heating cannot be dragged above cooling in `auto`.
4. **Copy:** copy Monday to the weekdays and save.
5. **Save:** reopening shows the same data, and the helper's Settings page in HA shows the same blocks.
6. **Data safety:** give a block a foreign `data` key in YAML mode from HA's helper UI, save an edit to another day, and confirm the key survives.
7. **Conflict:** with the editor open, change the helper from HA's UI. **Save** must offer **Reload** and **Overwrite**.
8. **Modes:** switch the room to `heat_only` and `cool_only`. Only the relevant stepper appears, and the status text shows one value.
9. **YAML helper:** if one is available, it opens read-only and blocks ending at midnight display as 24:00.
10. **Non-admin user:** no **Edit** or **New schedule** button.
11. **Close:** `Esc`, the backdrop and the close button with pending changes ask for confirmation.
12. **Touch and mobile:** at phone width or on a phone, grips work after selection and swiping over other blocks scrolls the page.
13. **Themes and languages:** check light and dark, and the panel in Italian.
14. **Engine:** within about 30 seconds the room's target follows a block running now, including a block ending at midnight. Check the HA log for no RoomMind errors from `find_active_block`.
15. **Fahrenheit:** if practical, on a °F test system the scale and steps stay sensible.

- [ ] **Step 8: Fix what the test found**

Fix each failure with its own small commit (`fix: ...`), then rerun Step 5 and the failed checks.
