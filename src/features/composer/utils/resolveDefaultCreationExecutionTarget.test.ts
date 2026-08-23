import { describe, expect, it } from "vitest";

import { isResolvedExecutionTarget } from "../../shared-session/target/types";
import {
  DSH_LOCAL_PROVIDER_PROFILE_ID,
  GROK_LOCAL_PROVIDER_PROFILE_ID,
  LOCAL_PROVIDER_PROFILE_DISPLAY_NAME,
  PI_LOCAL_PROVIDER_PROFILE_ID,
  QODER_CN_PROVIDER_PROFILE_ID,
  QODER_CN_PROVIDER_PROFILE_NAME,
  QODER_GLOBAL_PROVIDER_PROFILE_ID,
  QODER_GLOBAL_PROVIDER_PROFILE_NAME,
  QODER_LOCAL_PROVIDER_PROFILE_ID,
} from "../../threads/constants/codexProviderProfiles";
import {
  isResolvedCreationExecutionTarget,
  resolveDefaultCreationExecutionTarget,
} from "./resolveDefaultCreationExecutionTarget";

describe("resolveDefaultCreationExecutionTarget", () => {
  it("returns null when create-session is disabled", () => {
    expect(
      resolveDefaultCreationExecutionTarget({
        enabled: false,
        selectedEngine: "grok",
        selectedModelId: "grok",
        models: [{ id: "grok", model: "grok", isDefault: true }],
      }),
    ).toBeNull();
  });

  it("returns null for unsupported engines such as gemini", () => {
    expect(
      resolveDefaultCreationExecutionTarget({
        enabled: true,
        selectedEngine: "gemini",
        selectedModelId: "gemini-2.5-pro",
        models: [{ id: "gemini-2.5-pro", model: "gemini-2.5-pro" }],
      }),
    ).toBeNull();
  });

  it("builds a resolved Grok local target from parent models (home create-session)", () => {
    const target = resolveDefaultCreationExecutionTarget({
      enabled: true,
      selectedEngine: "grok",
      selectedModelId: "Grok 4.5",
      selectedEffort: null,
      providerProfileId: GROK_LOCAL_PROVIDER_PROFILE_ID,
      models: [
        {
          id: "Grok 4.5",
          model: "grok-4.5",
          isDefault: true,
        },
      ],
    });

    expect(target).toEqual({
      engine: "grok",
      providerProfileId: null,
      modelCatalogEntryId: "Grok 4.5",
      model: "grok-4.5",
      reasoning: null,
      providerProfileNameSnapshot: LOCAL_PROVIDER_PROFILE_DISPLAY_NAME,
      providerProfileSource: "disk",
    });
    expect(isResolvedExecutionTarget(target)).toBe(true);
  });

  it("falls back to default/first catalog row when selectedModelId is empty", () => {
    const target = resolveDefaultCreationExecutionTarget({
      enabled: true,
      selectedEngine: "kimi",
      selectedModelId: null,
      models: [
        { id: "k2", model: "kimi-k2", isDefault: false },
        { id: "k3", model: "kimi-k3", isDefault: true },
      ],
    });

    expect(target?.modelCatalogEntryId).toBe("k3");
    expect(target?.model).toBe("kimi-k3");
    expect(target?.engine).toBe("kimi");
    expect(isResolvedExecutionTarget(target)).toBe(true);
  });

  it("uses model id as runtime when catalog row has no model field", () => {
    const target = resolveDefaultCreationExecutionTarget({
      enabled: true,
      selectedEngine: "opencode",
      selectedModelId: "opencode-default",
      models: [{ id: "opencode-default" }],
    });

    expect(target).toMatchObject({
      engine: "opencode",
      modelCatalogEntryId: "opencode-default",
      model: "opencode-default",
      providerProfileSource: "disk",
    });
    expect(isResolvedExecutionTarget(target)).toBe(true);
  });

  it("synthesizes snapshot target when models list is empty but selectedModelId exists", () => {
    const target = resolveDefaultCreationExecutionTarget({
      enabled: true,
      selectedEngine: "grok",
      selectedModelId: "grok",
      models: [],
    });

    expect(target).toMatchObject({
      engine: "grok",
      modelCatalogEntryId: "grok",
      model: "grok",
      providerProfileId: null,
      providerProfileSource: "disk",
    });
    // 闭合态可展示；resolved 供发送
    expect(isResolvedExecutionTarget(target)).toBe(true);
  });

  it("keeps managed provider profile id when not a local sentinel", () => {
    const target = resolveDefaultCreationExecutionTarget({
      enabled: true,
      selectedEngine: "codex",
      selectedModelId: "gpt-5.5",
      providerProfileId: "provider-deepseek",
      models: [{ id: "gpt-5.5", model: "deepseek-v4-pro", isDefault: true }],
    });

    expect(target).toMatchObject({
      engine: "codex",
      providerProfileId: "provider-deepseek",
      modelCatalogEntryId: "gpt-5.5",
      model: "deepseek-v4-pro",
      providerProfileNameSnapshot: "provider-deepseek",
      providerProfileSource: "managed",
    });
    expect(isResolvedExecutionTarget(target)).toBe(true);
  });

  it("builds a resolved DSH host catalog target for home create-session", () => {
    const target = resolveDefaultCreationExecutionTarget({
      enabled: true,
      selectedEngine: "dsh",
      selectedModelId: "grok-4.6/Grok 4.5",
      providerProfileId: DSH_LOCAL_PROVIDER_PROFILE_ID,
      models: [
        {
          id: "grok-4.6/Grok 4.5",
          model: "Grok 4.5",
        },
        {
          id: "grok-4.6/Grok 4.6",
          model: "Grok 4.6",
          isDefault: true,
        },
      ],
    });

    expect(target).toEqual({
      engine: "dsh",
      providerProfileId: null,
      modelCatalogEntryId: "grok-4.6/Grok 4.5",
      model: "Grok 4.5",
      reasoning: null,
      providerProfileNameSnapshot: LOCAL_PROVIDER_PROFILE_DISPLAY_NAME,
      providerProfileSource: "disk",
    });
    expect(isResolvedExecutionTarget(target)).toBe(false);
    expect(isResolvedCreationExecutionTarget(target)).toBe(true);
  });

  it("builds a resolved Qoder target for home create-session", () => {
    const target = resolveDefaultCreationExecutionTarget({
      enabled: true,
      selectedEngine: "qoder",
      selectedModelId: "minimax/minimax-m3-cp",
      providerProfileId: QODER_LOCAL_PROVIDER_PROFILE_ID,
      models: [
        {
          id: "qmodel_38max",
          model: "qmodel_38max",
        },
        {
          id: "minimax/minimax-m3-cp",
          model: "minimax/minimax-m3-cp",
          isDefault: true,
        },
      ],
    });

    expect(target).toEqual({
      engine: "qoder",
      providerProfileId: QODER_GLOBAL_PROVIDER_PROFILE_ID,
      modelCatalogEntryId: "minimax/minimax-m3-cp",
      model: "minimax/minimax-m3-cp",
      reasoning: null,
      providerProfileNameSnapshot: QODER_GLOBAL_PROVIDER_PROFILE_NAME,
      providerProfileSource: "managed",
    });
    // Qoder 已进 Shared 集合（enable-qoder-shared-target）：Shared 契约与创建契约都放行。
    expect(isResolvedExecutionTarget(target)).toBe(true);
    expect(isResolvedCreationExecutionTarget(target)).toBe(true);
  });

  it("preserves the explicit Qoder CN distribution binding", () => {
    const target = resolveDefaultCreationExecutionTarget({
      enabled: true,
      selectedEngine: "qoder",
      selectedModelId: "qoder-cn-model",
      providerProfileId: QODER_CN_PROVIDER_PROFILE_ID,
      models: [{ id: "qoder-cn-model", isDefault: true }],
    });

    expect(target).toMatchObject({
      engine: "qoder",
      providerProfileId: QODER_CN_PROVIDER_PROFILE_ID,
      providerProfileNameSnapshot: QODER_CN_PROVIDER_PROFILE_NAME,
      providerProfileSource: "managed",
    });
    expect(isResolvedCreationExecutionTarget(target)).toBe(true);
  });

  it("rejects an incomplete DSH target on the create-session contract", () => {
    expect(
      isResolvedCreationExecutionTarget({
        engine: "dsh",
        providerProfileId: null,
        modelCatalogEntryId: "grok-4.6/Grok 4.5",
        model: "Grok 4.5",
        providerProfileNameSnapshot: "本地配置",
      }),
    ).toBe(false);
  });

  it("still builds Claude local defaults (regression)", () => {
    const target = resolveDefaultCreationExecutionTarget({
      enabled: true,
      selectedEngine: "claude",
      selectedModelId: "claude-sonnet-4-6",
      models: [
        {
          id: "claude-sonnet-4-6",
          model: "claude-sonnet-4-6",
          isDefault: true,
        },
      ],
    });

    expect(target?.engine).toBe("claude");
    expect(target?.providerProfileSource).toBe("disk");
    expect(isResolvedExecutionTarget(target)).toBe(true);
  });

  it("treats the PI local sentinel as disk, not a managed profile", () => {
    const target = resolveDefaultCreationExecutionTarget({
      enabled: true,
      selectedEngine: "pi",
      selectedModelId: "kimi-coding/k3",
      providerProfileId: PI_LOCAL_PROVIDER_PROFILE_ID,
      models: [
        {
          id: "kimi-coding/k3",
          model: "kimi-coding/k3",
          isDefault: true,
        },
      ],
    });

    expect(target).toEqual({
      engine: "pi",
      providerProfileId: null,
      modelCatalogEntryId: "kimi-coding/k3",
      model: "kimi-coding/k3",
      reasoning: null,
      providerProfileNameSnapshot: LOCAL_PROVIDER_PROFILE_DISPLAY_NAME,
      providerProfileSource: "disk",
    });
    expect(isResolvedExecutionTarget(target)).toBe(true);
  });
});
