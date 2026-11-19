/**
 * Review-only catalog codec. Not exported, shipped, or wired into the applier.
 * The first commit used real flat-catalog mint as the failing reference adapter.
 */

export interface WidgetField {
  readonly name: string;
  readonly branches?: Readonly<Record<string, readonly WidgetField[]>>;
}

function indexFields(layout: readonly WidgetField[], fields = new Map<string, WidgetField>()): Map<string, WidgetField> {
  for (const field of layout) {
    if (!field.name || fields.has(field.name)) throw new Error(`Ambiguous field: ${field.name}`);
    fields.set(field.name, field);
    for (const branch of Object.values(field.branches ?? {})) indexFields(branch, fields);
  }
  return fields;
}

function walkSelected(layout: readonly WidgetField[], read: (name: string) => unknown): void {
  for (const field of layout) {
    const selection = read(field.name);
    if (field.branches === undefined) continue;
    if (typeof selection !== "string" || !Object.hasOwn(field.branches, selection)) {
      throw new Error(`Unknown selection for ${field.name}`);
    }
    walkSelected(field.branches[selection]!, read);
  }
}

export function decodeWidgets(layout: readonly WidgetField[], values: readonly unknown[]): Map<string, unknown> {
  indexFields(layout);
  const named = new Map<string, unknown>();
  let cursor = 0;
  walkSelected(layout, (name) => {
    if (cursor >= values.length) throw new Error(`Missing value for ${name}`);
    const value = values[cursor++];
    named.set(name, value);
    return value;
  });
  if (cursor !== values.length) throw new Error("Unaccounted positional values");
  return named;
}

export type ResetValue = { readonly kind: "set"; readonly value: unknown } | { readonly kind: "clear" };

/** Pure intent planning, with no receiver state, stamps, defaults, or document writes. */
export function planSelectorReset(
  layout: readonly WidgetField[], selector: string, selection: string,
  carried: ReadonlyMap<string, unknown>,
): Map<string, ResetValue> {
  const field = indexFields(layout).get(selector);
  if (field?.branches === undefined) throw new Error(`Not a selector: ${selector}`);
  const reset = new Map<string, ResetValue>();
  for (const name of indexFields([field]).keys()) reset.set(name, { kind: "clear" });
  let consumed = 0;
  walkSelected([field], (name) => {
    if (name !== selector && !carried.has(name)) throw new Error(`Missing carried value for ${name}`);
    const value = name === selector ? selection : carried.get(name);
    if (name !== selector) consumed++;
    reset.set(name, { kind: "set", value });
    return value;
  });
  if (consumed !== carried.size) throw new Error("Unexpected carried fields");
  return reset;
}
