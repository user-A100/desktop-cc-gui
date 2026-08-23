import type { EngineType } from "../../../types";
import {
  isResolvedExecutionTarget,
  type ExecutionTarget,
} from "../../shared-session/target/types";
import {
  isSharedSessionSupportedEngine,
  type SharedSessionSupportedEngine,
} from "../../shared-session/utils/sharedSessionEngines";
import {
  CLAUDE_LOCAL_PROVIDER_PROFILE_ID,
  CODEX_DISK_PROVIDER_PROFILE_ID,
  DSH_LOCAL_PROVIDER_PROFILE_ID,
  GROK_LOCAL_PROVIDER_PROFILE_ID,
  KIMI_LOCAL_PROVIDER_PROFILE_ID,
  LOCAL_PROVIDER_PROFILE_DISPLAY_NAME,
  OPENCODE_LOCAL_PROVIDER_PROFILE_ID,
  PI_LOCAL_PROVIDER_PROFILE_ID,
  QODER_CN_PROVIDER_PROFILE_ID,
  QODER_CN_PROVIDER_PROFILE_NAME,
  QODER_GLOBAL_PROVIDER_PROFILE_ID,
  QODER_GLOBAL_PROVIDER_PROFILE_NAME,
  QODER_LOCAL_PROVIDER_PROFILE_ID,
} from "../../threads/constants/codexProviderProfiles";

/**
 * Home / create-session 默认下一轮目标的 catalog 行投影。
 * 与 ModelOption / picker ModelInfo 字段对齐（仅消费 id / model / isDefault）。
 */
export type CreationTargetModelLike = {
  id: string;
  model?: string | null;
  isDefault?: boolean;
};

const LOCAL_PROFILE_IDS: Partial<Record<EngineType, string>> = {
  claude: CLAUDE_LOCAL_PROVIDER_PROFILE_ID,
  codex: CODEX_DISK_PROVIDER_PROFILE_ID,
  kimi: KIMI_LOCAL_PROVIDER_PROFILE_ID,
  grok: GROK_LOCAL_PROVIDER_PROFILE_ID,
  opencode: OPENCODE_LOCAL_PROVIDER_PROFILE_ID,
  pi: PI_LOCAL_PROVIDER_PROFILE_ID,
  dsh: DSH_LOCAL_PROVIDER_PROFILE_ID,
};

export type CreateSessionSupportedEngine = SharedSessionSupportedEngine | "dsh";

export type ResolvedCreationExecutionTarget = Omit<ExecutionTarget, "engine"> & {
  engine: CreateSessionSupportedEngine;
  modelCatalogEntryId: string;
  model: string;
  providerProfileNameSnapshot: string;
  providerProfileSource: NonNullable<ExecutionTarget["providerProfileSource"]>;
};

export function isCreateSessionSupportedEngine(
  engine: EngineType | null | undefined,
): engine is CreateSessionSupportedEngine {
  // qoder 已在 SharedSessionSupportedEngine 集合内（enable-qoder-shared-target）。
  return isSharedSessionSupportedEngine(engine) || engine === "dsh";
}

function hasResolvedCreationTargetIdentity(
  target: ExecutionTarget,
): boolean {
  const providerProfileId = target.providerProfileId?.trim() || null;
  const modelCatalogEntryId = target.modelCatalogEntryId?.trim() || "";
  const runtimeModel = target.model?.trim() || "";
  const providerName = target.providerProfileNameSnapshot?.trim() || "";
  if (!modelCatalogEntryId || !runtimeModel || !providerName) {
    return false;
  }
  return providerProfileId
    ? target.providerProfileSource === "managed"
    : target.providerProfileSource === "disk";
}

/**
 * Home / create-session 可落盘的完整目标。
 *
 * Shared 合同仍由 `isResolvedExecutionTarget` 守门（DSH fail-closed）。
 * 首页 Native 引擎包含 DSH：模型来自 host catalog，不是 Shared provider。
 */
export function isResolvedCreationExecutionTarget(
  target: ExecutionTarget | null | undefined,
): target is ResolvedCreationExecutionTarget {
  if (!target || !isCreateSessionSupportedEngine(target.engine)) {
    return false;
  }
  if (target.engine === "dsh" || target.engine === "qoder") {
    // DSH 与 Qoder 都使用 live runtime catalog；Qoder 也支持 Shared，
    // 但没有可安全使用的 static fallback roster。
    return hasResolvedCreationTargetIdentity(target);
  }
  return isResolvedExecutionTarget(target);
}

function resolveRuntimeModel(model: CreationTargetModelLike): string {
  return model.model?.trim() || model.id.trim() || "";
}

/**
 * 首页 create-session Atomic picker 的默认 ExecutionTarget。
 *
 * - 覆盖全部首页可创建引擎（Shared/Atomic + Native DSH），禁止仅 claude/codex。
 * - catalog 命中优先；未命中但有 selectedModelId 时用 id 合成 snapshot（闭合态可展示）。
 * - runtime 回落 id，避免只有 catalog entry 无 model 字段时假空。
 * - Shared 会话不得走此默认（enabled=false）。
 */
export function resolveDefaultCreationExecutionTarget(input: {
  enabled: boolean;
  selectedEngine: EngineType | null | undefined;
  selectedModelId: string | null | undefined;
  selectedEffort?: string | null;
  providerProfileId?: string | null;
  models: readonly CreationTargetModelLike[];
}): ExecutionTarget | null {
  if (!input.enabled) {
    return null;
  }
  const engine = input.selectedEngine;
  if (!isCreateSessionSupportedEngine(engine)) {
    return null;
  }

  const requestedId = input.selectedModelId?.trim() || "";
  const models = input.models;
  const matched =
    (requestedId
      ? (models.find((candidate) => candidate.id === requestedId) ??
        models.find(
          (candidate) => resolveRuntimeModel(candidate) === requestedId,
        ) ??
        null)
      : null) ??
    models.find((candidate) => candidate.isDefault) ??
    models[0] ??
    null;

  const modelCatalogEntryId = matched?.id.trim() || requestedId;
  const runtimeModel = matched
    ? resolveRuntimeModel(matched)
    : requestedId;
  if (!modelCatalogEntryId || !runtimeModel) {
    return null;
  }

  const rawProviderProfileId = input.providerProfileId?.trim() || null;
  const effort = input.selectedEffort?.trim() || "";
  if (engine === "qoder") {
    // Qoder Global/CN 是运行时分发身份，不是其他 Native engine 的本地 provider
    // sentinel。创建时必须固化为显式 profile，避免后续恢复时退化为 Generic Local。
    const providerProfileId =
      !rawProviderProfileId ||
      rawProviderProfileId === QODER_LOCAL_PROVIDER_PROFILE_ID
        ? QODER_GLOBAL_PROVIDER_PROFILE_ID
        : rawProviderProfileId;
    const isCn = providerProfileId === QODER_CN_PROVIDER_PROFILE_ID;

    return {
      engine,
      providerProfileId,
      modelCatalogEntryId,
      model: runtimeModel,
      reasoning: effort ? { effort } : null,
      providerProfileNameSnapshot: isCn
        ? QODER_CN_PROVIDER_PROFILE_NAME
        : QODER_GLOBAL_PROVIDER_PROFILE_NAME,
      providerProfileSource: "managed",
    };
  }

  const localProfileId = LOCAL_PROFILE_IDS[engine];
  const isLocal =
    !rawProviderProfileId || rawProviderProfileId === localProfileId;

  return {
    engine,
    providerProfileId: isLocal ? null : rawProviderProfileId,
    modelCatalogEntryId,
    model: runtimeModel,
    reasoning: effort ? { effort } : null,
    providerProfileNameSnapshot: isLocal
      ? LOCAL_PROVIDER_PROFILE_DISPLAY_NAME
      : rawProviderProfileId,
    providerProfileSource: isLocal ? "disk" : "managed",
  };
}
