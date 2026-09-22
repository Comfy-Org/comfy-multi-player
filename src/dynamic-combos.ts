/**
 * Selection-aware widget order for `COMFY_DYNAMICCOMBO_V3` inputs.
 *
 * A catalog entry's `widget_order` is value-blind: comfy-cli expands every
 * dynamic combo at its FIRST key. When the entry also carries
 * `dynamic_combos` (comfy-cli `nodes widget-catalog`), the order a node
 * actually has depends on its current selection, exactly as the frontend
 * builds it (`src/core/graph/widgets/dynamicWidgets.ts`): the selected
 * option's widget slots sit right after their selector, a nested selector's
 * after it, and a selection change seeds the new option's empty slots from
 * the spec defaults. Which names a write may target does NOT depend on the
 * selection (every option's slots are accepted), so an op's outcome never
 * depends on the order it arrives in relative to a selector write.
 *
 * An entry WITHOUT `dynamic_combos` is returned unchanged everywhere here, so
 * the value-blind behaviour (BE-9176 `_extra_N` placeholders) is untouched.
 */
import * as Y from "yjs";

import { mset } from "./doc.js";
import type { DynamicComboEntry, WidgetCatalogEntry } from "./types.js";

type Combos = Record<string, DynamicComboEntry>;

function combosOf(entry: WidgetCatalogEntry | undefined): Combos | undefined {
  const combos = entry?.dynamic_combos;
  return combos && Object.keys(combos).length > 0 ? combos : undefined;
}

/** Every name some option of some selector owns (any selection, any depth). */
export function optionOwnedWidgets(entry: WidgetCatalogEntry | undefined): Set<string> {
  const owned = new Set<string>();
  for (const combo of Object.values(combosOf(entry) ?? {})) {
    for (const option of Object.values(combo.options)) for (const name of option.widgets) owned.add(name);
  }
  return owned;
}

/**
 * The option a selector value picks: the catalog default when the node holds
 * no value yet (a fresh node), `undefined` for a value no option has — which,
 * as in the frontend and comfy-cli, contributes no sub-slots.
 */
function selectedOption(combo: DynamicComboEntry, value: unknown): DynamicComboEntry["options"][string] | undefined {
  const key = value === undefined || value === null ? combo.default : String(value);
  return key !== null && Object.hasOwn(combo.options, key) ? combo.options[key] : undefined;
}

/**
 * Expand `entry` for one selection. `valueAt(name, index)` returns the
 * selector's current value, given its name and its positional index in the
 * order built so far.
 */
function expand(
  entry: WidgetCatalogEntry,
  combos: Combos,
  valueAt: (name: string, index: number) => unknown,
): string[] {
  const owned = optionOwnedWidgets(entry);
  const out: string[] = [];
  const walk = (names: readonly string[], depth: number): void => {
    for (const name of names) {
      out.push(name);
      if (depth > 32 || !Object.hasOwn(combos, name)) continue;
      const option = selectedOption(combos[name]!, valueAt(name, out.length - 1));
      if (option) walk(option.widgets, depth + 1);
    }
  };
  walk(entry.widget_order.filter((name) => !owned.has(name)), 0);
  return out;
}

/** The order for a workflow node's own `widgets_values` (positional array or name-keyed object). */
export function widgetOrderForValues(entry: WidgetCatalogEntry | undefined, wv: unknown): readonly string[] | undefined {
  if (!entry) return undefined;
  const combos = combosOf(entry);
  if (!combos) return entry.widget_order;
  if (Array.isArray(wv)) return expand(entry, combos, (_name, index) => wv[index]);
  if (typeof wv === "object" && wv !== null) {
    const named = wv as Record<string, unknown>;
    return expand(entry, combos, (name) => (Object.hasOwn(named, name) ? named[name] : undefined));
  }
  return expand(entry, combos, () => undefined);
}

/** The order for a document node's name-keyed widgets map. */
export function widgetOrderForWidgets(
  entry: WidgetCatalogEntry,
  widgets: Y.Map<unknown> | undefined,
): readonly string[] {
  const combos = combosOf(entry);
  if (!combos) return entry.widget_order;
  return expand(entry, combos, (name) => widgets?.get(name));
}

/**
 * After `widget` was written: when it is a selector, seed the selected
 * option's slots that hold NO value yet with their catalog defaults,
 * recursing into nested selectors.
 *
 * Order-independent by construction (KA-2/KA-4): it never deletes and never
 * overwrites, and a seeded default carries no stamp, so any real stamped write
 * to the same slot wins whichever arrives first. An option the node moves
 * away from keeps its values — projection skips them — exactly as the
 * frontend keeps them to restore when that option is selected again
 * (`dynamicWidgets.ts` `restoreRemovedValues`).
 */
export function reconcileDynamicCombo(
  entry: WidgetCatalogEntry | undefined,
  widgets: Y.Map<unknown>,
  widget: string,
): void {
  const combos = combosOf(entry);
  if (!combos || !Object.hasOwn(combos, widget)) return;
  const seed = (selector: string, depth: number): void => {
    const selected = selectedOption(combos[selector]!, widgets.get(selector));
    if (!selected) return;
    for (const name of selected.widgets) {
      if (!widgets.has(name) && Object.hasOwn(selected.defaults, name)) {
        mset(widgets, name, structuredClone(selected.defaults[name]));
      }
      if (depth <= 32 && Object.hasOwn(combos, name)) seed(name, depth + 1);
    }
  };
  seed(widget, 0);
}
