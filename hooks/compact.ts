import type { ConfigValue, PluginOptions, SessionContextUsage } from "claude-code";
import type { Anchor, Usage } from "../types";
import { TTL_MS } from "./warmer";

export type CompactMode = "off" | "manual" | "experimental";
export type CompactOptions = {
  mode: CompactMode;
  headroom: number;
  leadMs: number;
  timeoutMs: number;
};

export const compactModeOf = (value: ConfigValue | undefined): CompactMode =>
  value === "manual" || value === "experimental" ? value : "off";

const bounded = (value: ConfigValue | undefined, fallback: number, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.round(value))) : fallback;

export const compactOptionsOf = (options: PluginOptions): CompactOptions => ({
  mode: compactModeOf(options.compactGuard),
  headroom: bounded(options.compactHeadroomTokens, 16_000, 4096, 100_000),
  leadMs: bounded(options.compactLeadSeconds, 60, 15, 300) * 1000,
  timeoutMs: bounded(options.compactWakeTimeoutSeconds, 30, 5, 120) * 1000,
});

export const validUsage = (usage: Usage | null | undefined): usage is Usage =>
  !!usage && [usage.input, usage.output, usage.cacheRead, usage.cacheWrite]
    .every(n => Number.isFinite(n) && n >= 0);

// Stronger evidence than the warmer's historical 50% threshold. Still an
// observation of this request, never a promise about the next summarizer.
export const readMostOf = (usage: Usage | null | undefined, tokens: number) =>
  validUsage(usage) && tokens > 0 && usage.cacheRead >= tokens * 0.9;

export const forkIsFresh = (anchor: Anchor, at: number, margin: number) =>
  anchor.lastForkAt !== undefined && anchor.lastForkAt <= at &&
  at + margin < anchor.lastForkAt + TTL_MS[anchor.ttl];

export const mainIsStale = (anchor: Anchor, at: number) =>
  at >= Math.max(anchor.at, anchor.lastMainResponseAt ?? anchor.at) + TTL_MS[anchor.ttl];

// A successful main request can establish a warm prefix before the first Fork.
// Its request-start time is deliberately conservative about server expiry.
export const idleCacheIsFresh = (anchor: Anchor, at: number, margin: number) =>
  forkIsFresh(anchor, at, margin) ||
  (anchor.mainCacheAt !== undefined && anchor.mainCacheAt <= at &&
    at + margin < anchor.mainCacheAt + TTL_MS[anchor.ttl]);

// A plain status-line percentage omits a smaller auto-compact window. Require
// the documented local /context estimate and leave room below BOTH limits.
export const hasWakeRoom = (context: SessionContextUsage, anchor: Anchor, headroom: number) => {
  const b = context.breakdown;
  if (!b || !Number.isFinite(b.totalTokens) || b.totalTokens <= 0 ||
      !Number.isFinite(b.rawMaxTokens) || b.rawMaxTokens <= 0 ||
      !Number.isFinite(context.window) || context.window <= 0) return false;
  if (b.isAutoCompactEnabled && (!Number.isFinite(b.autoCompactThreshold) || !b.autoCompactThreshold)) return false;
  const limit = Math.min(context.window, b.rawMaxTokens,
    b.isAutoCompactEnabled ? b.autoCompactThreshold! : Infinity);
  return limit - Math.max(b.totalTokens, anchor.promptTokens) >= headroom;
};

// No public deadline API. Docs say "about an hour" and some versions report
// about 54 minutes. Use 50 minutes conservatively, independent of cache TTL.
// Forks never advance this main-request-based estimate.
export const idleDeadline = (anchor: Anchor) => anchor.at + 50 * 60_000;
export const idleWakeAt = (anchor: Anchor, options: CompactOptions) =>
  idleDeadline(anchor) - options.leadMs - options.timeoutMs;

export const idlePolicyAllows = (
  anchor: Anchor, context: SessionContextUsage, options: CompactOptions,
  idleEnabled: unknown, idleMinTokens: string | undefined, interactive: boolean,
) => {
  const configured = Number(idleMinTokens);
  const minimum = Number.isInteger(configured) && configured > 0 ? Math.max(100_000, configured) : 200_000;
  const b = context.breakdown;
  return options.mode === "experimental" && interactive && anchor.ttl === "1h" &&
    (idleEnabled === true || idleEnabled === undefined) &&
    !!b?.isAutoCompactEnabled &&
    b.totalTokens >= minimum &&
    hasWakeRoom(context, anchor, options.headroom);
};
