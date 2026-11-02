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
    const result = await hass.callWS<{
      response: Record<string, Omit<ScheduleItem, "id" | "name">>;
    }>({
      type: "call_service",
      domain: "schedule",
      service: "get_schedule",
      target: { entity_id: entityId },
      return_response: true,
    });
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
