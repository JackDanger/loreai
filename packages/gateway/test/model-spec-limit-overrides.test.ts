/**
 * Regression coverage for `modelLimits` / `LORE_MODEL_OVERRIDES`.
 *
 * Root cause this guards against: `getModelSpec()` sizes a turn's dynamic
 * `max_tokens` from a model's context/output limits, looked up by
 * prefix-matching the model id against the public models.dev catalog
 * (`matchModelEntry` in worker-model.ts). A self-hosted model with a
 * custom name (e.g. "qwen-fast") doesn't exist in that catalog, but the
 * prefix match can still hit an UNRELATED real model and silently inherit
 * its (possibly much smaller) limits — producing a tiny effective
 * `max_tokens` that truncates generation after a handful of tokens.
 *
 * `modelLimits` (config, exact match) / `LORE_MODEL_OVERRIDES` (env, exact
 * match) let the real limits be declared explicitly, bypassing the
 * catalog lookup entirely for that model id.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { config as loreConfig, load } from "@loreai/core";
import { getModelSpec } from "../src/pipeline";
import { _setModelDataForTest, clearModelDataCache } from "../src/worker-model";

// A real-catalog model whose id happens to prefix-match our fictional
// self-hosted model name below, with tiny limits — reproduces the bug.
const UNRELATED_TINY_MODEL = {
  id: "qwen",
  cost: { input: 0.1, output: 0.2, cache_read: 0.01 },
  limit: { context: 4_096, output: 512 },
};

const SELF_HOSTED_MODEL_ID = "qwen-fast";

describe("getModelSpec model-limit overrides", () => {
  let savedEnvOverrides: string | undefined;

  beforeEach(async () => {
    savedEnvOverrides = process.env.LORE_MODEL_OVERRIDES;
    delete process.env.LORE_MODEL_OVERRIDES;
    await load(process.cwd());
    (loreConfig() as { modelLimits?: unknown }).modelLimits = undefined;
    // Seed a catalog entry that prefix-matches SELF_HOSTED_MODEL_ID
    // ("qwen-fast".startsWith("qwen")) with limits that are NOT the real
    // solvency ones — this is the exact failure mode being fixed.
    _setModelDataForTest({ qwen: UNRELATED_TINY_MODEL }, {});
  });

  afterEach(() => {
    if (savedEnvOverrides !== undefined)
      process.env.LORE_MODEL_OVERRIDES = savedEnvOverrides;
    else delete process.env.LORE_MODEL_OVERRIDES;
    (loreConfig() as { modelLimits?: unknown }).modelLimits = undefined;
    clearModelDataCache();
  });

  test("without an override, an unknown self-hosted model id can prefix-match an unrelated catalog entry (the bug)", () => {
    const spec = getModelSpec(SELF_HOSTED_MODEL_ID);
    expect(spec.context).toBe(4_096);
    expect(spec.output).toBe(512);
  });

  test("a config modelLimits override wins over the models.dev prefix match", () => {
    (
      loreConfig() as {
        modelLimits?: Record<string, { context: number; output: number }>;
      }
    ).modelLimits = {
      [SELF_HOSTED_MODEL_ID]: { context: 262_144, output: 8_192 },
    };
    const spec = getModelSpec(SELF_HOSTED_MODEL_ID);
    expect(spec.context).toBe(262_144);
    expect(spec.output).toBe(8_192);
  });

  test("LORE_MODEL_OVERRIDES env var applies when config doesn't set an override", () => {
    process.env.LORE_MODEL_OVERRIDES = JSON.stringify({
      [SELF_HOSTED_MODEL_ID]: { context: 262_144, output: 8_192 },
      "qwen-smart": { context: 262_144, output: 8_192 },
    });
    const spec = getModelSpec(SELF_HOSTED_MODEL_ID);
    expect(spec.context).toBe(262_144);
    expect(spec.output).toBe(8_192);
    expect(getModelSpec("qwen-smart").context).toBe(262_144);
  });

  test("config modelLimits wins over LORE_MODEL_OVERRIDES when both set", () => {
    process.env.LORE_MODEL_OVERRIDES = JSON.stringify({
      [SELF_HOSTED_MODEL_ID]: { context: 1_000, output: 1_000 },
    });
    (
      loreConfig() as {
        modelLimits?: Record<string, { context: number; output: number }>;
      }
    ).modelLimits = {
      [SELF_HOSTED_MODEL_ID]: { context: 262_144, output: 8_192 },
    };
    const spec = getModelSpec(SELF_HOSTED_MODEL_ID);
    expect(spec.context).toBe(262_144);
    expect(spec.output).toBe(8_192);
  });

  test("an override only applies to its exact model id, not other models", () => {
    (
      loreConfig() as {
        modelLimits?: Record<string, { context: number; output: number }>;
      }
    ).modelLimits = {
      [SELF_HOSTED_MODEL_ID]: { context: 262_144, output: 8_192 },
    };
    // A different, unrelated model id still falls through to the (unfixed)
    // catalog prefix-match / default path — overrides are not global.
    const other = getModelSpec("some-other-model");
    expect(other.context).not.toBe(262_144);
  });

  test("invalid JSON in LORE_MODEL_OVERRIDES is ignored, not a crash", () => {
    process.env.LORE_MODEL_OVERRIDES = "{not valid json";
    expect(() => getModelSpec(SELF_HOSTED_MODEL_ID)).not.toThrow();
    // Falls through to the (buggy but non-fatal) catalog prefix match.
    expect(getModelSpec(SELF_HOSTED_MODEL_ID).context).toBe(4_096);
  });

  test("cost fields still come from the models.dev entry, unaffected by a limit override", () => {
    (
      loreConfig() as {
        modelLimits?: Record<string, { context: number; output: number }>;
      }
    ).modelLimits = {
      [SELF_HOSTED_MODEL_ID]: { context: 262_144, output: 8_192 },
    };
    const spec = getModelSpec(SELF_HOSTED_MODEL_ID);
    // Still picks up UNRELATED_TINY_MODEL's cost via the prefix match —
    // only context/output are overridden, cost is out of scope for this fix.
    expect(spec.inputCostPerMillion).toBe(0.1);
  });
});
