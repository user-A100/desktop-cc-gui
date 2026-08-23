import type { Dispatch, MutableRefObject } from "react";

import type { AutoSessionMetadata } from "../../../services/tauri";
import { pushGlobalRuntimeNotice } from "../../../services/globalRuntimeNotices";
import { previewThreadName } from "../../../utils/threadItems";
import {
  CLAUDE_LOCAL_PROVIDER_PROFILE_ID,
  CODEX_DISK_PROVIDER_PROFILE_ID,
  DSH_LOCAL_PROVIDER_PROFILE_ID,
  GROK_LOCAL_PROVIDER_PROFILE_ID,
  KIMI_LOCAL_PROVIDER_PROFILE_ID,
  LOCAL_PROVIDER_PROFILE_DISPLAY_NAME,
  OPENCODE_LOCAL_PROVIDER_PROFILE_ID,
  PI_LOCAL_PROVIDER_PROFILE_ID,
  QODER_GLOBAL_PROVIDER_PROFILE_ID,
  QODER_GLOBAL_PROVIDER_PROFILE_NAME,
  QODER_LOCAL_PROVIDER_PROFILE_ID,
  type EngineProviderProfileOption,
} from "../constants/codexProviderProfiles";
import type { ThreadAction, ThreadState } from "./useThreadsReducer";

const HOOK_SAFE_FALLBACK_METADATA_KEY = "ccguiHookSafeFallback";

export type ProviderProfileSelection = {
  providerProfileId?: string | null;
  providerProfileSource?: string | null;
  providerProfileName?: string | null;
  providerAvailability?: string | null;
};

export type SessionLifecycleThreadStarter = {
  dispatch: Dispatch<ThreadAction>;
  loadedThreadsRef: MutableRefObject<Record<string, boolean>>;
  workspaceId: string;
  folderId: string | null;
  shouldActivate: boolean;
  autoSessionPayload?: { autoSession?: AutoSessionMetadata | null };
  selectedProviderBinding: ProviderProfileSelection;
};

export function buildClaudeForkThreadId(parentSessionId: string) {
  return `claude-fork:${parentSessionId}:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function addForkThreadNamePrefix(name: string) {
  const normalized = name.trim();
  if (!normalized) {
    return "fork-Claude Session";
  }
  return normalized.startsWith("fork-") ? normalized : `fork-${normalized}`;
}

export function resolveClaudeForkThreadName({
  workspaceId,
  parentThreadId,
  threadsByWorkspace,
  itemsByThread,
}: {
  workspaceId: string;
  parentThreadId: string;
  threadsByWorkspace: ThreadState["threadsByWorkspace"];
  itemsByThread: ThreadState["itemsByThread"];
}) {
  const parentSummaryName =
    threadsByWorkspace[workspaceId]
      ?.find((thread) => thread.id === parentThreadId)
      ?.name
      .trim() ?? "";
  const parentUserMessage = (itemsByThread[parentThreadId] ?? []).find(
    (item) => item.kind === "message" && item.role === "user",
  );
  const parentMessageName = parentUserMessage
    && parentUserMessage.kind === "message"
    && parentUserMessage.role === "user"
    ? previewThreadName(parentUserMessage.text, "")
    : "";
  return addForkThreadNamePrefix(
    parentSummaryName || parentMessageName || "Claude Session",
  );
}

export function extractThreadId(response: Record<string, unknown> | null | undefined) {
  if (!response || typeof response !== "object") {
    return "";
  }
  const responseRecord = response as Record<string, unknown>;
  const result =
    responseRecord.result && typeof responseRecord.result === "object"
      ? (responseRecord.result as Record<string, unknown>)
      : null;
  const resultThread =
    result?.thread && typeof result.thread === "object"
      ? (result.thread as Record<string, unknown>)
      : null;
  const rootThread =
    responseRecord.thread && typeof responseRecord.thread === "object"
      ? (responseRecord.thread as Record<string, unknown>)
      : null;

  const candidates = [
    resultThread?.id,
    result?.threadId,
    result?.thread_id,
    rootThread?.id,
    responseRecord.threadId,
    responseRecord.thread_id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" || typeof candidate === "number") {
      const normalized = String(candidate).trim();
      if (normalized) {
        return normalized;
      }
    }
  }
  return "";
}

function normalizeResponseString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function extractStartedThreadRecord(
  response: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!response || typeof response !== "object") {
    return null;
  }
  const result =
    response.result && typeof response.result === "object"
      ? (response.result as Record<string, unknown>)
      : null;
  const resultThread =
    result?.thread && typeof result.thread === "object"
      ? (result.thread as Record<string, unknown>)
      : null;
  const rootThread =
    response.thread && typeof response.thread === "object"
      ? (response.thread as Record<string, unknown>)
      : null;
  return resultThread ?? rootThread;
}

export function extractProviderBindingFromStartedThread(
  response: Record<string, unknown> | null | undefined,
  fallbackProviderBinding: ProviderProfileSelection,
) {
  const thread = extractStartedThreadRecord(response);
  const sourceLabel = normalizeResponseString(thread?.sourceLabel ?? thread?.source_label);
  const providerProfileId =
    normalizeResponseString(
      thread?.providerProfileId ?? thread?.provider_profile_id,
    ) ?? normalizeResponseString(fallbackProviderBinding.providerProfileId);
  const providerProfileSource =
    normalizeResponseString(
      thread?.providerProfileSource ?? thread?.provider_profile_source,
    ) ?? normalizeResponseString(fallbackProviderBinding.providerProfileSource);
  const providerProfileName =
    normalizeResponseString(
      thread?.providerProfileName ?? thread?.provider_profile_name,
    ) ?? normalizeResponseString(fallbackProviderBinding.providerProfileName);
  const providerAvailability = normalizeResponseString(
    thread?.providerAvailability ?? thread?.provider_availability,
  ) ?? normalizeResponseString(fallbackProviderBinding.providerAvailability);
  return {
    ...(sourceLabel ? { sourceLabel } : {}),
    ...(providerProfileId ? { providerProfileId } : {}),
    ...(providerProfileSource ? { providerProfileSource } : {}),
    ...(providerProfileName ? { providerProfileName } : {}),
    ...(providerAvailability ? { providerAvailability } : {}),
  };
}

const LOCAL_PROVIDER_PROFILE_IDS = new Set([
  CLAUDE_LOCAL_PROVIDER_PROFILE_ID,
  CODEX_DISK_PROVIDER_PROFILE_ID,
  KIMI_LOCAL_PROVIDER_PROFILE_ID,
  GROK_LOCAL_PROVIDER_PROFILE_ID,
  OPENCODE_LOCAL_PROVIDER_PROFILE_ID,
  PI_LOCAL_PROVIDER_PROFILE_ID,
  DSH_LOCAL_PROVIDER_PROFILE_ID,
  QODER_LOCAL_PROVIDER_PROFILE_ID,
]);

export function isManagedEngineProviderProfileId(
  providerProfileId: string | null | undefined,
): providerProfileId is string {
  const normalized = providerProfileId?.trim() ?? "";
  return normalized.length > 0 && !LOCAL_PROVIDER_PROFILE_IDS.has(normalized);
}

export function localProviderBindingForEngine(
  engine: string | null | undefined,
): ProviderProfileSelection {
  const localId =
    engine === "claude"
      ? CLAUDE_LOCAL_PROVIDER_PROFILE_ID
      : engine === "codex"
        ? CODEX_DISK_PROVIDER_PROFILE_ID
        : engine === "kimi"
          ? KIMI_LOCAL_PROVIDER_PROFILE_ID
          : engine === "grok"
            ? GROK_LOCAL_PROVIDER_PROFILE_ID
            : engine === "opencode"
              ? OPENCODE_LOCAL_PROVIDER_PROFILE_ID
              : engine === "pi"
                ? PI_LOCAL_PROVIDER_PROFILE_ID
                : engine === "dsh"
                  ? DSH_LOCAL_PROVIDER_PROFILE_ID
                  : engine === "qoder"
                    ? QODER_GLOBAL_PROVIDER_PROFILE_ID
                    : null;
  if (!localId) {
    return {};
  }
  if (engine === "qoder") {
    return {
      providerProfileId: QODER_GLOBAL_PROVIDER_PROFILE_ID,
      providerProfileName: QODER_GLOBAL_PROVIDER_PROFILE_NAME,
      providerProfileSource: "managed",
      providerAvailability: "available",
    };
  }
  return {
    providerProfileId: localId,
    providerProfileName: LOCAL_PROVIDER_PROFILE_DISPLAY_NAME,
    providerProfileSource: "disk",
    providerAvailability: "available",
  };
}

export function resolveSendProviderProfileId(input: {
  threadProviderProfileId?: string | null;
  composerProviderProfileId?: string | null;
}): string | null {
  const threadId = input.threadProviderProfileId?.trim() || null;
  if (isManagedEngineProviderProfileId(threadId)) {
    return threadId;
  }
  if (threadId) {
    return null;
  }
  const composerId = input.composerProviderProfileId?.trim() || null;
  return isManagedEngineProviderProfileId(composerId) ? composerId : null;
}

export function providerBindingFromSelectedProfile(
  providerProfile?: EngineProviderProfileOption | null,
  fallbackProviderProfileId?: string | null,
): ProviderProfileSelection {
  const selectedProfileId = normalizeResponseString(providerProfile?.id);
  const providerProfileId =
    selectedProfileId ?? normalizeResponseString(fallbackProviderProfileId);
  if (!providerProfileId) {
    return {};
  }
  if (LOCAL_PROVIDER_PROFILE_IDS.has(providerProfileId)) {
    return {
      providerProfileId,
      providerProfileName:
        normalizeResponseString(providerProfile?.name) ??
        LOCAL_PROVIDER_PROFILE_DISPLAY_NAME,
      providerProfileSource: "disk",
      providerAvailability: "available",
    };
  }
  const providerProfileSource = selectedProfileId
    ? normalizeResponseString(providerProfile?.source)
    : null;
  const providerProfileName = selectedProfileId
    ? normalizeResponseString(providerProfile?.name)
    : null;
  return {
    providerProfileId,
    ...(providerProfileSource ? { providerProfileSource } : {}),
    ...(providerProfileName ? { providerProfileName } : {}),
    ...(selectedProfileId ? { providerAvailability: "available" } : {}),
  };
}

export function extractHookSafeFallbackMetadata(
  response: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!response || typeof response !== "object") {
    return null;
  }
  const metadata = response[HOOK_SAFE_FALLBACK_METADATA_KEY];
  return metadata && typeof metadata === "object"
    ? (metadata as Record<string, unknown>)
    : null;
}

export function pushHookSafeFallbackNotice(
  workspaceId: string,
  metadata: Record<string, unknown>,
) {
  const reason =
    typeof metadata.reason === "string" && metadata.reason.trim()
      ? metadata.reason.trim()
      : "sessionstart_hook_failure";
  const primaryFailureSummary =
    typeof metadata.primaryFailureSummary === "string"
      ? metadata.primaryFailureSummary.trim()
      : "";
  pushGlobalRuntimeNotice({
    severity: "warning",
    category: "runtime",
    messageKey: "runtimeNotice.runtime.codexSessionStartHookSkipped",
    messageParams: {
      reason,
      detail: primaryFailureSummary || null,
    },
    dedupeKey: `codex-sessionstart-hook-safe-fallback:${workspaceId}:${reason}`,
  });
}

export function createSessionLifecycleThreadStarter({
  dispatch,
  loadedThreadsRef,
  workspaceId,
  folderId,
  shouldActivate,
  autoSessionPayload = {},
  selectedProviderBinding,
}: SessionLifecycleThreadStarter) {
  return (response: Record<string, unknown> | null | undefined) => {
    const threadId = extractThreadId(response);
    if (!threadId) {
      return null;
    }
    const fallbackMetadata = extractHookSafeFallbackMetadata(response);
    if (fallbackMetadata) {
      pushHookSafeFallbackNotice(workspaceId, fallbackMetadata);
    }
    dispatch({
      type: "ensureThread",
      workspaceId,
      threadId,
      engine: "codex",
      ...(folderId ? { folderId } : {}),
      ...autoSessionPayload,
      ...extractProviderBindingFromStartedThread(response, selectedProviderBinding),
    });
    dispatch({
      type: "markCodexAcceptedTurn",
      threadId,
      fact: "empty-draft",
      source: "thread-start",
      timestamp: Date.now(),
    });
    if (shouldActivate) {
      dispatch({ type: "setActiveThreadId", workspaceId, threadId });
    }
    loadedThreadsRef.current[threadId] = true;
    return threadId;
  };
}
