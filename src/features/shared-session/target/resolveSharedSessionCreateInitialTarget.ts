import {
  getClaudeProviders,
  getCodexProviders,
  getEngineModels,
  getGrokProviders,
  getKimiProviders,
  getOpenCodeProviders,
} from "../../../services/tauri";
import type { EngineModelInfo } from "../../../types";
import { syncClaudeModelMappingForProfile } from "../../vendors/activateEngineProviderProfile";
import {
  LOCAL_PROVIDER_PROFILE_DISPLAY_NAME,
  QODER_CN_PROVIDER_PROFILE_ID,
  QODER_CN_PROVIDER_PROFILE_NAME,
  QODER_GLOBAL_PROVIDER_PROFILE_ID,
  QODER_GLOBAL_PROVIDER_PROFILE_NAME,
} from "../../threads/constants/codexProviderProfiles";
import type { SharedSessionSupportedEngine } from "../utils/sharedSessionEngines";

import {
  buildSharedSessionInitialTarget,
  isSharedCreateLocalProvider,
  localProviderSentinelId,
  type SharedCreateProviderProfile,
} from "./initialTarget";
import type { ExecutionTarget } from "./types";

type ProviderListEntry = {
  id: string;
  name: string;
  isLocalProvider?: boolean | null;
};

/**
 * 加载某 CLI 有序 Provider 列表（与 Atomic picker / vendor_get_* 顺序一致）。
 * 列表为空时回落本地 sentinel，保证创建路径可 fail-closed 到 catalog 而非无 profile。
 */
export async function loadOrderedSharedCreateProviders(
  engine: SharedSessionSupportedEngine,
): Promise<ProviderListEntry[]> {
  let raw: ProviderListEntry[] = [];
  switch (engine) {
    case "claude":
      raw = (await getClaudeProviders()).map((entry) => ({
        id: entry.id,
        name: entry.name,
        isLocalProvider: entry.isLocalProvider,
      }));
      break;
    case "codex":
      raw = (await getCodexProviders()).map((entry) => ({
        id: entry.id,
        name: entry.name,
        // Codex 列表无 isLocalProvider 字段；本地靠 __disk__ sentinel 判定。
        isLocalProvider: undefined,
      }));
      break;
    case "kimi":
      raw = (await getKimiProviders()).map((entry) => ({
        id: entry.id,
        name: entry.name,
        isLocalProvider: entry.isLocalProvider,
      }));
      break;
    case "grok":
      raw = (await getGrokProviders()).map((entry) => ({
        id: entry.id,
        name: entry.name,
        isLocalProvider: entry.isLocalProvider,
      }));
      break;
    case "opencode":
      raw = (await getOpenCodeProviders()).map((entry) => ({
        id: entry.id,
        name: entry.name,
        isLocalProvider: entry.isLocalProvider,
      }));
      break;
    case "pi":
      // PI 无多 Provider store：不拉 vendor 列表，落到本地 sentinel。
      break;
    case "qoder":
      // Qoder 没有 provider CRUD。两个 distribution 仍复用 scoped catalog，
      // 但必须带显式 profile，不能伪装成 local disk provider。
      return [
        {
          id: QODER_GLOBAL_PROVIDER_PROFILE_ID,
          name: QODER_GLOBAL_PROVIDER_PROFILE_NAME,
          isLocalProvider: false,
        },
        {
          id: QODER_CN_PROVIDER_PROFILE_ID,
          name: QODER_CN_PROVIDER_PROFILE_NAME,
          isLocalProvider: false,
        },
      ];
  }

  const normalized = raw
    .map((entry) => ({
      id: entry.id.trim(),
      name: entry.name.trim() || entry.id.trim(),
      isLocalProvider: Boolean(entry.isLocalProvider),
    }))
    .filter((entry) => entry.id.length > 0);

  if (normalized.length === 0) {
    const localId = localProviderSentinelId(engine);
    return [
      {
        id: localId,
        name: LOCAL_PROVIDER_PROFILE_DISPLAY_NAME,
        isLocalProvider: true,
      },
    ];
  }

  return normalized;
}

export function resolveFirstSharedCreateProvider(
  engine: SharedSessionSupportedEngine,
  providers: ProviderListEntry[],
  localProviderName: string,
): SharedCreateProviderProfile {
  const first = providers[0];
  if (!first?.id.trim()) {
    // Qoder 的固定 distribution 不可退化为 generic local sentinel；否则后续
    // buildSharedSessionInitialTarget 会把 Global binding 归一为 null。
    if (engine === "qoder") {
      return {
        id: QODER_GLOBAL_PROVIDER_PROFILE_ID,
        name: QODER_GLOBAL_PROVIDER_PROFILE_NAME,
        source: "managed",
      };
    }
    const localId = localProviderSentinelId(engine);
    return {
      id: localId,
      name: localProviderName.trim() || LOCAL_PROVIDER_PROFILE_DISPLAY_NAME,
      source: "disk",
    };
  }

  const id = first.id.trim();
  const isLocal =
    Boolean(first.isLocalProvider) || isSharedCreateLocalProvider(engine, id);
  return {
    id,
    name: isLocal
      ? localProviderName.trim() ||
        first.name.trim() ||
        LOCAL_PROVIDER_PROFILE_DISPLAY_NAME
      : first.name.trim() || id,
    source: isLocal ? "disk" : "managed",
  };
}

/**
 * 按 profile 权威加载模型：
 * - 本地：sentinel id + forceRefresh（重读 settings，禁止 engine status 过期 cache）
 * - managed：providerProfileId（backend provider-scoped）
 */
export async function loadAuthoritativeModelsForCreateProvider(
  engine: SharedSessionSupportedEngine,
  provider: SharedCreateProviderProfile,
): Promise<EngineModelInfo[]> {
  const isLocal = provider.source === "disk";
  return getEngineModels(engine, {
    providerProfileId: provider.id,
    ...(isLocal ? { forceRefresh: true } : {}),
  });
}

/**
 * Shared CLI 创建入口：第一 Provider + 权威 catalog → 完整 initialTarget。
 *
 * **仅用于新建会话**。打开既有 Shared Session 不得调用本函数 reseed。
 */
export async function resolveSharedSessionCreateInitialTarget(input: {
  engine: SharedSessionSupportedEngine;
  localProviderName: string;
  unavailableModelMessage: string;
}): Promise<ExecutionTarget> {
  const providers = await loadOrderedSharedCreateProviders(input.engine);
  const provider = resolveFirstSharedCreateProvider(
    input.engine,
    providers,
    input.localProviderName,
  );

  if (input.engine === "claude") {
    try {
      await syncClaudeModelMappingForProfile(provider.id);
    } catch {
      // mapping 失败不阻断创建（与 Atomic 渠道切换一致）
    }
  }

  const models = await loadAuthoritativeModelsForCreateProvider(
    input.engine,
    provider,
  );

  return buildSharedSessionInitialTarget({
    engine: input.engine,
    models,
    provider,
    unavailableModelMessage: input.unavailableModelMessage,
  });
}
