import { describe, test, expect } from "vitest";
import { DISTILLATION_SYSTEM, RECURSIVE_SYSTEM } from "../src/prompt";

/**
 * The retrieval diagnostic (#961) found the exact facts users ask to recall —
 * hex colors, CSS declarations, pixel dimensions, version tags, selectors —
 * were dropped from distillations as "styling/config" noise. These tests lock
 * in the prompt guidance that those literal values must be retained verbatim,
 * through both first-pass distillation and recursive consolidation.
 */
describe("distillation prompts — exact literal value preservation (#961)", () => {
  test("DISTILLATION_SYSTEM instructs verbatim retention of hex/CSS/version literals", () => {
    for (const token of [
      "#1164a3",
      "border-radius",
      "inset 0 8px 0 0",
      "v45",
      "ThreadList",
    ]) {
      expect(DISTILLATION_SYSTEM).toContain(token);
    }
    // Frames styling/config as high-value, not skippable noise.
    expect(DISTILLATION_SYSTEM.toLowerCase()).toContain("literal");
  });

  test("RECURSIVE_SYSTEM preserves literal style/config values through consolidation", () => {
    for (const token of ["#1164a3", "border-radius", "v45"]) {
      expect(RECURSIVE_SYSTEM).toContain(token);
    }
    expect(RECURSIVE_SYSTEM.toLowerCase()).toContain("never paraphrase");
  });
});
