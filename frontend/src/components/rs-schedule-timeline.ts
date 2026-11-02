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
          ${
            this._bubble?.day === day
              ? html`<span
                  class="bubble"
                  style="left:${this._bubble.left}%;bottom:calc(${this._bubble.bottom}% + 12px)"
                  >${this._bubble.text}</span
                >`
              : nothing
          }
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
        ${
          this.readonly
            ? nothing
            : html`<span class="grip left" data-grip="left"></span>
                <span class="grip right" data-grip="right"></span>
                <span class="grip temp" data-grip="temp"></span>`
        }
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
