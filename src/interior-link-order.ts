import { compareStampKeys } from "./stamps.js";
import type { StampKey } from "./types.js";

interface AddedInteriorLinkOrderMarker {
  __cmp_added_links: Record<string, StampKey>;
}

function isAddedMarker(value: unknown): value is AddedInteriorLinkOrderMarker {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<AddedInteriorLinkOrderMarker>;
  return entry.__cmp_added_links !== null && typeof entry.__cmp_added_links === "object";
}

export function addInteriorLinkOrder(order: unknown[], id: string, stamp: StampKey): unknown[] {
  if (order.some((entry) => !isAddedMarker(entry) && String(entry) === id)) return order;
  const marker = order.find(isAddedMarker);
  const additions = { ...(marker?.__cmp_added_links ?? {}), [id]: stamp };
  return [...order.filter((entry) => !isAddedMarker(entry)), id, { __cmp_added_links: additions }];
}

/** Preserve imported order, then deterministically order links added by ops. */
export function projectInteriorLinkOrder(order: unknown[]): string[] {
  const marker = order.find(isAddedMarker);
  const additions = marker?.__cmp_added_links ?? {};
  const ids = order.filter((entry) => !isAddedMarker(entry)).map(String);
  const imported = ids.filter((id) => !(id in additions));
  const added = ids.filter((id) => id in additions);
  added.sort((a, b) => compareStampKeys(additions[a]!, additions[b]!));
  return [...imported, ...added];
}

export function removeInteriorLinkOrder(order: unknown[], id: string): unknown[] {
  const marker = order.find(isAddedMarker);
  const additions = { ...(marker?.__cmp_added_links ?? {}) };
  delete additions[id];
  const retained = order.filter((entry) => isAddedMarker(entry) || String(entry) !== id);
  return marker
    ? [...retained.filter((entry) => !isAddedMarker(entry)), { __cmp_added_links: additions }]
    : retained;
}
