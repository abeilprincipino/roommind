# Visual temperature schedule editor

Status: design approved, spec under review. Date: 2026-11-02.
Reference mockup: <https://claude.ai/artifact/GnUdp8ur5Dz3torb7UBxju> (version 2, approved).

## Goal

To give a time slot its own temperature today, you create a `schedule.*` helper in Home Assistant and write its data by hand in YAML. The editor lets you create and edit a room's weekly schedule directly from the RoomMind panel, on a timeline you operate by dragging.

## Scope

Included:

- editing existing `schedule.*` helpers assigned to a room;
- creating a new helper from the room and assigning it automatically;
- copying a day to other days;
- resizing, moving and changing temperature directly on the timeline.

Excluded:

- dragging a block from one day to another;
- deleting helpers;
- templates, Profiles and Modes like Velair's;
- `hvac_mode`, preset or fan actions in blocks, which remain decisions of the RoomMind engine;
- an editor for cover schedules;
- multi-level undo: **Cancel** discards the whole draft;
- locale-based first day of the week: the week always starts on Monday.

## Architecture

The panel calls Home Assistant's WebSocket commands directly. **The control engine does not change**: RoomMind rereads the blocks with `schedule.get_schedule` on every cycle ([coordinator.py](../../../custom_components/roommind/coordinator.py)), so a change takes effect within about 30 seconds.

A backend `roommind/*` command was rejected: to write, it would have to use internal APIs of the `schedule` integration, which are more fragile and bring no benefit.

### Home Assistant APIs used

| Purpose | Command | Notes |
|---|---|---|
| Read schedules | `schedule/list` | Returns only helpers created from the UI |
| Create | `schedule/create` | Admin only. The ID derives from the name, with a suffix on collision |
| Save | `schedule/update` with `schedule_id` | Admin only. **Replaces the entire helper** |
| `entity_id` to ID | `config/entity_registry/get` | The helper ID is the `unique_id` field |
| ID to `entity_id` | `config/entity_registry/list` | Filter on `platform === "schedule"` and `unique_id` |

YAML helpers have the state attribute `editable: false` and cannot be reached through these commands.

### Units

| File | Responsibility |
|---|---|
| `frontend/src/utils/schedule-blocks.ts` | Pure logic with no Lit or HA: data conversion, validation, drag limits, day copy, save payload |
| `frontend/src/utils/schedule-api.ts` | The WebSocket calls listed above |
| `frontend/src/components/rs-schedule-timeline.ts` | Weekly grid and gestures; receives blocks and emits events, knows nothing about saving |
| `frontend/src/components/rs-schedule-editor.ts` | Draft, block panel, day copy, saving and errors |

Changes to existing files:

- `rs-schedule-settings.ts`: **Edit** and **New schedule** buttons; status text fix.
- `rs-room-detail.ts`: opens the editor in the existing `rs-edit-dialog` and returns to the "Schedule" dialog on close. Updates the help text, which today explains only the YAML method.
- `roommind-panel.ts`: passes `.rooms` to `rs-room-detail`, to count a helper's uses.
- `types/index.ts`: adds `user?: { is_admin: boolean }` to `HomeAssistant`, plus the editor types.
- `locales/{en,de,fr,it}.json`: new strings.
- `README.md`: describes the editor.

## Data

### Draft model

- Times are seconds from midnight, from 0 to 86400. The seconds of an existing helper stay unchanged until that side of the block is edited.
- `"24:00:00"` maps to 86400, for both reading and writing.
- Each block keeps its original `data` object.

### Temperatures

- The editor always writes `heat_temperature` and `cool_temperature`, never the single `temperature` field, which in an `auto` room would collapse heating and cooling to one value.
- `auto` shows both sides, `heat_only` only heating, `cool_only` only cooling. The hidden side is preserved.
- Empty side, meaning the key is absent: the room's comfort temperature applies. The UI shows this as the **Comfort** chip.
- A new block starts with no temperatures, so in comfort.
- A block with the old `temperature` field is converted only when edited: `temperature: T` becomes `heat_temperature: T` and `cool_temperature: T`. Untouched blocks stay identical.
- Values are in HA's unit, as they are today: no conversion to Celsius on save. Step and limits come from the existing functions in `utils/temperature.ts`.

### Saving

The `schedule/update` payload always contains `name`, `icon` when present, and all seven days. `data` keys unrelated to RoomMind are preserved.

Before saving, the editor rereads `schedule/list`. If the helper changed since it was loaded when the editor opened, it asks whether to **reload**, losing the draft, or **overwrite**.

## Interface

### Entry points

In the room's "Schedule" dialog, each helper row has **Edit**, and **New schedule** appears next to the list.

| Situation | Behavior |
|---|---|
| Non-admin user | No **Edit** or **New schedule** button |
| YAML helper | The editor opens read-only, with a notice |
| New schedule | Creates the helper with a default name, assigns it to the room and opens the editor with the name selected |

### Timeline

One row per day, Monday to Sunday, with a grid every 3 hours, stronger lines every 6, and labels 00, 06, 12, 18, 24.

- **Block:** width is duration; height and color are the temperature of the main side, meaning heating in `auto` and `heat_only`, cooling in `cool_only`.
- **Height scale:** 14–26 °C for heating and 18–30 °C for cooling, with cooling inverted. On °F systems the limits are converted.
- **Outside blocks:** hatched band at the actual height of the room's eco temperature.
- **Block in comfort:** dashed top edge.
- **Labels in the block:** temperature when wider than 34 px, times when wider than 92 px.
- **Selection:** outline in the primary color and visible grips; the other blocks dim.
- **Current time:** label above the grid and a vertical line on today's row.
- **Mouse over an empty slot:** dashed preview with the time.

### Gestures

| Gesture | Effect | Limits |
|---|---|---|
| Left or right edge | Changes start or end | 15 min step, 15 min minimum duration, cannot cross neighbors or the day boundaries |
| Block body | Moves the slot | Same limits, duration unchanged; stays put if there is not enough room |
| Top grip | Changes the main side's temperature | `tempStep` step, within the scale; in `auto`, heating cannot exceed effective cooling |
| Tap or click on an empty slot | Creates a 1-hour block from the previous half hour | Shortened so it does not touch the next block |
| Tap or click on a block | Selects it | |
| Tap or click on the day name | Selects the day, with **Add block** | |

During a drag, a floating label shows the times and duration, or the temperature.

Technical choices:

- Pointer Events with listeners on `window`.
- A 4 px threshold distinguishes a drag from a click.
- During the gesture the block is updated in place without recreating the node: replacing it would end a touch gesture.

**Touch:** grips have a 26 px touch area and are visible only on the selected block, which moves only after selection. Other blocks use `touch-action: pan-y`, so the page keeps scrolling.

**Keyboard:** on the focused block, left and right move it by 15 minutes, `Shift` with the arrows changes the end, up and down change the temperature, `Enter` and space select.

**Reduced motion:** with `prefers-reduced-motion`, animations are turned off.

### Block panel

Below the timeline:

- day, times and duration;
- **Start** and **End** fields, with the **Until midnight** checkbox;
- steppers for heating and cooling depending on the mode, each with the **Comfort** chip;
- **Delete block**;
- block errors.

Time fields use native `<input type="time">` with HA theme variables: HA's elements have changed several times (the panel already includes a polyfill for `ha-textfield`), and the native field works on all supported versions.

### Day copy

Target days are picked with chips and the **Weekdays**, **Weekend** and **All** shortcuts. The button states the effect: "Replace 4 days with Monday". Copying changes the draft; **Save** makes it final.

### Draft and saving

- Nothing is written until **Save**, which is disabled when there are no changes or there are errors.
- The dialog footer stays visible and shows how many changes there are.
- **Cancel**, `Esc` or closing with pending changes asks for confirmation inside the dialog.
- After saving, a message says RoomMind applies it within 30 seconds.

### Style

- Same typography as the panel, with large light-weight numerals as in the room card.
- Heating derives from `--warning-color` and cooling from `#2196f3`, the same colors already used for modes in `shared-mode-styles.ts`. Shades use `color-mix`.
- All other surfaces use HA theme variables, in light and dark.
- At 600 px and below, the dialog is full screen and the rows get shorter.

## Validation and errors

| Case | Behavior |
|---|---|
| Start not before end | Error on the block, **Save** disabled |
| Overlapping blocks, possible only through the time fields | Error naming the conflicting block, **Save** disabled |
| Temperature outside the valid range | Prevented by stepper and grip; an existing invalid value is flagged on the block and blocks **Save** until corrected |
| In `auto`, heating above effective cooling | Error on the block, **Save** disabled |
| Helper used by other rooms or by covers | Persistent notice with the number of uses, saving allowed |
| Error from the HA command, including a user without permission | Message in the dialog, draft preserved |
| Helper deleted while the editor is open | HA answers "not found": dedicated message, draft preserved so it can be copied |
| Block past midnight | Not supported: it must be split into two blocks, as HA requires |

## Related fixes

- **Status text:** in `heat_only` and `cool_only`, `_getStatusText` in `rs-schedule-settings.ts` must show only the relevant value, not "21 / 24".
- **Blocks ending at midnight:** `find_active_block` in `schedule_utils.py` has no test for this case and would fail on the string `"24:00:00"`. `schedule.get_schedule` returns a `time` object, so this should not happen. A backend test pins the behavior with `time.max`; if verification during implementation also shows the string form, it must be handled.

## Testing

- **`vitest`:** new dev dependency, used only for `schedule-blocks.ts`, with an `npm test` script and a step in `.github/workflows/ci.yml`. Covers conversions, `24:00:00`, seconds, `data` preservation, conversion of the old `temperature`, validation, gesture limits, day copy and the complete payload.
- **Backend:** test on `find_active_block` with `time.max` in `tests/utils/test_schedule_utils.py`.
- **Existing checks:** `npm run build`, `npm run lint`, `npm run format:check`, `pytest`, `ruff` and `mypy`.
- **Real test in the panel:** creating, editing, copying, YAML helper, non-admin user, light and dark theme, mouse and touch, mobile width, and RoomMind applying the new targets.

## Acceptance criteria

1. From a room, you create a schedule and give it slots and temperatures without writing YAML, and RoomMind applies the target within one cycle.
2. A block can be resized, moved and given a new temperature on the timeline, with mouse and touch.
3. A day can be copied to other days.
4. Saving an existing helper without touching one of its days, or its unrelated `data` keys, leaves that data identical.
5. YAML helpers and non-admin users cannot change anything.
6. All strings exist in the 4 languages and the interface is usable on mobile.
