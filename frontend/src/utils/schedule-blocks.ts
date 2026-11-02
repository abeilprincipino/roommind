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
