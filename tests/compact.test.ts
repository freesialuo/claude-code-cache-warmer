import { expect, test } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import type { On, SessionContextUsage, SessionCompactInput, SessionCompactResult, TurnUsage } from "claude-code";
import { MINUTE, OPUS, START, mountPane, start, turnUsage, world } from "./world";

const contextOf = (tokens = 200_000, limit = 250_000): SessionContextUsage => ({
  tokens, window: limit, percent: tokens / limit * 100,
  breakdown: {
    categories: [], totalTokens: tokens, maxTokens: limit, rawMaxTokens: limit,
    autocompactSource: "model-default", percentage: tokens / limit * 100,
    gridRows: [], model: OPUS, memoryFiles: [], mcpTools: [], agents: [],
    autoCompactThreshold: limit - 10_000, isAutoCompactEnabled: true, apiUsage: null,
  },
});

const messages = [{ role: "assistant" as const, text: "Native summary", toolUses: [] }];

const setup = (on: On) => {
  const worldOn = ((event: string, ...args: unknown[]) => {
    if (event === "turn.step" || event === "fs.write") return;
    return (on as Function)(event, ...args);
  }) as On;
  const w = world(worldOn, { HOME: "/home/t" });
  let usageBarrier: (() => Promise<void>) | undefined;
  let stepBarrier: (() => Promise<void>) | undefined;
  let nativeBarrier: (() => Promise<void>) | undefined;
  let submitBarrier: (() => Promise<void>) | undefined;
  let rewriteWake: string | undefined;
  let logBarrier: { includes: string; wait: () => Promise<void> } | undefined;
  on("fs.write", async (_, e) => {
    if (logBarrier && e.text.includes(logBarrier.includes)) {
      const held = logBarrier;
      logBarrier = undefined;
      await held.wait();
    }
    w.files.set(e.path, e.text);
    w.writes.push({ path: e.path, text: e.text });
    return { value: undefined };
  });
  let nextUsage: TurnUsage | undefined = turnUsage(OPUS, 199_000, 1000);
  on("turn.step", async function* (_, e) {
    const wait = stepBarrier;
    stepBarrier = undefined;
    await wait?.();
    yield { kind: "stop", stopReason: "end_turn", usage: nextUsage ?? null };
    return { turnId: e.turnId, index: e.index, answer: "ready", toolUses: [], stopReason: "end_turn", usage: nextUsage ?? null };
  });
  let context: SessionContextUsage = contextOf();
  let usageError = false;
  let idle: boolean | undefined = true;
  let submitError = false;
  let nativeError = false;
  let answer: SessionCompactResult = { messages, usage: turnUsage(OPUS, 199_000, 1000) };
  const native: SessionCompactInput[] = [];
  const wakes: string[] = [];
  on("session.usage", async () => {
    const wait = usageBarrier;
    usageBarrier = undefined;
    await wait?.();
    if (usageError) throw new Error("usage unavailable");
    return { value: { startedAt: START, context, rateLimits: [] } };
  });
  on("settings.read", () => ({ value: { idleCompaction: idle } }));
  on("session.compact", async (_, e) => {
    native.push(e);
    const wait = nativeBarrier;
    nativeBarrier = undefined;
    await wait?.();
    if (nativeError) throw new Error("native unavailable");
    return answer;
  });
  on("prompt.submit", async (_, e) => {
    const wait = submitBarrier;
    submitBarrier = undefined;
    if (submitError) throw new Error("submit unavailable");
    if (e.origin.kind === "plugin") wakes.push(rewriteWake ?? e.text);
    await wait?.();
    return { text: e.origin.kind === "plugin" ? rewriteWake ?? e.text : e.text, origin: e.origin };
  });
  const compact = ($: Engine, trigger: SessionCompactInput["trigger"] = "manual", instructions = "Keep the API contract") =>
    $.session.compact({ trigger, messages, instructions });
  const finishWake = async ($: Engine, usage: TurnUsage | null = turnUsage(OPUS, 199_000, 1000)) => {
    const turnId = "wake";
    await $.turn.start({ text: wakes.at(-1)!, turnId });
    nextUsage = usage ?? undefined;
    for await (const _ of $.turn.step({ turnId, index: 0, model: OPUS, messageCount: 1 })) { /* drain */ }
    await $.turn.complete({ answer: "ready", durationMs: 5, isAborted: false, turnId, reason: "answer" });
    await w.clock.advance(200);
  };
  const stale = async ($: Engine) => {
    await start($);
    await w.prompt($, "main");
    await w.clock.advance(5 * MINUTE + 1);
  };
  return { ...w, native, wakes, compact, finishWake, stale,
    holdUsage: (wait: () => Promise<void>) => { usageBarrier = wait; },
    holdStep: (wait: () => Promise<void>) => { stepBarrier = wait; },
    holdNative: (wait: () => Promise<void>) => { nativeBarrier = wait; },
    holdLog: (includes: string, wait: () => Promise<void>) => { logBarrier = { includes, wait }; },
    holdSubmit: (wait: () => Promise<void>) => { submitBarrier = wait; },
    rewriteWake: (text: string) => { rewriteWake = text; },
    context: (value: SessionContextUsage) => { context = value; },
    usageError: () => { usageError = true; },
    idle: (value: boolean | undefined) => { idle = value; },
    submitError: () => { submitError = true; },
    nativeError: () => { nativeError = true; },
    answer: (value: SessionCompactResult) => { answer = value; },
  };
};

const manual = { options: { ttl: "5m", compactGuard: "manual" } };

test("an identified Wake cannot run tools, while a user's joined turn keeps native permission checks", manual, async ($, on) => {
  const w = setup(on);
  on("tool.check", () => ({ decision: "ask" }));
  await w.stale($);
  await w.compact($);
  await w.clock.advance(200);
  await $.turn.start({ text: w.wakes[0]!, turnId: "wake" });
  const tool = { tool: "Bash", input: { command: "echo wake" }, tool_use_id: "wake-tool" };
  expect((await $.tool.check(tool)).decision).toBe("deny");
  expect((await $.tool.check({ ...tool, agentId: "other-agent" })).decision).toBe("ask");
  await $.prompt.submit({ text: "Please inspect my files", origin: { kind: "composer" }, turnId: "wake", wait: false });
  expect((await $.tool.check(tool)).decision).toBe("ask");
});

test("advanced headroom configuration takes effect in the current session", manual, async ($, on) => {
  const w = setup(on);
  await w.stale($);
  await $.config.set({
    key: "cache-warmer.compactHeadroomTokens", value: 100_000, previous: 16_000,
    provider: { plugin: "cache-warmer", tier: "user" }, origin: { kind: "composer" },
  });
  await w.compact($);
  await w.clock.advance(200);
  expect(w.native).toHaveLength(1);
  expect(w.wakes).toHaveLength(0);
});

test("Compact Guard off preserves warming and native compaction", { options: { ttl: "5m" } }, async ($, on) => {
  const w = setup(on);
  await w.stale($);
  expect(w.forks).toHaveLength(1);
  await w.compact($);
  await w.clock.advance(10 * MINUTE);
  expect(w.wakes).toHaveLength(0);
  expect(w.native).toHaveLength(1);
  expect(w.forks).toHaveLength(1);
});

for (const trigger of ["manual", "plugin"] as const) {
  test(`${trigger} compaction waits for one main-thread Wake and preserves instructions`, manual, async ($, on) => {
    const w = setup(on);
    await w.stale($);
    expect((await w.compact($, trigger)).skip).toBeDefined();
    expect(w.native).toHaveLength(0);
    await w.clock.advance(200);
    expect(w.wakes).toHaveLength(1);
    await w.finishWake($);
    expect(w.native).toHaveLength(1);
    expect(w.native[0]?.instructions).toBe("Keep the API contract");
    await w.clock.advance(10 * MINUTE);
    expect(w.forks).toHaveLength(1);
  });
}

for (const reason of ["unknown usage", "no headroom", "usage error", "expired fork"] as const) {
  test(`${reason} leaves the original compaction native`, manual, async ($, on) => {
    const w = setup(on);
    await w.stale($);
    if (reason === "unknown usage") w.context({ window: 250_000 });
    if (reason === "no headroom") w.context(contextOf(230_000));
    if (reason === "usage error") w.usageError();
    if (reason === "expired fork") {
      // A refused refresh leaves no qualifying successful Fork alive.
      w.replies.push(new Error("unavailable"));
      await w.clock.advance(5 * MINUTE);
    }
    await w.compact($);
    await w.clock.advance(200);
    expect(w.native).toHaveLength(1);
    expect(w.wakes).toHaveLength(0);
  });
}

for (const trigger of ["auto", "precompute"] as const) {
  test(`${trigger} compaction stays native without Wake`, manual, async ($, on) => {
    const w = setup(on);
    await w.stale($);
    await w.compact($, trigger);
    await w.clock.advance(200);
    expect(w.native).toHaveLength(1);
    expect(w.wakes).toHaveLength(0);
  });
}

for (const failure of ["missing usage", "cache miss", "submit error"] as const) {
  test(`${failure} falls back to native compaction once`, manual, async ($, on) => {
    const w = setup(on);
    await w.stale($);
    if (failure === "submit error") w.submitError();
    await w.compact($);
    await w.clock.advance(200);
    if (failure !== "submit error") await w.finishWake($, failure === "missing usage" ? null : turnUsage(OPUS, 10, 199_990));
    await w.clock.advance(500);
    expect(w.native).toHaveLength(1);
    expect(w.native[0]?.instructions).toBe("Keep the API contract");
  });
}

test("duplicate requests retain the first instructions and issue one Wake", manual, async ($, on) => {
  const w = setup(on);
  await w.stale($);
  await w.compact($);
  expect((await w.compact($, "manual", "different instructions")).skip).toBeDefined();
  await w.clock.advance(200);
  expect(w.wakes).toHaveLength(1);
  await w.finishWake($);
  expect(w.native).toHaveLength(1);
  expect(w.native[0]?.instructions).toBe("Keep the API contract");
});

test("native auto compaction overtaking Wake prevents a second compaction", manual, async ($, on) => {
  const w = setup(on);
  await w.stale($);
  await w.compact($);
  await w.clock.advance(200);
  await w.compact($, "auto");
  await w.finishWake($);
  await w.clock.advance(MINUTE);
  expect(w.native).toHaveLength(1);
});

test("a real user prompt before queued Wake cancels Wake and preserves native fallback", manual, async ($, on) => {
  const w = setup(on);
  await w.stale($);
  await w.compact($);
  await $.prompt.submit({ text: "My actual question", wait: false, origin: { kind: "composer" } });
  await w.prompt($, "user");
  await w.clock.advance(500);
  expect(w.wakes).toHaveLength(0);
  expect(w.native).toHaveLength(1);
});

test("accepted queued Wake timeout does not race native compaction against a pending turn", manual, async ($, on) => {
  const w = setup(on);
  await w.stale($);
  await w.compact($);
  await w.clock.advance(31_000);
  expect(w.wakes).toHaveLength(1);
  expect(w.native).toHaveLength(0);
  expect(w.logged.some(text => text.includes("timed out"))).toBe(true);
  await w.finishWake($);
  expect(w.native).toHaveLength(1);
});

test("native skip retains warming and reports retry without looping", manual, async ($, on) => {
  const w = setup(on);
  w.answer({ skip: "native veto" });
  await w.stale($);
  await w.compact($);
  await w.clock.advance(200);
  await w.finishWake($);
  expect(w.native).toHaveLength(1);
  expect(w.logged.some(text => text.includes("Retry /compact Keep the API contract"))).toBe(true);
  await w.clock.advance(5 * MINUTE);
  expect(w.native).toHaveLength(1);
  expect(w.forks.length).toBeGreaterThan(1);
});

for (const policy of ["enabled", "disabled", "unknown", "low pressure"] as const) {
  test(`experimental idle guard requires explicit native policy and pressure: ${policy}`, { options: { ttl: "1h", compactGuard: "experimental" } }, async ($, on) => {
    const w = setup(on);
    if (policy === "disabled") w.idle(false);
    if (policy === "unknown") w.idle(undefined);
    if (policy === "low pressure") w.context(contextOf(150_000, 300_000));
    await start($);
    await w.prompt($, "main");
    await w.clock.advance(58 * MINUTE);
    expect(w.wakes).toHaveLength(0);
    await w.clock.advance(MINUTE + 200);
    expect(w.wakes).toHaveLength(policy === "enabled" ? 1 : 0);
    if (policy === "enabled") {
      await w.finishWake($);
      expect(w.native).toHaveLength(1);
    } else expect(w.native).toHaveLength(0);
  });
}


test("native API failure after Wake reports retry and never retries automatically", manual, async ($, on) => {
  const w = setup(on);
  await w.stale($);
  w.nativeError();
  await w.compact($);
  await w.clock.advance(200);
  await w.finishWake($);
  expect(w.native).toHaveLength(1);
  expect(w.logged.some(text => text.includes("Retry /compact Keep the API contract"))).toBe(true);
  await w.clock.advance(10 * MINUTE);
  expect(w.native).toHaveLength(1);
});

test("experimental pressure alone before idle deadline never submits Wake", { options: { ttl: "1h", compactGuard: "experimental" } }, async ($, on) => {
  const w = setup(on);
  await start($);
  await w.prompt($, "main");
  await w.clock.advance(58 * MINUTE);
  expect(w.forks).toHaveLength(1);
  expect(w.wakes).toHaveLength(0);
  expect(w.native).toHaveLength(0);
});


const gate = () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  return { release, started, wait: () => { entered(); return pending; } };
};

test("an unrelated completed user turn cannot resume compaction while accepted Wake is queued", manual, async ($, on) => {
  const w = setup(on);
  await w.stale($);
  await w.compact($);
  await w.clock.advance(200);
  expect(w.wakes).toHaveLength(1);
  await $.prompt.submit({ text: "Actual user request", wait: false, origin: { kind: "composer" } });
  await w.prompt($, "actual-user");
  await w.clock.advance(31_000);
  expect(w.native).toHaveLength(0);
  await w.finishWake($);
  expect(w.native).toHaveLength(1);
});

test("turning Compact Guard off cancels a queued proactive Wake", { options: { ttl: "1h", compactGuard: "experimental" } }, async ($, on) => {
  const w = setup(on);
  await start($);
  await w.prompt($, "main");
  await w.clock.advance(59 * MINUTE);
  await $.config.set({ key: "cache-warmer.compactGuard", value: "off", previous: "experimental", provider: { plugin: "cache-warmer", tier: "user" }, origin: { kind: "composer" } });
  await w.clock.advance(1000);
  expect(w.wakes).toHaveLength(0);
  expect(w.native).toHaveLength(0);
  await w.clock.advance(49 * MINUTE);
  expect(w.forks).toHaveLength(2);
});

test("native compaction during delayed usage admission prevents stale Wake", manual, async ($, on) => {
  const w = setup(on);
  await w.stale($);
  const held = gate();
  w.holdUsage(held.wait);
  const pending = w.compact($);
  await held.started;
  await w.compact($, "auto");
  held.release();
  expect((await pending).skip).toBeDefined();
  await w.clock.advance(1000);
  expect(w.wakes).toHaveLength(0);
  expect(w.native).toHaveLength(1);
});

test("session end during a delayed model step cannot resurrect warming", manual, async ($, on) => {
  const w = setup(on);
  on("session.end", (_, e) => ({ sessionId: e.sessionId }));
  await start($);
  await $.turn.start({ text: "x", turnId: "late" });
  const held = gate();
  w.holdStep(held.wait);
  const pending = (async () => {
    for await (const _ of $.turn.step({ turnId: "late", index: 0, model: OPUS, messageCount: 1 })) { /* drain */ }
  })();
  await held.started;
  await $.session.end({ reason: "clear", sessionId: "s-test", resume: { id: "s-test" } });
  held.release();
  await pending;
  await $.turn.complete({ answer: "ready", durationMs: 5, isAborted: false, turnId: "late", reason: "answer" });
  await w.clock.advance(10 * MINUTE);
  expect(w.forks).toHaveLength(0);
  expect(w.wakes).toHaveLength(0);
});


test("active Wake timeout aborts exactly its identified turn before native fallback", manual, async ($, on) => {
  const w = setup(on);
  const aborted: string[] = [];
  on("turn.abort", async (_, e) => {
    aborted.push(e.turnId);
    await $.turn.complete({ answer: "", durationMs: 30_000, isAborted: true, turnId: e.turnId, reason: "aborted" });
    return { value: undefined };
  });
  await w.stale($);
  await w.compact($);
  await w.clock.advance(200);
  await $.turn.start({ text: w.wakes[0]!, turnId: "guard-wake-exact-id" });
  await w.clock.advance(31_000);
  expect(aborted).toEqual(["guard-wake-exact-id"]);
  expect(w.native).toHaveLength(1);
});

for (const mode of ["manual", "experimental"] as const) {
  test(`a user message during active ${mode} Wake prevents abort and waits for completion`, { options: { ttl: mode === "manual" ? "5m" : "1h", compactGuard: mode } }, async ($, on) => {
    const w = setup(on);
    const aborted: string[] = [];
    on("turn.abort", (_, e) => { aborted.push(e.turnId); return { value: undefined }; });
    if (mode === "manual") {
      await w.stale($);
      await w.compact($);
      await w.clock.advance(200);
    } else {
      await start($);
      await w.prompt($, "main");
      await w.clock.advance(59 * MINUTE + 200);
    }
    expect(w.wakes).toHaveLength(1);
    await $.turn.start({ text: w.wakes[0]!, turnId: "active-wake" });
    await $.prompt.submit({ text: "Please also answer my question", wait: false, origin: { kind: "composer" }, turnId: "active-wake" });
    await w.clock.advance(31_000);
    expect(aborted).toHaveLength(0);
    expect(w.native).toHaveLength(0);
    for await (const _ of $.turn.step({ turnId: "active-wake", index: 0, model: OPUS, messageCount: 1 })) { /* drain */ }
    await $.turn.complete({ answer: "ready", durationMs: 31_000, isAborted: false, turnId: "active-wake", reason: "answer" });
    await w.clock.advance(500);
    expect(w.native).toHaveLength(mode === "manual" ? 1 : 0);
    expect(w.wakes).toHaveLength(1);
  });
}

test("auto compaction during a held Wake step prevents duplicate compaction and stale warming", manual, async ($, on) => {
  const w = setup(on);
  await w.stale($);
  await w.compact($);
  await w.clock.advance(200);
  await $.turn.start({ text: w.wakes[0]!, turnId: "held-wake" });
  const held = gate();
  w.holdStep(held.wait);
  const pending = (async () => {
    for await (const _ of $.turn.step({ turnId: "held-wake", index: 0, model: OPUS, messageCount: 1 })) { /* drain */ }
  })();
  await held.started;
  await w.compact($, "auto");
  held.release();
  await pending;
  await $.turn.complete({ answer: "ready", durationMs: 5, isAborted: false, turnId: "held-wake", reason: "answer" });
  await w.clock.advance(10 * MINUTE);
  expect(w.native).toHaveLength(1);
  expect(w.forks).toHaveLength(1);
});

test("precompute during pending Wake preserves deferred compaction", manual, async ($, on) => {
  const w = setup(on);
  await w.stale($);
  await w.compact($);
  await w.clock.advance(200);
  await w.compact($, "precompute");
  expect(w.native).toHaveLength(1);
  await w.finishWake($);
  expect(w.native).toHaveLength(2);
  expect(w.native[0]?.trigger).toBe("precompute");
  expect(w.native[1]?.instructions).toBe("Keep the API contract");
});

test("precompute alone leaves the original warming schedule active", { options: { ttl: "5m" } }, async ($, on) => {
  const w = setup(on);
  await start($);
  await w.prompt($, "main");
  await w.compact($, "precompute");
  await w.clock.advance(270_000);
  expect(w.forks).toHaveLength(1);
});

for (const hasSummaryUsage of [true, false]) {
  test(`structured guard debug records observed usage and nullable savings: ${hasSummaryUsage}`, manual, async ($, on) => {
    const w = setup(on);
    await start($);
    const pane = await mountPane($, "terminal");
    await pane.press({ key: "menu:debug" });
    await pane.unmount();
    await w.prompt($, "main");
    await w.clock.advance(5 * MINUTE + 1);
    if (!hasSummaryUsage) w.answer({ messages });
    await w.compact($);
    await w.clock.advance(200);
    await w.finishWake($);
    const lines = [...w.files.values()].flatMap(text => text.trim().split("\n").map(line => JSON.parse(line)));
    const record = lines.find(line => line.event === "compact-guard");
    expect(record).toMatchObject({
      trigger: "manual", strategy: "wake-before-compact", lastMainRequestAt: START,
      lastSuccessfulForkAt: START + 270_000, wakeSucceeded: true, nativeCompactionSucceeded: true,
      wakeUsage: { input: 0, output: 5, cacheRead: 199_000, cacheWrite: 1000 }, fallback: null,
    });
    expect(record.estimatedExtraCostUsd).toBeGreaterThan(0);
    if (hasSummaryUsage) {
      expect(record.compactionUsage).toEqual({ input: 0, output: 5, cacheRead: 199_000, cacheWrite: 1000 });
      expect(record.estimatedAvoidedCostUsd).toBeGreaterThan(0);
    } else {
      expect(record.compactionUsage).toBeNull();
      expect(record.estimatedAvoidedCostUsd).toBeNull();
    }
  });
}

for (const failure of ["skip", "error"] as const) {
  test(`native ${failure} with Compact Guard off retains the warming chain`, { options: { ttl: "5m" } }, async ($, on) => {
    const w = setup(on);
    await start($);
    await w.prompt($, "main");
    if (failure === "skip") w.answer({ skip: "native veto" });
    else w.nativeError();
    let rejected = false;
    try { await w.compact($); } catch { rejected = true; }
    expect(rejected).toBe(failure === "error");
    await w.clock.advance(270_000);
    expect(w.forks).toHaveLength(1);
    expect(w.wakes).toHaveLength(0);
    expect(w.native).toHaveLength(1);
  });
}

test("manual compaction of a stale one-hour main prompt uses its fresh Fork", { options: { ttl: "1h", compactGuard: "manual" } }, async ($, on) => {
  const w = setup(on);
  await start($);
  await w.prompt($, "main");
  await w.clock.advance(61 * MINUTE);
  expect(w.forks).toHaveLength(1);
  expect((await w.compact($)).skip).toBeDefined();
  await w.clock.advance(200);
  expect(w.wakes).toHaveLength(1);
  await w.finishWake($);
  expect(w.native).toHaveLength(1);
  expect(w.native[0]?.instructions).toBe("Keep the API contract");
});


test("model switch after manual deferral resumes native fallback once", manual, async ($, on) => {
  const w = setup(on);
  on("classic.PostModelSwitch", () => ({}));
  await w.stale($);
  await w.compact($);
  await $.classic.PostModelSwitch({
    from_model: OPUS, to_model: "claude-sonnet-5-5", requested_model: "sonnet", source: "command",
    context_tokens: 200_000, prompt_cache_warm: true, cache_ttl: "5m",
    estimated_cache_write_usd: 0.75, pricing: "catalog",
  });
  await w.clock.advance(1000);
  expect(w.wakes).toHaveLength(0);
  expect(w.native).toHaveLength(1);
  expect(w.native[0]?.instructions).toBe("Keep the API contract");
  await w.clock.advance(MINUTE);
  expect(w.native).toHaveLength(1);
});

test("late native compaction from a cleared session preserves the new warming chain", manual, async ($, on) => {
  const w = setup(on);
  on("session.end", (_, e) => ({ sessionId: e.sessionId }));
  await start($);
  const pane = await mountPane($, "terminal");
  await pane.press({ key: "menu:debug" });
  await pane.unmount();
  await w.prompt($, "main");
  await w.clock.advance(5 * MINUTE + 1);
  const held = gate();
  w.holdNative(held.wait);
  const pending = w.compact($, "auto");
  await held.started;
  await $.session.end({ reason: "clear", sessionId: "s-test", resume: { id: "s-test" } });
  await w.clock.advance(10);
  await w.prompt($, "new-session-main");
  await w.clock.advance(270_000);
  const forksBeforeOldResult = w.forks.length;
  held.release();
  await pending;
  await w.clock.advance(270_000);
  expect(forksBeforeOldResult).toBe(2);
  expect(w.forks).toHaveLength(3);
  expect(w.native).toHaveLength(1);
  const records = [...w.files.values()].flatMap(text => text.trim().split("\n").map(line => JSON.parse(line)));
  expect(records.some(record => record.reason === "conversation compacted")).toBe(false);
});

test("Wake admission rechecks fork expiry after delayed second usage read", manual, async ($, on) => {
  const w = setup(on);
  await w.stale($);
  await w.compact($);
  const held = gate();
  w.holdUsage(held.wait);
  const dispatch = w.clock.advance(200);
  await held.started;
  await w.clock.advance(5 * MINUTE);
  held.release();
  await dispatch;
  await w.clock.advance(1000);
  expect(w.wakes).toHaveLength(0);
  expect(w.native).toHaveLength(1);
});

test("rewritten Wake completion releases guard and preserves explicit retry instructions", manual, async ($, on) => {
  const w = setup(on);
  await w.stale($);
  w.rewriteWake("Rewritten plugin request: reply ready");
  await w.compact($);
  await w.clock.advance(200);
  await w.finishWake($);
  await w.clock.advance(31_000);
  expect(w.wakes).toHaveLength(1);
  const retryReported = w.logged.some(text => text.includes("Retry /compact Keep the API contract"));
  expect(w.native.length === 1 || retryReported).toBe(true);
  await w.prompt($, "after-rewritten-wake");
  const forksBefore = w.forks.length;
  await w.clock.advance(270_000);
  expect(w.forks).toHaveLength(forksBefore + 1);
  expect(w.wakes).toHaveLength(1);
});

for (const overtaker of ["native auto", "session clear"] as const) {
  test(`held Wake submission cannot block new warming after ${overtaker}`, manual, async ($, on) => {
    const w = setup(on);
    if (overtaker === "session clear") on("session.end", (_, e) => ({ sessionId: e.sessionId }));
    await w.stale($);
    const held = gate();
    w.holdSubmit(held.wait);
    await w.compact($);
    const dispatch = w.clock.advance(200);
    await held.started;
    await $.turn.start({ text: w.wakes[0]!, turnId: "overtaken-wake" });
    if (overtaker === "native auto") await w.compact($, "auto");
    else await $.session.end({ reason: "clear", sessionId: "s-test", resume: { id: "s-test" } });
    for await (const _ of $.turn.step({ turnId: "overtaken-wake", index: 0, model: OPUS, messageCount: 1 })) { /* drain */ }
    await $.turn.complete({ answer: "ready", durationMs: 5, isAborted: false, turnId: "overtaken-wake", reason: "answer" });
    await w.clock.advance(210);
    await w.prompt($, "new-main-while-submit-unsettled");
    const forksBefore = w.forks.length;
    await w.clock.advance(270_000);
    const forksWhileUnsettled = w.forks.length;
    held.release();
    await dispatch;
    await w.clock.advance(1000);
    expect(forksWhileUnsettled).toBe(forksBefore + 1);
    expect(w.wakes).toHaveLength(1);
    expect(w.native).toHaveLength(overtaker === "native auto" ? 1 : 0);
  });
}

test("model switch cannot compact ahead of an already accepted queued Wake", manual, async ($, on) => {
  const w = setup(on);
  on("classic.PostModelSwitch", () => ({}));
  await w.stale($);
  await w.compact($);
  await w.clock.advance(200);
  await $.classic.PostModelSwitch({
    from_model: OPUS, to_model: "claude-sonnet-5-5", requested_model: "sonnet", source: "command",
    context_tokens: 200_000, prompt_cache_warm: true, cache_ttl: "5m",
    estimated_cache_write_usd: 0.75, pricing: "catalog",
  });
  await w.clock.advance(1000);
  expect(w.native).toHaveLength(0);
  await w.finishWake($);
  await w.clock.advance(1000);
  const retryReported = w.logged.some(text => text.includes("Retry /compact Keep the API contract"));
  expect(w.native.length === 1 || retryReported).toBe(true);
  expect(w.wakes).toHaveLength(1);
});

test("model switch during an old step prevents its late result from restarting warming", manual, async ($, on) => {
  const w = setup(on);
  on("classic.PostModelSwitch", () => ({}));
  await start($);
  await $.turn.start({ text: "old request", turnId: "old-model-turn" });
  const held = gate();
  w.holdStep(held.wait);
  const pending = (async () => {
    for await (const _ of $.turn.step({ turnId: "old-model-turn", index: 0, model: OPUS, messageCount: 1 })) { /* drain */ }
  })();
  await held.started;
  await $.classic.PostModelSwitch({
    from_model: OPUS, to_model: "claude-sonnet-5-5", requested_model: "sonnet", source: "command",
    context_tokens: 200_000, prompt_cache_warm: true, cache_ttl: "5m",
    estimated_cache_write_usd: 0.75, pricing: "catalog",
  });
  held.release();
  await pending;
  await $.turn.complete({ answer: "old", durationMs: 5, isAborted: false, turnId: "old-model-turn", reason: "answer" });
  await w.clock.advance(10 * MINUTE);
  expect(w.forks).toHaveLength(0);
});


test("hung success debug write cannot retain completed compaction ownership", manual, async ($, on) => {
  const w = setup(on);
  await start($);
  const pane = await mountPane($, "terminal");
  await pane.press({ key: "menu:debug" });
  await pane.unmount();
  await w.prompt($, "main");
  await w.clock.advance(5 * MINUTE + 1);
  await w.compact($);
  await w.clock.advance(200);
  const held = gate();
  w.holdLog('"reason":"conversation compacted"', held.wait);
  const completing = w.finishWake($);
  await held.started;
  const nextCompaction = w.compact($, "manual", "Next manual instructions");
  await w.clock.advance(1000);
  const nativeWhileLogUnsettled = w.native.length;
  held.release();
  await completing;
  const nextResult = await nextCompaction;
  expect(nextResult.skip?.includes("pending request") ?? false).toBe(false);
  expect(nativeWhileLogUnsettled).toBe(2);
});

test("failed proactive guard preserves a retained manual retry record", { options: { ttl: "1h", compactGuard: "experimental" } }, async ($, on) => {
  const w = setup(on);
  w.idle(false);
  await start($);
  await w.prompt($, "main");
  await w.clock.advance(61 * MINUTE);
  w.answer({ skip: "native veto" });
  await w.compact($, "manual", "Retain my manual constraints");
  await w.clock.advance(200);
  await w.finishWake($);
  expect(w.logged.some(text => text.includes("Retry /compact Retain my manual constraints"))).toBe(true);
  await w.prompt($, "new-main-for-proactive");
  w.idle(true);
  w.submitError();
  await w.clock.advance(59 * MINUTE + 1000);
  const logsBeforeReload = w.logged.length;
  await start($);
  expect(w.logged.slice(logsBeforeReload).some(text =>
    text.includes("interrupted by reload") && text.includes("Retry /compact Retain my manual constraints"))).toBe(true);
});

test("usage admission timeout releases native fallback and future warming before API settles", { options: { ttl: "5m", compactGuard: "manual", compactWakeTimeoutSeconds: 5 } }, async ($, on) => {
  const w = setup(on);
  await w.stale($);
  const held = gate();
  w.holdUsage(held.wait);
  const compacting = w.compact($);
  await held.started;
  await w.clock.advance(6000);
  const nativeAtDeadline = w.native.length;
  await w.prompt($, "new-main-after-usage-timeout");
  const forksBefore = w.forks.length;
  await w.clock.advance(270_000);
  const forksWhileUsageUnsettled = w.forks.length;
  held.release();
  await compacting;
  await w.clock.advance(1000);
  expect(nativeAtDeadline).toBe(1);
  expect(forksWhileUsageUnsettled).toBe(forksBefore + 1);
  expect(w.wakes).toHaveLength(0);
  expect(w.native).toHaveLength(1);
});


test("completed Wake resumes requested native compaction before submit API settles", manual, async ($, on) => {
  const w = setup(on);
  await w.stale($);
  const held = gate();
  w.holdSubmit(held.wait);
  await w.compact($);
  const dispatch = w.clock.advance(200);
  await held.started;
  await w.finishWake($);
  const nativeWhileSubmitUnsettled = w.native.length;
  held.release();
  await dispatch;
  await w.clock.advance(1000);
  expect(nativeWhileSubmitUnsettled).toBe(1);
  expect(w.native).toHaveLength(1);
  expect(w.wakes).toHaveLength(1);
});
