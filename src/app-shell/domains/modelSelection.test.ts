import { describe, expect, it } from "vitest";
import type { EngineType, ModelOption } from "../../types";
import {
  CLAUDE_REASONING_OPTIONS,
  getEffectiveReasoningOptions,
  getEffectiveModels,
  getEffectiveSelectedEffort,
  getEffectiveReasoningSupported,
  GROK_REASONING_OPTIONS,
  isReasoningEffortSupportedForEngine,
  getEffectiveSelectedModelId,
  getReasoningOptionsForModel,
  getNextEngineSelectedModelId,
  upsertEngineSelectedModelId,
} from "./modelSelection";

function createModel(
  id: string,
  overrides: Partial<ModelOption> = {},
): ModelOption {
  return {
    id,
    model: id,
    displayName: id,
    description: "",
    source: "unknown",
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
    isDefault: false,
    ...overrides,
  };
}

describe("modelSelection", () => {
  const codexModels = [
    createModel("codex-default", { isDefault: true }),
    createModel("codex-alt"),
  ];
  const engineModels = [
    createModel("engine-default", { isDefault: true }),
    createModel("engine-alt"),
  ];

  it("uses codex models directly when codex is active", () => {
    expect(getEffectiveModels("codex", codexModels, engineModels)).toEqual(codexModels);
  });

  it("uses engine-provided models for non-codex engines", () => {
    expect(getEffectiveModels("claude", codexModels, engineModels)).toEqual(engineModels);
  });

  it("keeps the codex-selected model id when codex is active", () => {
    expect(
      getEffectiveSelectedModelId({
        activeEngine: "codex",
        selectedModelId: "codex-alt",
        activeThreadSelectedModelId: null,
        hasActiveThread: false,
        codexModels,
        engineModelsAsOptions: engineModels,
        engineSelectedModelIdByType: {},
      }),
    ).toBe("codex-alt");
  });

  it("prefers the active codex thread model over the shared codex selection", () => {
    expect(
      getEffectiveSelectedModelId({
        activeEngine: "codex",
        selectedModelId: "codex-default",
        activeThreadSelectedModelId: "codex-alt",
        hasActiveThread: true,
        codexModels,
        engineModelsAsOptions: engineModels,
        engineSelectedModelIdByType: {},
      }),
    ).toBe("codex-alt");
  });

  it.each(["MiniMax-M3", "deepseek/custom-v4", "vendor.model:latest"])(
    "keeps provider-bound custom Codex model %s without catalog validation",
    (modelId) => {
      expect(
        getEffectiveSelectedModelId({
          activeEngine: "codex",
          selectedModelId: "codex-default",
          activeThreadSelectedModelId: ` ${modelId} `,
          hasActiveThread: true,
          allowUnknownActiveThreadModel: true,
          codexModels,
          engineModelsAsOptions: [],
          engineSelectedModelIdByType: {},
        }),
      ).toBe(modelId);
    },
  );

  it("does not preserve a blank provider-bound Codex model id", () => {
    expect(
      getEffectiveSelectedModelId({
        activeEngine: "codex",
        selectedModelId: "codex-alt",
        activeThreadSelectedModelId: "   ",
        hasActiveThread: true,
        allowUnknownActiveThreadModel: true,
        codexModels,
        engineModelsAsOptions: [],
        engineSelectedModelIdByType: {},
      }),
    ).toBe("codex-alt");
  });

  it("falls back to the shared Codex effort when the active thread effort is empty", () => {
    expect(
      getEffectiveSelectedEffort({
        activeEngine: "codex",
        hasActiveThread: true,
        selectedEffort: "high",
        activeThreadSelection: {
          modelId: "codex-alt",
          effort: null,
        },
        reasoningOptions: ["medium", "high"],
      }),
    ).toBe("high");
  });

  it("falls back to the shared effort when the active codex thread has no composer selection", () => {
    expect(
      getEffectiveSelectedEffort({
        activeEngine: "codex",
        hasActiveThread: true,
        selectedEffort: "high",
        activeThreadSelection: null,
        reasoningOptions: ["medium", "high"],
      }),
    ).toBe("high");
  });

  it("derives reasoning options from supported efforts before falling back to the model default", () => {
    expect(
      getReasoningOptionsForModel(
        createModel("codex-alt", {
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "Medium" },
            { reasoningEffort: "high", description: "High" },
          ],
          defaultReasoningEffort: "low",
        }),
      ),
    ).toEqual(["medium", "high"]);
    expect(
      getReasoningOptionsForModel(
        createModel("codex-default", {
          supportedReasoningEfforts: [],
          defaultReasoningEffort: "medium",
        }),
      ),
    ).toEqual(["medium"]);
  });

  it("does not synthesize a Claude default when no Claude models are loaded", () => {
    expect(
      getEffectiveSelectedModelId({
        activeEngine: "claude",
        selectedModelId: "codex-alt",
        activeThreadSelectedModelId: null,
        hasActiveThread: false,
        codexModels,
        engineModelsAsOptions: [],
        engineSelectedModelIdByType: {},
      }),
    ).toBeNull();
  });

  it("prefers a valid non-codex engine selection over defaults", () => {
    const engineSelectedModelIdByType: Partial<Record<EngineType, string | null>> = {
      gemini: "engine-alt",
    };
    expect(
      getEffectiveSelectedModelId({
        activeEngine: "gemini",
        selectedModelId: "codex-alt",
        activeThreadSelectedModelId: null,
        hasActiveThread: false,
        codexModels,
        engineModelsAsOptions: engineModels,
        engineSelectedModelIdByType,
      }),
    ).toBe("engine-alt");
  });

  it("keeps a trusted DSH thread catalog id when the leftover catalog does not match", () => {
    expect(
      getEffectiveSelectedModelId({
        activeEngine: "dsh",
        selectedModelId: "gpt-5.5",
        activeThreadSelectedModelId: "gork-zhu/grok-4.6",
        hasActiveThread: true,
        allowUnknownActiveThreadModel: true,
        codexModels,
        engineModelsAsOptions: [
          createModel("gpt-5.5", { isDefault: true }),
        ],
        engineSelectedModelIdByType: {},
      }),
    ).toBe("gork-zhu/grok-4.6");
  });

  it("keeps a Qoder thread model when the leftover Global/CN catalog does not match", () => {
    expect(
      getEffectiveSelectedModelId({
        activeEngine: "qoder",
        selectedModelId: "other-dist-default",
        activeThreadSelectedModelId: "qoder-coder-v1",
        hasActiveThread: true,
        allowUnknownActiveThreadModel: true,
        codexModels,
        engineModelsAsOptions: [
          createModel("other-dist-default", { isDefault: true }),
        ],
        engineSelectedModelIdByType: {},
      }),
    ).toBe("qoder-coder-v1");
  });

  it("still repairs a Qoder unknown id to catalog default without allowUnknown", () => {
    expect(
      getEffectiveSelectedModelId({
        activeEngine: "qoder",
        selectedModelId: null,
        activeThreadSelectedModelId: "qoder-coder-v1",
        hasActiveThread: true,
        allowUnknownActiveThreadModel: false,
        codexModels,
        engineModelsAsOptions: [
          createModel("other-dist-default", { isDefault: true }),
        ],
        engineSelectedModelIdByType: {},
      }),
    ).toBe("other-dist-default");
  });

  it("still falls back Claude unknown ids to catalog default unless allowUnknown", () => {
    expect(
      getEffectiveSelectedModelId({
        activeEngine: "claude",
        selectedModelId: null,
        activeThreadSelectedModelId: "k3",
        hasActiveThread: true,
        allowUnknownActiveThreadModel: false,
        codexModels,
        engineModelsAsOptions: engineModels,
        engineSelectedModelIdByType: {},
      }),
    ).toBe("engine-default");
  });

  it("falls back to the engine default when the saved non-codex selection is invalid", () => {
    const engineSelectedModelIdByType: Partial<Record<EngineType, string | null>> = {
      opencode: "missing-model",
    };
    expect(
      getEffectiveSelectedModelId({
        activeEngine: "opencode",
        selectedModelId: "codex-alt",
        activeThreadSelectedModelId: null,
        hasActiveThread: false,
        codexModels,
        engineModelsAsOptions: engineModels,
        engineSelectedModelIdByType,
      }),
    ).toBe("engine-default");
  });

  it("prefers the active thread model over the global engine selection", () => {
    const engineSelectedModelIdByType: Partial<Record<EngineType, string | null>> = {
      claude: "engine-default",
    };
    expect(
      getEffectiveSelectedModelId({
        activeEngine: "claude",
        selectedModelId: "codex-alt",
        activeThreadSelectedModelId: "engine-alt",
        hasActiveThread: true,
        codexModels,
        engineModelsAsOptions: engineModels,
        engineSelectedModelIdByType,
      }),
    ).toBe("engine-alt");
  });

  it("keeps a provider-bound Claude model without catalog validation", () => {
    expect(
      getEffectiveSelectedModelId({
        activeEngine: "claude",
        selectedModelId: null,
        activeThreadSelectedModelId: " vendor/claude-compatible-model ",
        hasActiveThread: true,
        allowUnknownActiveThreadModel: true,
        codexModels,
        engineModelsAsOptions: [],
        engineSelectedModelIdByType: {},
      }),
    ).toBe("vendor/claude-compatible-model");
  });

  it("ignores the global engine selection for active threads without a stored model", () => {
    const engineSelectedModelIdByType: Partial<Record<EngineType, string | null>> = {
      claude: "engine-alt",
    };
    expect(
      getEffectiveSelectedModelId({
        activeEngine: "claude",
        selectedModelId: "codex-alt",
        activeThreadSelectedModelId: null,
        hasActiveThread: true,
        codexModels,
        engineModelsAsOptions: engineModels,
        engineSelectedModelIdByType,
      }),
    ).toBe("engine-default");
  });

  it("falls back to the codex default when the thread model is invalid", () => {
    expect(
      getEffectiveSelectedModelId({
        activeEngine: "codex",
        selectedModelId: "missing-model",
        activeThreadSelectedModelId: "missing-thread-model",
        hasActiveThread: true,
        codexModels,
        engineModelsAsOptions: engineModels,
        engineSelectedModelIdByType: {},
      }),
    ).toBe("codex-default");
  });

  it("accepts a stored codex thread model when the persisted value matches the model slug", () => {
    expect(
      getEffectiveSelectedModelId({
        activeEngine: "codex",
        selectedModelId: "codex-alt-model",
        activeThreadSelectedModelId: "codex-alt-model",
        hasActiveThread: true,
        codexModels: [
          createModel("codex-default", { model: "gpt-5.5", isDefault: true }),
          createModel("codex-alt", { model: "codex-alt-model" }),
        ],
        engineModelsAsOptions: engineModels,
        engineSelectedModelIdByType: {},
      }),
    ).toBe("codex-alt");
  });

  it("falls back to the model default when the saved reasoning effort is unsupported", () => {
    expect(
      getEffectiveSelectedEffort({
        activeEngine: "codex",
        hasActiveThread: true,
        selectedEffort: "ultra",
        activeThreadSelection: {
          modelId: "codex-alt",
          effort: "ultra",
        },
        reasoningOptions: ["medium", "high"],
      }),
    ).toBe("medium");
  });

  it("keeps the saved non-codex engine selection when it is still valid", () => {
    expect(
      getNextEngineSelectedModelId({
        activeEngine: "claude",
        engineModelsAsOptions: engineModels,
        currentSelection: "engine-alt",
      }),
    ).toBeNull();
  });

  it("suggests the engine default when the saved non-codex selection is missing", () => {
    expect(
      getNextEngineSelectedModelId({
        activeEngine: "opencode",
        engineModelsAsOptions: engineModels,
        currentSelection: "missing-model",
      }),
    ).toBe("engine-default");
  });

  it("keeps engine selection state identity when the default is already stored", () => {
    const previousSelectionByEngine: Partial<Record<EngineType, string | null>> = {
      claude: "engine-default",
    };

    expect(
      upsertEngineSelectedModelId({
        activeEngine: "claude",
        nextModelId: "engine-default",
        previousSelectionByEngine,
      }),
    ).toBe(previousSelectionByEngine);
  });

  it("does not mutate engine selection state when no default is available", () => {
    const previousSelectionByEngine: Partial<Record<EngineType, string | null>> = {
      claude: "engine-default",
    };

    expect(
      upsertEngineSelectedModelId({
        activeEngine: "claude",
        nextModelId: null,
        previousSelectionByEngine,
      }),
    ).toBe(previousSelectionByEngine);
  });

  it("writes a missing engine default without depending on the full selection map", () => {
    const previousSelectionByEngine: Partial<Record<EngineType, string | null>> = {};

    expect(
      upsertEngineSelectedModelId({
        activeEngine: "opencode",
        nextModelId: "engine-default",
        previousSelectionByEngine,
      }),
    ).toEqual({ opencode: "engine-default" });
  });

  it("exposes reasoning support for codex only when model supports it", () => {
    expect(getEffectiveReasoningSupported("codex", true)).toBe(true);
    expect(getEffectiveReasoningSupported("codex", false)).toBe(false);
    expect(getEffectiveReasoningSupported("gemini", true)).toBe(false);
    expect(isReasoningEffortSupportedForEngine("codex", ["medium"])).toBe(true);
    expect(isReasoningEffortSupportedForEngine("codex", [])).toBe(false);
    expect(isReasoningEffortSupportedForEngine("gemini", ["medium"])).toBe(false);
  });

  it("exposes Claude reasoning support independently from model catalog", () => {
    expect(getEffectiveReasoningSupported("claude", false)).toBe(true);
    expect(getEffectiveReasoningOptions("claude", [])).toEqual(CLAUDE_REASONING_OPTIONS);
  });

  it("exposes Grok reasoning support independently from model catalog", () => {
    expect(getEffectiveReasoningSupported("grok", false)).toBe(true);
    expect(getEffectiveReasoningOptions("grok", [])).toEqual(GROK_REASONING_OPTIONS);
    expect(isReasoningEffortSupportedForEngine("grok", [])).toBe(true);
  });

  it("keeps Claude effort empty until the user selects a thread or draft value", () => {
    expect(
      getEffectiveSelectedEffort({
        activeEngine: "claude",
        hasActiveThread: false,
        selectedEffort: "medium",
        activeThreadSelection: null,
        reasoningOptions: CLAUDE_REASONING_OPTIONS,
      }),
    ).toBeNull();
    expect(
      getEffectiveSelectedEffort({
        activeEngine: "claude",
        hasActiveThread: true,
        selectedEffort: "medium",
        activeThreadSelection: {
          modelId: "claude-custom",
          effort: "high",
        },
        reasoningOptions: CLAUDE_REASONING_OPTIONS,
      }),
    ).toBe("high");
    expect(
      getEffectiveSelectedEffort({
        activeEngine: "claude",
        hasActiveThread: false,
        selectedEffort: "medium",
        activeThreadSelection: {
          modelId: "claude-custom",
          effort: "high",
        },
        reasoningOptions: CLAUDE_REASONING_OPTIONS,
      }),
    ).toBe("high");
  });

  it("keeps Grok effort empty until the user selects a thread or draft value", () => {
    expect(
      getEffectiveSelectedEffort({
        activeEngine: "grok",
        hasActiveThread: false,
        selectedEffort: "medium",
        activeThreadSelection: null,
        reasoningOptions: GROK_REASONING_OPTIONS,
      }),
    ).toBeNull();
    expect(
      getEffectiveSelectedEffort({
        activeEngine: "grok",
        hasActiveThread: true,
        selectedEffort: "medium",
        activeThreadSelection: {
          modelId: "grok-4.5",
          effort: "high",
        },
        reasoningOptions: GROK_REASONING_OPTIONS,
      }),
    ).toBe("high");
  });

  it("ignores unsupported Claude effort instead of injecting a fallback value", () => {
    expect(
      getEffectiveSelectedEffort({
        activeEngine: "claude",
        hasActiveThread: true,
        selectedEffort: "medium",
        activeThreadSelection: {
          modelId: "claude-custom",
          effort: "ultra",
        },
        reasoningOptions: CLAUDE_REASONING_OPTIONS,
      }),
    ).toBeNull();
  });

  it("ignores unsupported Grok effort instead of injecting a fallback value", () => {
    expect(
      getEffectiveSelectedEffort({
        activeEngine: "grok",
        hasActiveThread: true,
        selectedEffort: "medium",
        activeThreadSelection: {
          modelId: "grok-4.5",
          effort: "xhigh",
        },
        reasoningOptions: GROK_REASONING_OPTIONS,
      }),
    ).toBeNull();
  });

  it("exposes DSH reasoning support only when the model declares efforts", () => {
    expect(getEffectiveReasoningSupported("dsh", true)).toBe(true);
    expect(getEffectiveReasoningSupported("dsh", false)).toBe(false);
    expect(isReasoningEffortSupportedForEngine("dsh", ["off", "low", "high", "max"])).toBe(true);
    expect(isReasoningEffortSupportedForEngine("dsh", [])).toBe(false);
    expect(getEffectiveReasoningOptions("dsh", ["off", "low", "high", "max"])).toEqual([
      "off",
      "low",
      "high",
      "max",
    ]);
  });

  it("keeps a valid DSH thread effort and falls back to model default otherwise", () => {
    const options = ["off", "low", "high", "max"];
    expect(
      getEffectiveSelectedEffort({
        activeEngine: "dsh",
        hasActiveThread: true,
        selectedEffort: "low",
        activeThreadSelection: {
          modelId: "deepseek-official/deepseek-v4-flash",
          effort: "high",
        },
        reasoningOptions: options,
      }),
    ).toBe("high");
    expect(
      getEffectiveSelectedEffort({
        activeEngine: "dsh",
        hasActiveThread: false,
        selectedEffort: "max",
        activeThreadSelection: null,
        reasoningOptions: options,
      }),
    ).toBe("max");
    // 非法档位（模型不支持）回落模型第一档，而不是透传
    expect(
      getEffectiveSelectedEffort({
        activeEngine: "dsh",
        hasActiveThread: true,
        selectedEffort: "medium",
        activeThreadSelection: {
          modelId: "deepseek-official/deepseek-v4-flash",
          effort: "medium",
        },
        reasoningOptions: options,
      }),
    ).toBe("off");
  });

  it("derives DSH reasoning options from the model catalog", () => {
    const model = createModel("deepseek-official/deepseek-v4-flash", {
      supportedReasoningEfforts: [
        { reasoningEffort: "off", description: "" },
        { reasoningEffort: "low", description: "" },
        { reasoningEffort: "high", description: "" },
        { reasoningEffort: "max", description: "" },
      ],
      defaultReasoningEffort: "high",
    });
    expect(getReasoningOptionsForModel(model)).toEqual(["off", "low", "high", "max"]);
    const plain = createModel("gork-zhu/grok-4.6");
    expect(getReasoningOptionsForModel(plain)).toEqual([]);
  });

  it("drops stale reasoning effort for unsupported engines", () => {
    expect(
      getEffectiveSelectedEffort({
        activeEngine: "gemini",
        hasActiveThread: true,
        selectedEffort: "high",
        activeThreadSelection: {
          modelId: "gemini-pro",
          effort: "high",
        },
        reasoningOptions: CLAUDE_REASONING_OPTIONS,
      }),
    ).toBeNull();
    expect(
      getEffectiveSelectedEffort({
        activeEngine: "opencode",
        hasActiveThread: false,
        selectedEffort: "medium",
        activeThreadSelection: null,
        reasoningOptions: ["medium"],
      }),
    ).toBeNull();
  });
});
