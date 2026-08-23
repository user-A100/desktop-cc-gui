import {
  QODER_CN_PROVIDER_PROFILE_ID,
  QODER_GLOBAL_PROVIDER_PROFILE_ID,
  QODER_LOCAL_PROVIDER_PROFILE_ID,
} from "../constants/codexProviderProfiles";

export const QODER_NATIVE_SESSION_PREFIX = "qoder:";

export type QoderProviderProfileId =
  | typeof QODER_GLOBAL_PROVIDER_PROFILE_ID
  | typeof QODER_CN_PROVIDER_PROFILE_ID;

export type QoderSessionIdentity = {
  providerProfileId: QoderProviderProfileId;
  rawSessionId: string;
  isLegacy: boolean;
};

function preservesLegacyGlobalAliases(
  providerProfileId?: string | null,
): boolean {
  const normalized = providerProfileId?.trim() || "";
  return !normalized || normalized === QODER_LOCAL_PROVIDER_PROFILE_ID;
}

/**
 * Qoder Global/CN 的 raw ACP session id 只在 distribution 内唯一。
 * `null` / historic local sentinel 兼容为 Global；未知值必须 fail closed。
 */
export function canonicalQoderProviderProfileId(
  providerProfileId?: string | null,
): QoderProviderProfileId | null {
  const normalized = providerProfileId?.trim() || "";
  if (
    !normalized ||
    normalized === QODER_LOCAL_PROVIDER_PROFILE_ID ||
    normalized === QODER_GLOBAL_PROVIDER_PROFILE_ID
  ) {
    return QODER_GLOBAL_PROVIDER_PROFILE_ID;
  }
  if (normalized === QODER_CN_PROVIDER_PROFILE_ID) {
    return QODER_CN_PROVIDER_PROFILE_ID;
  }
  return null;
}

/**
 * 解析 UI / catalog / Shared durable identity。
 * 新格式为 `qoder:<profile>:<raw>`；历史 `qoder:<raw>` 与 raw 值保留 Global
 * 兼容，或使用调用方传入的 durable provider owner。
 */
export function parseQoderSessionIdentity(
  value: string | null | undefined,
  providerProfileId?: string | null,
): QoderSessionIdentity | null {
  const trimmed = value?.trim() || "";
  if (!trimmed) {
    return null;
  }
  const withoutEnginePrefix = trimmed
    .toLowerCase()
    .startsWith(QODER_NATIVE_SESSION_PREFIX)
    ? trimmed.slice(QODER_NATIVE_SESSION_PREFIX.length).trim()
    : trimmed;
  if (!withoutEnginePrefix) {
    return null;
  }

  for (const profileId of [
    QODER_GLOBAL_PROVIDER_PROFILE_ID,
    QODER_CN_PROVIDER_PROFILE_ID,
  ] as const) {
    const profilePrefix = `${profileId}:`;
    if (!withoutEnginePrefix.startsWith(profilePrefix)) {
      continue;
    }
    const rawSessionId = withoutEnginePrefix.slice(profilePrefix.length).trim();
    const expectedProfileId = canonicalQoderProviderProfileId(providerProfileId);
    if (
      !rawSessionId ||
      (!preservesLegacyGlobalAliases(providerProfileId) &&
        expectedProfileId !== profileId)
    ) {
      return null;
    }
    return { providerProfileId: profileId, rawSessionId, isLegacy: false };
  }

  // `qoder:__qoder_future__:raw` must not be reinterpreted as a Global raw id.
  if (
    withoutEnginePrefix.startsWith("__qoder_") &&
    withoutEnginePrefix.includes(":")
  ) {
    return null;
  }
  const resolvedProviderProfileId = canonicalQoderProviderProfileId(providerProfileId);
  if (!resolvedProviderProfileId) {
    return null;
  }
  return {
    providerProfileId: resolvedProviderProfileId,
    rawSessionId: withoutEnginePrefix,
    isLegacy: true,
  };
}

export function canonicalQoderThreadId(
  value: string | null | undefined,
  providerProfileId?: string | null,
): string | null {
  const identity = parseQoderSessionIdentity(value, providerProfileId);
  return identity
    ? `${QODER_NATIVE_SESSION_PREFIX}${identity.providerProfileId}:${identity.rawSessionId}`
    : null;
}

/**
 * 新 canonical identity 只匹配自身；仅历史 id 才额外保留 raw alias，避免
 * Global/CN 相同 raw session id 被 Shared hide / owner lookup 交叉命中。
 */
export function collectQoderSessionIdentityKeys(
  value: string | null | undefined,
  providerProfileId?: string | null,
): string[] {
  const identity = parseQoderSessionIdentity(value, providerProfileId);
  if (!identity) {
    return [];
  }
  const canonicalId = `${QODER_NATIVE_SESSION_PREFIX}${identity.providerProfileId}:${identity.rawSessionId}`;
  return identity.isLegacy && preservesLegacyGlobalAliases(providerProfileId)
    ? [canonicalId, `${QODER_NATIVE_SESSION_PREFIX}${identity.rawSessionId}`, identity.rawSessionId]
    : [canonicalId];
}
