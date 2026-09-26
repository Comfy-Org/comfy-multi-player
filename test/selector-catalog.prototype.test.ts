/**
 * Review-only contract spike following cloud PR 10081's safety failures:
 * https://github.com/Comfy-Org/cloud/pull/10081
 * Expected names/values are written independently, not derived from the codec.
 */
import { describe, expect, it } from "vitest";
import { decodeWidgets, planSelectorReset, type WidgetField } from "./prototypes/selector-catalog.js";

const layout: readonly WidgetField[] = [
  { name: "sharpen" },
  { name: "smart_grain" },
  { name: "mode", branches: {
    creative: [],
    faithful: [{ name: "mode.skin_detail" }],
    flexible: [{ name: "mode.optimized_for" }],
  } },
  // A deliberate non-Magnific fixture extension catches middle-slot shifts.
  { name: "after" },
];

describe("selector-aware catalog prototype", () => {
  it.each([
    ["creative", [3, 7, "creative", 901], [
      ["sharpen", 3], ["smart_grain", 7], ["mode", "creative"], ["after", 901],
    ]],
    ["faithful", [5, 11, "faithful", 83, 902], [
      ["sharpen", 5], ["smart_grain", 11], ["mode", "faithful"], ["mode.skin_detail", 83], ["after", 902],
    ]],
    ["flexible", [13, 17, "flexible", "enhance_skin", 903], [
      ["sharpen", 13], ["smart_grain", 17], ["mode", "flexible"],
      ["mode.optimized_for", "enhance_skin"], ["after", 903],
    ]],
  ] as const)("maps %s without shifting the following field", (_mode, values, expected) => {
    expect([...decodeWidgets(layout, values)]).toEqual(expected);
  });

  it("walks nested selectors before resuming their enclosing sequence", () => {
    const nested: readonly WidgetField[] = [
      { name: "mode", branches: {
        off: [],
        on: [
          { name: "mode.quality", branches: {
            fast: [],
            precise: [{ name: "mode.quality.amount" }, { name: "mode.quality.limit" }],
          } },
          { name: "mode.tail" },
        ],
      } },
      { name: "after" },
    ];
    expect([...decodeWidgets(nested, ["on", "precise", 23, 47, 71, 97])]).toEqual([
      ["mode", "on"], ["mode.quality", "precise"], ["mode.quality.amount", 23],
      ["mode.quality.limit", 47], ["mode.tail", 71], ["after", 97],
    ]);
  });

  it.each([
    ["missing selected child", [3, 7, "faithful", 901]],
    ["extra unaccounted value", [3, 7, "creative", 901, 999]],
    ["unknown selection", [3, 7, "toString", 901]],
  ] as const)("refuses %s instead of inventing positions", (_name, values) => {
    expect(() => decodeWidgets(layout, values)).toThrow();
  });

  it("refuses an incomplete static catalog rather than allowing a wrong-slot edit", () => {
    const incomplete = [{ name: "seed" }, { name: "steps" }, { name: "cfg" }];
    expect(() => decodeWidgets(incomplete, [42, "fixed", 20, 8])).toThrow();
  });

  it("carries exact active values and clears inactive descendants, not unrelated fields", () => {
    expect([...planSelectorReset(layout, "mode", "faithful", new Map([
      ["mode.skin_detail", null],
    ]))]).toEqual([
      ["mode", { kind: "set", value: "faithful" }],
      ["mode.skin_detail", { kind: "set", value: null }],
      ["mode.optimized_for", { kind: "clear" }],
    ]);
  });

  it("targets every descendant even when switching to the empty branch", () => {
    expect([...planSelectorReset(layout, "mode", "creative", new Map())]).toEqual([
      ["mode", { kind: "set", value: "creative" }],
      ["mode.skin_detail", { kind: "clear" }],
      ["mode.optimized_for", { kind: "clear" }],
    ]);
  });

  it("includes inactive grandchildren in the fixed reset target set", () => {
    const nested: readonly WidgetField[] = [{ name: "mode", branches: {
      off: [],
      on: [{ name: "mode.quality", branches: {
        fast: [], precise: [{ name: "mode.quality.amount" }],
      } }],
    } }];
    expect([...planSelectorReset(nested, "mode", "on", new Map([
      ["mode.quality", "fast"],
    ]))]).toEqual([
      ["mode", { kind: "set", value: "on" }],
      ["mode.quality", { kind: "set", value: "fast" }],
      ["mode.quality.amount", { kind: "clear" }],
    ]);
  });

  it.each([
    ["missing child", "mode", "faithful", []],
    ["inactive child", "mode", "creative", [["mode.skin_detail", 80]]],
    ["unrelated field", "mode", "creative", [["after", 42]]],
    ["selector override", "mode", "creative", [["mode", "flexible"]]],
    ["unknown choice", "mode", "toString", []],
    ["non-selector", "after", "creative", []],
  ] as const)("refuses reset with %s", (_name, selector, selection, carried) => {
    expect(() => planSelectorReset(layout, selector, selection, new Map<string, unknown>(carried))).toThrow();
  });
});
