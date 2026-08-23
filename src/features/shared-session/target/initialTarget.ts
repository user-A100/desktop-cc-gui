import type { EngineModelInfo } from "../../../types";
import { resolveAtomicReasoningEffort } from "../../models/atomicModelReasoning";
import {
  CLAUDE_LOCAL_PROVIDER_PROFILE_ID,
  CODEX_DISK_PROVIDER_PROFILE_ID,
  GROK_LOCAL_PROVIDER_PROFILE_ID,
  KIMI_LOCAL_PROVIDER_PROFILE_ID,
  LOCAL_PROVIDER_PROFILE_DISPLAY_NAME,
  OPENCODE_LOCAL_PROVIDER_PROFILE_ID,
  PI_LOCAL_PROVIDER_PROFILE_ID,
  QODER_GLOBAL_PROVIDER_PROFILE_NAME,
  QODER_GLOBAL_PROVIDER_PROFILE_ID,
} from "../../threads/constants/codexProviderProfiles";
import type { SharedSessionSupportedEngine } from "../utils/sharedSessionEngines";

import type { ExecutionTarget } from "./types";

/**
 * Shared 创建时写入的 Provider 语义（列表第一项）。
 * `providerProfileId` 在 local 时为 sentinel id（加载 catalog 用），
 * 落到 ExecutionTarget 时 local 会规范为 null。
 */
export type SharedCreateProviderProfile = {
  id: string;
  name: string;
  source: "disk" | "managed";
};

export function localProviderSentinelId(
  engine: SharedSessionSupportedEngine,
): string {
  switch (engine) {
    case "claude":
      return CLAUDE_LOCAL_PROVIDER_PROFILE_ID;
    case "codex":
      return CODEX_DISK_PROVIDER_PROFILE_ID;
    case "kimi":
      return KIMI_LOCAL_PROVIDER_PROFILE_ID;
    case "grok":
      return GROK_LOCAL_PROVIDER_PROFILE_ID;
    case "opencode":
      return OPENCODE_LOCAL_PROVIDER_PROFILE_ID;
    case "pi":
      return PI_LOCAL_PROVIDER_PROFILE_ID;
    case "qoder":
      return QODER_GLOBAL_PROVIDER_PROFILE_ID;
  }
}

export function isSharedCreateLocalProvider(
  engine: SharedSessionSupportedEngine,
  providerProfileId: string,
): boolean {
  // Qoder Global/CN 是固定 runtime distribution；虽无供应商 CRUD，但也不能按
  // disk local sentinel 处理，否则 ExecutionTarget 会丢掉 distribution identity。
  if (engine === "qoder") {
    return false;
  }
  return providerProfileId.trim() === localProviderSentinelId(engine);
}

/**
 * Shared 完整 initial Target（local 或 managed）。
 *
 * 纪律：只信「本 CLI + 本 Provider 的 model catalog 默认行」，
 * 禁止借用全局/Native composer 的 model 或 effort。
 */
export function buildSharedSessionInitialTarget(input: {
  engine: SharedSessionSupportedEngine;
  models: EngineModelInfo[];
  provider: SharedCreateProviderProfile;
  unavailableModelMessage: string;
}): ExecutionTarget {
  const selectedModel =
    input.models.find((model) => model.isDefault) ?? input.models[0] ?? null;
  const modelCatalogEntryId = selectedModel?.id.trim() ?? "";
  const runtimeModel =
    selectedModel?.model?.trim() || modelCatalogEntryId;
  if (!modelCatalogEntryId || !runtimeModel) {
    throw new Error(input.unavailableModelMessage);
  }

  const isLocal = input.provider.source === "disk";
  const providerName =
    input.provider.name.trim() ||
    (isLocal ? LOCAL_PROVIDER_PROFILE_DISPLAY_NAME : input.provider.id);

  // 按目标 engine+model capability 播种；禁止 inherit 全局 Native effort。
  const seededEffort = resolveAtomicReasoningEffort({
    engine: input.engine,
    model: {
      id: modelCatalogEntryId,
      model: runtimeModel,
      source: selectedModel?.source ?? null,
    },
    previousEffort: null,
    inherit: false,
  });

  return {
    engine: input.engine,
    providerProfileId: isLocal ? null : input.provider.id.trim() || null,
    modelCatalogEntryId,
    model: runtimeModel,
    reasoning: seededEffort ? { effort: seededEffort } : null,
    providerProfileNameSnapshot: providerName,
    providerProfileSource: isLocal ? "disk" : "managed",
  };
}

/**
 * Shared 本地默认 Target（兼容包装）。
 *
 * @deprecated 新代码优先用 {@link buildSharedSessionInitialTarget} /
 * {@link resolveSharedSessionCreateInitialTarget}。
 */
export function buildLocalSharedSessionInitialTarget(
  engine: SharedSessionSupportedEngine,
  models: EngineModelInfo[],
  localProviderName: string,
  unavailableModelMessage: string,
): ExecutionTarget {
  return buildSharedSessionInitialTarget({
    engine,
    models,
    provider: {
      id: localProviderSentinelId(engine),
      name:
        engine === "qoder"
          ? QODER_GLOBAL_PROVIDER_PROFILE_NAME
          : localProviderName.trim() || LOCAL_PROVIDER_PROFILE_DISPLAY_NAME,
      source: engine === "qoder" ? "managed" : "disk",
    },
    unavailableModelMessage,
  });
}
