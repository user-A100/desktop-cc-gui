import { describe, expect, it } from "vitest";

import {
  buildLocalSharedSessionInitialTarget,
  buildSharedSessionInitialTarget,
} from "./initialTarget";

describe("buildLocalSharedSessionInitialTarget", () => {
  it("uses the selected CLI default model without borrowing composer state", () => {
    expect(
      buildLocalSharedSessionInitialTarget(
        "opencode",
        [
          {
            id: "opencode/first",
            displayName: "First",
            description: "",
            isDefault: false,
          },
          {
            id: "minimax-cn-coding-plan/MiniMax-M2.5",
            model: "minimax-cn-coding-plan/MiniMax-M2.5",
            displayName: "MiniMax M2.5",
            description: "",
            isDefault: true,
          },
        ],
        "本地配置",
        "OpenCode 没有可用于 Shared Session 的本地 Model。",
      ),
    ).toEqual({
      engine: "opencode",
      providerProfileId: null,
      modelCatalogEntryId: "minimax-cn-coding-plan/MiniMax-M2.5",
      model: "minimax-cn-coding-plan/MiniMax-M2.5",
      reasoning: null,
      providerProfileNameSnapshot: "本地配置",
      providerProfileSource: "disk",
    });
  });

  it("seeds Grok with null effort and does not invent Codex-tier options", () => {
    // Native Codex 可能残留 high/ultra；初始化 Shared Grok 时不得借用。
    expect(
      buildLocalSharedSessionInitialTarget(
        "grok",
        [
          {
            id: "grok-4-1-fast",
            model: "grok-4-1-fast",
            displayName: "Grok 4.5",
            description: "",
            isDefault: true,
            source: "builtin",
          },
        ],
        "本地配置",
        "Grok CLI 没有可用于 Shared Session 的本地 Model。",
      ),
    ).toEqual({
      engine: "grok",
      providerProfileId: null,
      modelCatalogEntryId: "grok-4-1-fast",
      model: "grok-4-1-fast",
      reasoning: null,
      providerProfileNameSnapshot: "本地配置",
      providerProfileSource: "disk",
    });
  });

  it("seeds Codex catalog model default effort without Native composer state", () => {
    expect(
      buildLocalSharedSessionInitialTarget(
        "codex",
        [
          {
            id: "gpt-5.6-sol",
            model: "gpt-5.6-sol",
            displayName: "gpt-5.6-sol",
            description: "",
            isDefault: true,
            source: "fallback",
          },
        ],
        "本地配置",
        "Codex 没有可用于 Shared Session 的本地 Model。",
      ),
    ).toEqual(
      expect.objectContaining({
        engine: "codex",
        modelCatalogEntryId: "gpt-5.6-sol",
        model: "gpt-5.6-sol",
        reasoning: { effort: "low" },
      }),
    );
  });

  it("fails closed when the selected CLI has no usable local model", () => {
    expect(() =>
      buildLocalSharedSessionInitialTarget(
        "grok",
        [],
        "本地配置",
        "Grok CLI 没有可用于 Shared Session 的本地 Model。",
      ),
    ).toThrow("Grok CLI");
  });

  it("keeps the Qoder Global distribution as an explicit managed binding", () => {
    expect(
      buildLocalSharedSessionInitialTarget(
        "qoder",
        [
          {
            id: "qoder-global-model",
            model: "qoder-global-model",
            displayName: "Qoder Global model",
            description: "",
            isDefault: true,
          },
        ],
        "本地配置",
        "Qoder 没有可用 Model。",
      ),
    ).toEqual(
      expect.objectContaining({
        engine: "qoder",
        providerProfileId: "__qoder_global__",
        providerProfileNameSnapshot: "Qoder Global",
        providerProfileSource: "managed",
      }),
    );
  });
});

describe("buildSharedSessionInitialTarget", () => {
  it("labels managed first provider without faking local disk", () => {
    expect(
      buildSharedSessionInitialTarget({
        engine: "claude",
        models: [
          {
            id: "claude-sonnet-5",
            model: "MiniMax-M3",
            displayName: "MiniMax-M3",
            description: "",
            isDefault: true,
          },
        ],
        provider: {
          id: "minimax-m3",
          name: "MiniMax-M3",
          source: "managed",
        },
        unavailableModelMessage: "Claude 没有可用 Model。",
      }),
    ).toEqual(
      expect.objectContaining({
        engine: "claude",
        providerProfileId: "minimax-m3",
        modelCatalogEntryId: "claude-sonnet-5",
        model: "MiniMax-M3",
        providerProfileNameSnapshot: "MiniMax-M3",
        providerProfileSource: "managed",
      }),
    );
  });

  it("keeps local sentinel as null providerProfileId on disk source", () => {
    expect(
      buildSharedSessionInitialTarget({
        engine: "claude",
        models: [
          {
            id: "claude-opus-5",
            model: "claude-opus-5",
            displayName: "Opus 5",
            description: "",
            isDefault: true,
          },
        ],
        provider: {
          id: "__local_settings_json__",
          name: "本地配置",
          source: "disk",
        },
        unavailableModelMessage: "Claude 没有可用 Model。",
      }),
    ).toEqual(
      expect.objectContaining({
        providerProfileId: null,
        providerProfileSource: "disk",
        providerProfileNameSnapshot: "本地配置",
      }),
    );
  });
});
