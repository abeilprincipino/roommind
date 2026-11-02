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
  @property({ type: Boolean }) public assignOnSave = false;

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
      display: flex;
      flex-direction: column;
      gap: 16px;
      min-width: 0;
    }
    .stack > * {
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
      box-shadow: 0 24px 0 var(--card-background-color);
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
      this.renderRoot.querySelector<HTMLInputElement>(".name")?.focus();
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

  private get _draftIsValid(): boolean {
    return weekIsValid(this._week, this._validation) && this._name.trim() !== "";
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
    return countChangedDays(this._week, this._savedWeek) + (this._name !== this._savedName ? 1 : 0);
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
        ${
          this._readonly
            ? html`<div class="notice">${this._t("schedule_editor.readonly_notice")}</div>`
            : nothing
        }
        ${
          !this._readonly && uses > 0
            ? html`<div class="notice">
                ${this._t("schedule_editor.shared_notice", { count: uses })}
              </div>`
            : nothing
        }
        ${
          !this._readonly && this.assignOnSave
            ? html`<div class="notice">${this._t("schedule_editor.assign_on_save")}</div>`
            : nothing
        }
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
        ${
          this._readonly
            ? nothing
            : html`<p class="hint">${this._t("schedule_editor.gesture_hint")}</p>
                ${this._renderPanel()}`
        }
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
            ${
              count
                ? this._t("schedule_editor.day_blocks", { count })
                : this._t("schedule_editor.day_empty")
            }
          </p>
        </div>
      </div>
      <button class="add" @click=${this._onAddClick}>
        ${this._t("schedule_editor.add_block")}
      </button>`;
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
          (target) =>
            html`<button
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
        ${
          count
            ? this._t("schedule_editor.copy_apply", { day: dayName, count })
            : this._t("schedule_editor.copy_pick")
        }
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
    if (this._conflict) {
      return html`<div class="footer">
        <p class="error">
          ${this._t("schedule_editor.conflict")}${
            !this._draftIsValid ? ` ${this._t("schedule_editor.footer_invalid")}` : ""
          }
        </p>
        <button class="action" @click=${this._onReload}>
          ${this._t("schedule_editor.conflict_reload")}
        </button>
        <button
          class="action primary"
          ?disabled=${!this._draftIsValid || this._saving}
          @click=${() => this._save(true)}
        >
          ${this._t("schedule_editor.conflict_overwrite")}
        </button>
      </div>`;
    }
    const valid = this._draftIsValid;
    const status = this._error
      ? this._error
      : !valid
        ? this._t("schedule_editor.footer_invalid")
        : this._message
          ? this._message
          : changes
            ? this._t("schedule_editor.footer_changes", { count: changes })
            : this._t("schedule_editor.footer_none");
    return html`<div class="footer">
      <p class=${this._error || !valid ? "error" : ""} role="status">${status}</p>
      <button class="action" @click=${() => this.requestClose()}>
        ${this._t(changes ? "schedule_editor.cancel" : "schedule_editor.close")}
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
    const { minTemp, maxTemp } = this._validation;
    const value = isComfort ? snapTemp(this._comfort[side], this._step, minTemp, maxTemp) : null;
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
    if (!this._draftIsValid || this._saving) return;
    const week = this._week;
    const name = this._name.trim();
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
      const payload = toUpdatePayload(name, item.icon, week);
      this._item = await updateSchedule(this.hass, item.id, payload);
      if (this._name.trim() === name) this._name = name;
      this._savedName = name;
      this._savedWeek = week;
      this._conflict = false;
      this._message = this._t("schedule_editor.saved");
      this.dispatchEvent(new CustomEvent("schedule-saved"));
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
