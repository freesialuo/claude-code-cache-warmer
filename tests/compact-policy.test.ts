import { expect, test } from "claude-code/testing";
import type { PluginOptions, SessionContextUsage } from "claude-code";
import type { Anchor, Ttl, Usage } from "../types";
import {
  compactModeOf, compactOptionsOf, forkIsFresh, hasWakeRoom,
  idlePolicyAllows, idleWakeAt, mainIsStale, readMostOf, validUsage,
} from "../hooks/compact";
import { TTL_MS } from "../hooks/warmer";

const anchorOf = (ttl: Ttl = "1h"): Anchor => ({
  at: 1_000_000, lastAt: 1_000_000, lastForkAt: 1_000_100,
  model: "claude-opus-5-5", promptTokens: 200_000, ttl,
  refreshes: 1, idleRefreshes: 1, feeUsd: 0, isStopped: false,
});

const contextOf = (): SessionContextUsage => ({
  tokens: 200_000, window: 1_000_000,
  breakdown: {
    categories: [], totalTokens: 200_000, maxTokens: 250_000,
    rawMaxTokens: 250_000, autocompactSource: "model-default", percentage: 80,
    gridRows: [], model: "claude-opus-5-5", memoryFiles: [], mcpTools: [], agents: [],
    autoCompactThreshold: 240_000, isAutoCompactEnabled: true, apiUsage: null,
  },
});

const optionsOf = () => compactOptionsOf({ compactGuard: "experimental" });
const usageOf = (cacheRead = 90_000): Usage => ({ input: 100, output: 1, cacheRead, cacheWrite: 0 });

test("compact policy defaults off and clamps finite numeric configuration", () => {
  expect(compactOptionsOf({})).toEqual({
    mode: "off", minPercent: 80, headroom: 16_000, leadMs: 60_000, timeoutMs: 30_000,
  });
  expect(compactOptionsOf({
    compactGuard: "manual", compactMinPercent: 1, compactHeadroomTokens: 1,
    compactLeadSeconds: 1, compactWakeTimeoutSeconds: 1,
  })).toEqual({ mode: "manual", minPercent: 50, headroom: 4096, leadMs: 15_000, timeoutMs: 5000 });
  expect(compactOptionsOf({
    compactGuard: "experimental", compactMinPercent: 1000, compactHeadroomTokens: 1_000_000,
    compactLeadSeconds: 1000, compactWakeTimeoutSeconds: 1000,
  })).toEqual({ mode: "experimental", minPercent: 95, headroom: 100_000, leadMs: 300_000, timeoutMs: 120_000 });
  expect(compactOptionsOf({ compactMinPercent: 80.6, compactHeadroomTokens: 16_000.6 }).minPercent).toBe(81);
  expect(compactOptionsOf({ compactHeadroomTokens: 16_000.6 }).headroom).toBe(16_001);
  for (const value of [NaN, Infinity, -Infinity, "80", null]) {
    const options = {
      compactMinPercent: value, compactHeadroomTokens: value,
      compactLeadSeconds: value, compactWakeTimeoutSeconds: value,
    } as PluginOptions;
    expect(compactOptionsOf(options)).toEqual(compactOptionsOf({}));
  }
  for (const value of [undefined, "", "on", true, 1]) expect(compactModeOf(value)).toBe("off");
  expect(compactModeOf("manual")).toBe("manual");
  expect(compactModeOf("experimental")).toBe("experimental");
});

for (const ttl of ["5m", "1h"] as const) {
  test(`${ttl} freshness requires a completed fork and the whole safety margin before expiry`, () => {
    const anchor = anchorOf(ttl);
    const expiry = anchor.lastForkAt! + TTL_MS[ttl];
    const margin = 30_000;
    expect(forkIsFresh(anchor, expiry - margin - 1, margin)).toBe(true);
    expect(forkIsFresh(anchor, expiry - margin, margin)).toBe(false);
    expect(forkIsFresh(anchor, expiry, 0)).toBe(false);
    expect(forkIsFresh(anchor, anchor.lastForkAt! - 1, margin)).toBe(false);
    expect(forkIsFresh({ ...anchor, lastForkAt: undefined }, anchor.at + 1, margin)).toBe(false);
    expect(mainIsStale(anchor, anchor.at + TTL_MS[ttl] - 1)).toBe(false);
    expect(mainIsStale(anchor, anchor.at + TTL_MS[ttl])).toBe(true);
    const slowReply = { ...anchor, lastMainResponseAt: anchor.at + TTL_MS[ttl] };
    expect(mainIsStale(slowReply, anchor.at + TTL_MS[ttl] + 1)).toBe(false);
  });
}

test("cache-read proof needs all valid usage fields and at least ninety percent of the prefix", () => {
  expect(readMostOf(usageOf(), 100_000)).toBe(true);
  expect(readMostOf(usageOf(89_999), 100_000)).toBe(false);
  for (const usage of [null, undefined, {}, { cacheRead: 90_000 },
    { ...usageOf(), input: NaN }, { ...usageOf(), output: Infinity },
    { ...usageOf(), cacheWrite: -1 }, { ...usageOf(), cacheRead: "90000" }]) {
    expect(validUsage(usage as Usage)).toBe(false);
    expect(readMostOf(usage as Usage, 100_000)).toBe(false);
  }
  for (const tokens of [0, -1, NaN, Infinity]) expect(readMostOf(usageOf(), tokens)).toBe(false);
});

test("Wake headroom uses the native auto threshold as well as the model and configured windows", () => {
  const anchor = anchorOf();
  const context = contextOf();
  expect(hasWakeRoom(context, anchor, 40_000)).toBe(true);
  expect(hasWakeRoom(context, anchor, 40_001)).toBe(false);
  expect(hasWakeRoom(context, { ...anchor, promptTokens: 230_000 }, 16_000)).toBe(false);
  context.breakdown!.autoCompactThreshold = 210_000;
  expect(hasWakeRoom(context, anchor, 16_000)).toBe(false);
  context.breakdown!.isAutoCompactEnabled = false;
  expect(hasWakeRoom(context, anchor, 16_000)).toBe(true);
  context.window = 210_000;
  expect(hasWakeRoom(context, anchor, 16_000)).toBe(false);
  context.window = 1_000_000;
  context.breakdown!.rawMaxTokens = 210_000;
  expect(hasWakeRoom(context, anchor, 16_000)).toBe(false);
});

test("Wake headroom rejects absent or malformed context limits", () => {
  const anchor = anchorOf();
  expect(hasWakeRoom({ window: 1_000_000 }, anchor, 16_000)).toBe(false);
  for (const field of ["totalTokens", "rawMaxTokens", "autoCompactThreshold"] as const) {
    for (const value of [undefined, NaN, Infinity, 0, -1]) {
      const context = contextOf();
      Object.assign(context.breakdown!, { [field]: value });
      expect(hasWakeRoom(context, anchor, 16_000)).toBe(false);
    }
  }
  for (const window of [NaN, Infinity, 0, -1])
    expect(hasWakeRoom({ ...contextOf(), window }, anchor, 16_000)).toBe(false);
});

test("proactive policy requires pressure and every explicit native-idle eligibility condition", () => {
  const anchor = anchorOf();
  const context = contextOf();
  const options = optionsOf();
  const allowed = (a = anchor, c = context, o = options, enabled: unknown = true, min?: string, interactive = true) =>
    idlePolicyAllows(a, c, o, enabled, min, interactive);
  expect(allowed()).toBe(true);
  expect(allowed(anchor, context, { ...options, mode: "off" })).toBe(false);
  expect(allowed(anchor, context, { ...options, mode: "manual" })).toBe(false);
  for (const enabled of [undefined, false, "true", 1])
    expect(idlePolicyAllows(anchor, context, options, enabled, undefined, true)).toBe(false);
  expect(allowed(anchor, context, options, true, undefined, false)).toBe(false);
  expect(allowed(anchorOf("5m"))).toBe(false);
  expect(allowed(anchor, { window: 1_000_000 })).toBe(false);
  const noAuto = contextOf();
  noAuto.breakdown!.isAutoCompactEnabled = false;
  expect(allowed(anchor, noAuto)).toBe(false);
  expect(allowed(anchor, context, { ...options, minPercent: 81 })).toBe(false);
  expect(allowed(anchor, context, options, true, "200001")).toBe(false);
  for (const minimum of ["0", "-1", "abc", "Infinity", "200000.5", ""])
    expect(allowed(anchor, context, options, true, minimum)).toBe(false);
});

test("idle minimum has a one-hundred-thousand floor and timing stays outside the eligibility policy", () => {
  const anchor = { ...anchorOf(), promptTokens: 100_000 };
  const context = contextOf();
  Object.assign(context.breakdown!, { totalTokens: 100_000, rawMaxTokens: 125_000, autoCompactThreshold: 120_000 });
  const options = optionsOf();
  expect(idlePolicyAllows(anchor, context, options, true, "1", true)).toBe(true);
  expect(idlePolicyAllows({ ...anchor, promptTokens: 99_999 }, {
    ...context, breakdown: { ...context.breakdown!, totalTokens: 99_999 },
  }, options, true, "1", true)).toBe(false);
  expect(idlePolicyAllows(anchor, context, options, true, undefined, true)).toBe(false);
  expect(idleWakeAt(anchor, options)).toBe(anchor.at + TTL_MS["1h"] - options.leadMs);
  // No clock argument: the orchestrator, not this pressure/eligibility predicate, checks the due time.
  expect(idlePolicyAllows(anchor, context, options, true, "100000", true)).toBe(true);
});
