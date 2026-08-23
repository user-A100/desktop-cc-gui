import { describe, expect, it } from "vitest";
import {
  isAtomicExecutionTarget,
  isResolvedExecutionTarget,
} from "./types";

describe("isAtomicExecutionTarget", () => {
  it("accepts PI local target as atomic and, after Shared extension, resolved", () => {
    const target = {
      engine: "pi" as const,
      providerProfileId: null,
      modelCatalogEntryId: "kimi-coding/k3",
      model: "kimi-coding/k3",
      providerProfileNameSnapshot: "本地配置",
      providerProfileSource: "disk" as const,
      reasoning: null,
    };
    expect(isAtomicExecutionTarget(target)).toBe(true);
    expect(isResolvedExecutionTarget(target)).toBe(true);
  });

  it("accepts Qoder Global target as atomic and, after Shared extension, resolved", () => {
    const target = {
      engine: "qoder" as const,
      providerProfileId: "__qoder_global__",
      modelCatalogEntryId: "minimax/minimax-m3-cp",
      model: "minimax/minimax-m3-cp",
      providerProfileNameSnapshot: "Qoder Global",
      providerProfileSource: "managed" as const,
      reasoning: null,
    };
    expect(isAtomicExecutionTarget(target)).toBe(true);
    expect(isResolvedExecutionTarget(target)).toBe(true);
  });

  it("rejects an unnormalized Qoder local sentinel with disk source", () => {
    const target = {
      engine: "qoder" as const,
      providerProfileId: "__local_qoder__",
      modelCatalogEntryId: "minimax/minimax-m3-cp",
      model: "minimax/minimax-m3-cp",
      providerProfileNameSnapshot: "本地配置",
      providerProfileSource: "disk" as const,
      reasoning: null,
    };
    expect(isAtomicExecutionTarget(target)).toBe(false);
  });

  it("still accepts shared engines as both atomic and resolved", () => {
    const target = {
      engine: "kimi" as const,
      providerProfileId: null,
      modelCatalogEntryId: "kimi-k3",
      model: "kimi-k3",
      providerProfileNameSnapshot: "本地配置",
      providerProfileSource: "disk" as const,
      reasoning: null,
    };
    expect(isAtomicExecutionTarget(target)).toBe(true);
    expect(isResolvedExecutionTarget(target)).toBe(true);
  });

  it("does not treat Gemini as atomic because execution policy disables it", () => {
    const target = {
      engine: "gemini" as const,
      providerProfileId: null,
      modelCatalogEntryId: "gemini-2.5-pro",
      model: "gemini-2.5-pro",
      providerProfileNameSnapshot: "本地配置",
      providerProfileSource: "disk" as const,
      reasoning: null,
    };
    expect(isAtomicExecutionTarget(target)).toBe(false);
    expect(isResolvedExecutionTarget(target)).toBe(false);
  });
});
