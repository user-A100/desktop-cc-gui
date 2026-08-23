import {
  isSharedSessionSupportedEngine,
  type SharedSessionSupportedEngine,
} from "../utils/sharedSessionEngines";
import type { TurnExecutionSnapshot } from "../target/types";
import type { SharedRuntimeControlOwner } from "../../../types/interaction";
import type { EngineType } from "../../../types";
import {
  collectSharedHideIdentityKeys,
  sharedHideIdentityIntersects,
} from "./sharedHideIdentity";

export type SharedSessionNativeBinding = {
  workspaceId: string;
  sharedThreadId: string;
  nativeThreadId: string;
  engine: SharedSessionSupportedEngine;
  /** Runtime-owned durable attempt identity；仅用于同-attempt fallback。 */
  attemptId?: string;
  /** Durable worker Binding identity；用于 reload 前 fail-closed routing。 */
  bindingKey?: string;
  /** `conversation.turnRequested.target` 的 immutable runtime projection。 */
  executionTargetSnapshot?: TurnExecutionSnapshot;
  /** Wave 4 / B.5：Binding 归属的 Provider Profile；缺省/null 表示 default Provider 语义。 */
  providerProfileId?: string | null;
  registeredAtMs?: number;
};

type RuntimeSharedSessionNativeBinding = SharedSessionNativeBinding & {
  registeredAtMs: number;
};

const PENDING_BINDING_STALE_MS = 30_000;
const sharedBindingsByNativeKey = new Map<string, RuntimeSharedSessionNativeBinding>();

/** Provider 归一化：undefined/null/空白一律视为 default Provider 语义。 */
function normalizeBindingProviderProfileId(
  providerProfileId: string | null | undefined,
): string | null {
  const trimmed = providerProfileId?.trim();
  return trimmed ? trimmed : null;
}

function toBindingKey(binding: SharedSessionNativeBinding) {
  return JSON.stringify([
    binding.workspaceId,
    binding.engine,
    normalizeBindingProviderProfileId(binding.providerProfileId) ?? "default",
    binding.nativeThreadId,
  ]);
}

function nativeThreadIdsIntersect(left: string, right: string): boolean {
  const candidate = left.trim();
  const recorded = right.trim();
  if (!candidate || !recorded) {
    return false;
  }
  if (candidate === recorded) {
    return true;
  }
  return sharedHideIdentityIntersects(
    candidate,
    new Set(collectSharedHideIdentityKeys(recorded)),
  );
}

function findBindingsByNativeThread(
  workspaceId: string,
  nativeThreadId: string,
): Array<[string, RuntimeSharedSessionNativeBinding]> {
  return Array.from(sharedBindingsByNativeKey.entries()).filter(
    ([, binding]) =>
      binding.workspaceId === workspaceId &&
      nativeThreadIdsIntersect(nativeThreadId, binding.nativeThreadId),
  );
}

function toPublicBinding(
  binding: RuntimeSharedSessionNativeBinding | null | undefined,
): SharedSessionNativeBinding | null {
  if (!binding) {
    return null;
  }
  const { registeredAtMs: _registeredAtMs, ...publicBinding } = binding;
  return publicBinding;
}

export function registerSharedSessionNativeBinding(binding: SharedSessionNativeBinding) {
  const registeredAtMs =
    typeof binding.registeredAtMs === "number" && Number.isFinite(binding.registeredAtMs)
      ? binding.registeredAtMs
      : Date.now();
  const key = toBindingKey(binding);
  const existing = sharedBindingsByNativeKey.get(key);
  if (existing && existing.sharedThreadId !== binding.sharedThreadId) {
    return false;
  }
  sharedBindingsByNativeKey.set(key, {
    ...binding,
    registeredAtMs,
  });
  return true;
}

function isPendingSharedNativeThreadId(
  engine: SharedSessionSupportedEngine,
  nativeThreadId: string,
) {
  if (engine === "claude") {
    return nativeThreadId.startsWith("claude-pending-shared-");
  }
  return nativeThreadId.startsWith(`${engine}-pending-shared-`);
}

export function resolveSharedSessionBindingByNativeThread(
  workspaceId: string,
  nativeThreadId: string,
) {
  const matches = findBindingsByNativeThread(workspaceId, nativeThreadId);
  return matches.length === 1 ? toPublicBinding(matches[0][1]) : null;
}

export function hasPendingSharedSessionBindingForEngine(
  workspaceId: string,
  engine: SharedSessionSupportedEngine,
): boolean {
  const now = Date.now();
  for (const binding of sharedBindingsByNativeKey.values()) {
    if (binding.workspaceId !== workspaceId || binding.engine !== engine) {
      continue;
    }
    if (!isPendingSharedNativeThreadId(engine, binding.nativeThreadId)) {
      continue;
    }
    if (now - binding.registeredAtMs > PENDING_BINDING_STALE_MS) {
      continue;
    }
    return true;
  }
  return false;
}

export function isSharedOwnedNativeThreadId(
  workspaceId: string,
  nativeThreadId: string,
): boolean {
  const id = nativeThreadId.trim();
  if (!id || id.startsWith("shared:")) {
    return false;
  }
  if (id.includes("-pending-shared-")) {
    return true;
  }
  return resolveSharedSessionBindingByNativeThread(workspaceId, id) != null;
}

/**
 * Rust Runtime owner 在普通 UI fan-out 前附加的 authoritative Shared 路由。
 * 不依赖 frontend picker/RPC response 时序，因此首个 delta 也能直接进入 Shared 幕布。
 */
export function resolveSharedSessionBindingFromRuntimeOwner(
  workspaceId: string,
  params: Record<string, unknown>,
): SharedSessionNativeBinding | null {
  const rawOwner =
    params.sharedOwner && typeof params.sharedOwner === "object"
      ? (params.sharedOwner as Record<string, unknown>)
      : null;
  if (!rawOwner) {
    return null;
  }
  const sharedThreadId = String(rawOwner.sharedThreadId ?? "").trim();
  const nativeThreadId = String(
    rawOwner.nativeThreadId ??
      params.nativeThreadId ??
      params.native_thread_id ??
      "",
  ).trim();
  const engine = String(rawOwner.engine ?? "").trim().toLowerCase() as EngineType;
  if (
    !sharedThreadId.startsWith("shared:") ||
    !nativeThreadId ||
    !isSharedSessionSupportedEngine(engine)
  ) {
    return null;
  }
  const attemptId = String(rawOwner.attemptId ?? "").trim();
  const bindingKey = String(rawOwner.bindingKey ?? "").trim();
  const hasEmbeddedExecutionTarget =
    rawOwner.executionTargetSnapshot !== undefined &&
    rawOwner.executionTargetSnapshot !== null;
  const executionTargetSnapshot = readRuntimeExecutionTargetSnapshot(
    rawOwner.executionTargetSnapshot,
    engine,
  );
  if (hasEmbeddedExecutionTarget && !executionTargetSnapshot) {
    return null;
  }
  const ownerProviderProfileId =
    typeof rawOwner.providerProfileId === "string" &&
    rawOwner.providerProfileId.trim()
      ? rawOwner.providerProfileId.trim()
      : null;
  if (
    ownerProviderProfileId &&
    executionTargetSnapshot?.providerProfileId !== ownerProviderProfileId
  ) {
    return null;
  }
  const providerProfileId =
    ownerProviderProfileId ?? executionTargetSnapshot?.providerProfileId ?? null;
  return {
    workspaceId,
    sharedThreadId,
    nativeThreadId,
    engine,
    ...(attemptId ? { attemptId } : {}),
    ...(bindingKey ? { bindingKey } : {}),
    ...(executionTargetSnapshot ? { executionTargetSnapshot } : {}),
    ...(providerProfileId ? { providerProfileId } : {}),
  };
}

/**
 * Approval / requestUserInput 响应的 strict owner。
 *
 * Realtime projection 允许旧事件缺少 attempt snapshot；control response 不允许。
 * 缺少 attemptId、providerRuntimeKey 或完整 target 时返回 null，由入口 fail closed。
 */
export function resolveSharedRuntimeControlOwner(
  workspaceId: string,
  params: Record<string, unknown>,
): SharedRuntimeControlOwner | null {
  const rawOwner =
    params.sharedOwner && typeof params.sharedOwner === "object"
      ? (params.sharedOwner as Record<string, unknown>)
      : null;
  if (!rawOwner) {
    return null;
  }
  const binding = resolveSharedSessionBindingFromRuntimeOwner(
    workspaceId,
    params,
  );
  const attemptId = String(rawOwner.attemptId ?? "").trim();
  const providerRuntimeKey = String(rawOwner.providerRuntimeKey ?? "").trim();
  const runtimeTurnId = String(rawOwner.runtimeTurnId ?? "").trim();
  const projectedSharedThreadId = String(
    params.threadId ?? params.thread_id ?? "",
  ).trim();
  const projectedNativeThreadId = String(
    params.nativeThreadId ?? params.native_thread_id ?? "",
  ).trim();
  const projectedRuntimeTurnId = String(
    params.runtimeTurnId ??
      params.runtime_turn_id ??
      params.turnId ??
      params.turn_id ??
      "",
  ).trim();
  if (
    !binding?.attemptId ||
    binding.attemptId !== attemptId ||
    !binding.executionTargetSnapshot ||
    !providerRuntimeKey ||
    !runtimeTurnId ||
    projectedSharedThreadId !== binding.sharedThreadId ||
    projectedNativeThreadId !== binding.nativeThreadId ||
    projectedRuntimeTurnId !== runtimeTurnId
  ) {
    return null;
  }
  return Object.freeze({
    attemptId,
    providerRuntimeKey,
    sharedThreadId: binding.sharedThreadId,
    nativeThreadId: binding.nativeThreadId,
    runtimeTurnId,
    engine: binding.engine,
    providerProfileId:
      binding.executionTargetSnapshot.providerProfileId?.trim() || null,
  });
}

function readRuntimeExecutionTargetSnapshot(
  rawSnapshot: unknown,
  ownerEngine: SharedSessionSupportedEngine,
): TurnExecutionSnapshot | null {
  if (!rawSnapshot || typeof rawSnapshot !== "object") {
    return null;
  }
  const snapshot = rawSnapshot as Record<string, unknown>;
  if (snapshot.engine !== ownerEngine) {
    return null;
  }
  const providerProfileSource =
    snapshot.providerProfileSource === "local" ||
    snapshot.providerProfileSource === "managed"
      ? snapshot.providerProfileSource
      : null;
  const reasoningRecord =
    snapshot.reasoning && typeof snapshot.reasoning === "object"
      ? (snapshot.reasoning as Record<string, unknown>)
      : null;
  const reasoningEffort =
    typeof reasoningRecord?.effort === "string"
      ? reasoningRecord.effort.trim()
      : "";
  const optionalString = (value: unknown): string | null =>
    typeof value === "string" && value.trim() ? value : null;
  const providerProfileId = optionalString(snapshot.providerProfileId);
  const modelCatalogEntryId = optionalString(snapshot.modelCatalogEntryId);
  const model = optionalString(snapshot.model);
  const providerProfileNameSnapshot = optionalString(
    snapshot.providerProfileNameSnapshot,
  );
  if (
    !providerProfileSource ||
    !modelCatalogEntryId ||
    !model ||
    !providerProfileNameSnapshot ||
    (providerProfileId
      ? providerProfileSource !== "managed"
      : providerProfileSource !== "local")
  ) {
    return null;
  }
  const immutableReasoning = reasoningEffort
    ? Object.freeze({ effort: reasoningEffort })
    : null;
  return Object.freeze({
    engine: ownerEngine,
    providerProfileId,
    modelCatalogEntryId,
    model,
    reasoning: immutableReasoning,
    providerProfileNameSnapshot,
    providerProfileSource,
    runtimeCapabilityFingerprint: optionalString(
      snapshot.runtimeCapabilityFingerprint,
    ),
  });
}

export function resolvePendingSharedSessionBindingForEngine(
  workspaceId: string,
  engine: SharedSessionSupportedEngine,
) {
  const matches: RuntimeSharedSessionNativeBinding[] = [];
  const now = Date.now();
  sharedBindingsByNativeKey.forEach((binding) => {
    if (binding.workspaceId !== workspaceId || binding.engine !== engine) {
      return;
    }
    if (isPendingSharedNativeThreadId(engine, binding.nativeThreadId)) {
      if (now - binding.registeredAtMs > PENDING_BINDING_STALE_MS) {
        return;
      }
      matches.push(binding);
    }
  });
  if (matches.length !== 1) {
    return null;
  }
  return toPublicBinding(matches[0]);
}

/**
 * Wave 4 / B.5：Target 级 pending 解析（engine + providerProfileId）。
 * 与 engine-only 版本同样的「唯一匹配才返回」fail-closed 规则，
 * 但匹配维度收窄到 Execution Target，同 engine 双 Provider 并行时互不串线。
 */
export function resolvePendingSharedSessionBindingForTarget(
  workspaceId: string,
  engine: SharedSessionSupportedEngine,
  providerProfileId?: string | null,
) {
  const targetProvider = normalizeBindingProviderProfileId(providerProfileId);
  const matches: RuntimeSharedSessionNativeBinding[] = [];
  const now = Date.now();
  sharedBindingsByNativeKey.forEach((binding) => {
    if (binding.workspaceId !== workspaceId || binding.engine !== engine) {
      return;
    }
    if (
      normalizeBindingProviderProfileId(binding.providerProfileId) !== targetProvider
    ) {
      return;
    }
    if (isPendingSharedNativeThreadId(engine, binding.nativeThreadId)) {
      if (now - binding.registeredAtMs > PENDING_BINDING_STALE_MS) {
        return;
      }
      matches.push(binding);
    }
  });
  if (matches.length !== 1) {
    return null;
  }
  return toPublicBinding(matches[0]);
}

export function rebindSharedSessionNativeThread(params: {
  workspaceId: string;
  oldNativeThreadId: string;
  newNativeThreadId: string;
}) {
  const matches = findBindingsByNativeThread(
    params.workspaceId,
    params.oldNativeThreadId,
  );
  if (matches.length !== 1) {
    return null;
  }
  const [oldKey, existing] = matches[0];
  sharedBindingsByNativeKey.delete(oldKey);
  const next = {
    ...existing,
    nativeThreadId: params.newNativeThreadId,
    registeredAtMs: Date.now(),
  };
  const nextKey = toBindingKey(next);
  const conflicting = sharedBindingsByNativeKey.get(nextKey);
  if (conflicting && conflicting.sharedThreadId !== next.sharedThreadId) {
    sharedBindingsByNativeKey.set(oldKey, existing);
    return null;
  }
  sharedBindingsByNativeKey.set(nextKey, next);
  return toPublicBinding(next);
}

export function clearSharedSessionBindingsForSharedThread(
  workspaceId: string,
  sharedThreadId: string,
) {
  const keysToDelete: string[] = [];
  sharedBindingsByNativeKey.forEach((binding, key) => {
    if (binding.workspaceId === workspaceId && binding.sharedThreadId === sharedThreadId) {
      keysToDelete.push(key);
    }
  });
  keysToDelete.forEach((key) => {
    sharedBindingsByNativeKey.delete(key);
  });
}
