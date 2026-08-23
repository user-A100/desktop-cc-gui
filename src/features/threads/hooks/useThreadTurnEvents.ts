import { useCallback } from "react";
import type { Dispatch, MutableRefObject } from "react";
import {
  workspaceScopedDelete,
  workspaceScopedGet,
  workspaceScopedHas,
  workspaceScopedSet,
  type WorkspaceScopedMap,
} from "./workspaceScopedMap";
import type { DebugEntry } from "../../../types";
import { useTranslation } from "react-i18next";
import {
  engineInterrupt as engineInterruptService,
  engineInterruptTurn as engineInterruptTurnService,
  interruptTurn as interruptTurnService,
} from "../../../services/tauri";
import { pushThreadFailureRuntimeNotice } from "../../../services/globalRuntimeNotices";
import { getThreadTimestamp } from "../../../utils/threadItems";
import {
  isClaudeForkThreadId,
  isClaudeSessionBootstrapThreadId,
} from "../utils/claudeForkThread";
import {
  asString,
  normalizeDshSessionStats,
  normalizeDshTodos,
  normalizePlanUpdate,
  normalizeRateLimits,
  normalizeTokenUsage,
} from "../utils/threadNormalize";
import { previewThreadName } from "../../../utils/threadItems";
import { resolveThreadStabilityDiagnostic } from "../utils/stabilityDiagnostics";
import type { TurnExecutionSnapshot } from "../../shared-session/target/types";
import { renameRuntimeReceipt } from "../utils/runtimeModelReceipt";
import { noteSharedProviderRetryTurnSettled } from "../../shared-session/provider-retry/noteSharedProviderRetryTurn";
import { getSharedTargetState } from "../../shared-session/target/targetStore";
import { isSharedSessionThreadId } from "../../shared-session/utils/sharedSessionIdentity";
import { isSharedOwnedNativeThreadId } from "../../shared-session/runtime/sharedSessionBridge";
import type { EngineType } from "../../../types";
import {
  hasCodexBackgroundHelperPreview,
  hasCommitMessageHelperPreview,
} from "../utils/codexBackgroundHelpers";
import { isCodexPrewarmThreadStart } from "../utils/codexPendingPrewarm";
import {
  clearLiveAssistantText,
  peekLiveAssistantText,
  renameLiveAssistantTextThread,
} from "../utils/liveAssistantTextChannel";
import { renameLiveItemDeltaThread } from "../utils/liveItemDeltaChannel";
import { resolveCodexSubagentIdentity } from "../utils/codexSubagentIdentity";
import {
  inferEngineFromLegacyThreadId,
  isPendingSessionForEngine,
} from "../contracts/engineRuntimeIdentity";
import type { ThreadAction } from "./useThreadsReducer";
import {
  canonicalQoderProviderProfileId,
  canonicalQoderThreadId,
  parseQoderSessionIdentity,
} from "../utils/qoderSessionIdentity";

/**
 * Infer engine type from thread ID.
 * Claude/Gemini/Kimi/OpenCode threads use "<engine>:" or "<engine>-pending-" prefixes.
 */
const inferEngineFromThreadId = inferEngineFromLegacyThreadId;

function resolveQoderProviderProfileIdForThread(
  getThreadProviderProfileId: UseThreadTurnEventsOptions["getThreadProviderProfileId"],
  workspaceId: string,
  threadId: string,
): string | null {
  const storedProfileId =
    getThreadProviderProfileId?.(workspaceId, threadId) ?? null;
  if (threadId.startsWith("qoder:")) {
    return parseQoderSessionIdentity(threadId, storedProfileId)?.providerProfileId ?? null;
  }
  return canonicalQoderProviderProfileId(storedProfileId);
}

function noteSharedRetryFromTurn(
  workspaceId: string,
  threadId: string,
  input: {
    outcome: "completed" | "failed" | "cancelled";
    message?: string | null;
    wasLocalInterrupt?: boolean;
    snapshot?: TurnExecutionSnapshot | null;
    attemptId?: string | null;
  },
): void {
  if (!isSharedSessionThreadId(threadId)) {
    return;
  }
  const stored = getSharedTargetState(workspaceId, threadId);
  const snapshot = input.snapshot ?? stored.activeTurnTarget ?? stored.selectedNextTarget;
  noteSharedProviderRetryTurnSettled({
    workspaceId,
    threadId,
    engine: (snapshot?.engine ?? inferEngineFromThreadId(threadId)) as EngineType,
    providerProfileId: snapshot?.providerProfileId ?? null,
    model: snapshot?.model ?? null,
    attemptId: input.attemptId ?? null,
    outcome: input.outcome,
    message: input.message ?? null,
    wasLocalInterrupt: input.wasLocalInterrupt ?? false,
  });
}

/**
 * Terminal 路径（完成/失败/稳定性诊断）在 markProcessing(false) 前必须把
 * live 通道全文写入 durable item，否则 UI 只剩建壳首字。
 */
function settleLiveAssistantFullText(
  dispatch: Dispatch<ThreadAction>,
  workspaceId: string,
  threadId: string,
): void {
  const liveEntry = peekLiveAssistantText(threadId);
  if (!liveEntry?.text) {
    return;
  }
  dispatch({
    type: "completeAgentMessage",
    workspaceId,
    threadId,
    itemId: liveEntry.itemId,
    text: liveEntry.text,
    hasCustomName: true,
    timestamp: Date.now(),
  });
  clearLiveAssistantText(threadId);
}

type ContextCompactionSourcePayload = {
  auto?: boolean | null;
  manual?: boolean | null;
};

function resolveCompactionSource(
  payload?: ContextCompactionSourcePayload,
): "auto" | "manual" | null | undefined {
  if (!payload) {
    return undefined;
  }
  if (payload.manual === true) {
    return "manual";
  }
  if (payload.auto === true) {
    return "auto";
  }
  return undefined;
}

function isCodexContextCompaction(threadId: string): boolean {
  if (inferEngineFromThreadId(threadId) !== "codex") {
    return false;
  }
  return true;
}

function buildCodexCompactionCompletionFallbackId(threadId: string, turnId: string) {
  return `context-compacted-codex-compact-${threadId}-completed-${turnId}`;
}

function isBackgroundHelperThread(
  threadId: string,
  thread: Record<string, unknown>,
): boolean {
  const previewCandidates = [
    asString(thread.preview).trim(),
    asString(thread.title).trim(),
    asString(thread.name).trim(),
  ].filter(Boolean);
  if (hasCommitMessageHelperPreview(previewCandidates)) {
    return true;
  }
  return (
    inferEngineFromThreadId(threadId) === "codex" &&
    hasCodexBackgroundHelperPreview(previewCandidates)
  );
}

function normalizeThreadProviderMetadataString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function extractThreadProviderMetadata(thread: Record<string, unknown>) {
  const sourceLabel = normalizeThreadProviderMetadataString(
    thread.sourceLabel ?? thread.source_label,
  );
  const providerProfileId = normalizeThreadProviderMetadataString(
    thread.providerProfileId ?? thread.provider_profile_id,
  );
  const providerProfileSource = normalizeThreadProviderMetadataString(
    thread.providerProfileSource ?? thread.provider_profile_source,
  );
  const providerProfileName = normalizeThreadProviderMetadataString(
    thread.providerProfileName ?? thread.provider_profile_name,
  );
  const providerAvailability = normalizeThreadProviderMetadataString(
    thread.providerAvailability ?? thread.provider_availability,
  );
  return {
    ...(sourceLabel ? { sourceLabel } : {}),
    ...(providerProfileId ? { providerProfileId } : {}),
    ...(providerProfileSource ? { providerProfileSource } : {}),
    ...(providerProfileName ? { providerProfileName } : {}),
    ...(providerAvailability ? { providerAvailability } : {}),
  };
}

type PendingNativeEngine = "claude" | "gemini" | "grok" | "kimi" | "opencode" | "pi" | "dsh" | "qoder";

function uniquePendingEngine(
  pendingByEngine: Record<PendingNativeEngine, string | null>,
): PendingNativeEngine | null {
  const active = (Object.entries(pendingByEngine) as Array<
    [PendingNativeEngine, string | null]
  >).filter(([, threadId]) => Boolean(threadId));
  return active.length === 1 ? active[0][0] : null;
}

function isPendingThreadForEngine(
  engine: PendingNativeEngine,
  threadId: string | null | undefined,
): threadId is string {
  if (!threadId) {
    return false;
  }
  if (engine === "claude") {
    return isClaudeSessionBootstrapThreadId(threadId);
  }
  return isPendingSessionForEngine(engine, threadId);
}

type UseThreadTurnEventsOptions = {
  activeThreadId?: string | null;
  dispatch: Dispatch<ThreadAction>;
  getCustomName: (workspaceId: string, threadId: string) => string | undefined;
  resolveCanonicalThreadId?: (threadId: string) => string;
  isAutoTitlePending: (workspaceId: string, threadId: string) => boolean;
  isThreadHidden: (workspaceId: string, threadId: string) => boolean;
  markProcessing: (threadId: string, isProcessing: boolean) => void;
  markReviewing: (threadId: string, isReviewing: boolean) => void;
  setActiveTurnId: (threadId: string, turnId: string | null) => void;
  codexCompactionInFlightByThreadRef: MutableRefObject<Record<string, boolean>>;
  pendingInterruptsRef: MutableRefObject<WorkspaceScopedMap<true>>;
  interruptedThreadsRef: MutableRefObject<WorkspaceScopedMap<true>>;
  pushThreadErrorMessage: (
    workspaceId: string,
    threadId: string,
    message: string,
    executionTargetSnapshot?: TurnExecutionSnapshot,
  ) => void;
  safeMessageActivity: () => void;
  recordThreadActivity: (workspaceId: string, threadId: string, timestamp?: number) => void;
  renameCustomNameKey: (
    workspaceId: string,
    oldThreadId: string,
    newThreadId: string,
  ) => void;
  renameAutoTitlePendingKey: (
    workspaceId: string,
    oldThreadId: string,
    newThreadId: string,
  ) => void;
  renameThreadTitleMapping: (
    workspaceId: string,
    oldThreadId: string,
    newThreadId: string,
  ) => Promise<void>;
  resolvePendingThreadForSession?: (
    workspaceId: string,
    engine: "claude" | "gemini" | "grok" | "kimi" | "opencode" | "pi" | "dsh" | "qoder",
  ) => string | null;
  resolvePendingThreadForTurn?: (
    workspaceId: string,
    engine: "claude" | "gemini" | "grok" | "kimi" | "opencode" | "pi" | "dsh" | "qoder",
    turnId: string | null | undefined,
  ) => string | null;
  getActiveTurnIdForThread?: (threadId: string) => string | null;
  getThreadProviderProfileId?: (
    workspaceId: string,
    threadId: string,
  ) => string | null | undefined;
  hasEstablishedThreadItems?: (threadId: string) => boolean;
  renamePendingMemoryCaptureKey: (
    oldThreadId: string,
    newThreadId: string,
  ) => void;
  onDebug?: (entry: DebugEntry) => void;
};

export function useThreadTurnEvents({
  activeThreadId = null,
  dispatch,
  getCustomName,
  resolveCanonicalThreadId,
  isAutoTitlePending,
  isThreadHidden,
  markProcessing,
  markReviewing,
  setActiveTurnId,
  codexCompactionInFlightByThreadRef,
  pendingInterruptsRef,
  interruptedThreadsRef,
  pushThreadErrorMessage,
  safeMessageActivity,
  recordThreadActivity,
  renameCustomNameKey,
  renameAutoTitlePendingKey,
  renameThreadTitleMapping,
  resolvePendingThreadForSession,
  resolvePendingThreadForTurn,
  getActiveTurnIdForThread,
  getThreadProviderProfileId,
  hasEstablishedThreadItems,
  renamePendingMemoryCaptureKey,
  onDebug,
}: UseThreadTurnEventsOptions) {
  const { t } = useTranslation();
  const collectCompactionTargetThreadIds = useCallback(
    (threadId: string) => {
      const normalizedThreadId = threadId.trim();
      if (!normalizedThreadId) {
        return [] as string[];
      }
      const canonicalThreadId = resolveCanonicalThreadId?.(normalizedThreadId) ?? normalizedThreadId;
      return Array.from(new Set([normalizedThreadId, canonicalThreadId].filter(Boolean)));
    },
    [resolveCanonicalThreadId],
  );
  const isCodexCompactionInFlight = useCallback(
    (threadId: string) => codexCompactionInFlightByThreadRef.current[threadId] ?? false,
    [codexCompactionInFlightByThreadRef],
  );
  const setCodexCompactionInFlight = useCallback(
    (threadIds: string[], nextInFlight: boolean) => {
      const compactionStateByThread = codexCompactionInFlightByThreadRef.current;
      threadIds.forEach((targetThreadId) => {
        if (nextInFlight) {
          compactionStateByThread[targetThreadId] = true;
          return;
        }
        delete compactionStateByThread[targetThreadId];
      });
    },
    [codexCompactionInFlightByThreadRef],
  );
  const logSessionTrace = useCallback(
    (label: string, payload: Record<string, unknown>) => {
      onDebug?.({
        id: `${Date.now()}-thread-session-trace`,
        timestamp: Date.now(),
        source: "event",
        label: `thread/session:${label}`,
        payload,
      });
    },
    [onDebug],
  );
  const migrateThreadInterruptGuards = useCallback(
    (oldThreadId: string, newThreadId: string) => {
      const result = {
        movedPendingInterrupt: false,
        movedInterruptedThread: false,
      };
      if (!oldThreadId || !newThreadId || oldThreadId === newThreadId) {
        return result;
      }
      // workspace-scope rename: scan every workspace bucket and move
      // the oldThreadId entry to newThreadId (preserving the workspace
      // bucket key)
      for (const store of [pendingInterruptsRef.current, interruptedThreadsRef.current]) {
        for (const workspaceId of Array.from(store.keys())) {
          if (workspaceScopedHas(store, workspaceId, oldThreadId)) {
            const value = workspaceScopedGet(store, workspaceId, oldThreadId);
            workspaceScopedDelete(store, workspaceId, oldThreadId);
            if (value !== undefined) {
              workspaceScopedSet(store, workspaceId, newThreadId, value);
            }
            if (store === pendingInterruptsRef.current) {
              result.movedPendingInterrupt = true;
            } else {
              result.movedInterruptedThread = true;
            }
          }
        }
      }
      return result;
    },
    [interruptedThreadsRef, pendingInterruptsRef],
  );
  const resolvePendingAliasThread = useCallback(
    (
      workspaceId: string,
      threadId: string,
      turnId: string,
    ): string | null => {
      const engine = threadId.startsWith("opencode:")
        ? "opencode"
        : threadId.startsWith("gemini:")
          ? "gemini"
        : threadId.startsWith("claude:")
          ? "claude"
        : threadId.startsWith("dsh:")
          ? "dsh"
        : threadId.startsWith("qoder:")
          ? "qoder"
          : null;
      if (!engine) {
        return null;
      }
      if (!turnId || !getActiveTurnIdForThread) {
        return null;
      }
      const resolveMatchingPending = (candidate: string | null | undefined) => {
        if (!candidate || candidate === threadId) {
          return null;
        }
        const activePendingTurnId = getActiveTurnIdForThread(candidate);
        return activePendingTurnId === turnId ? candidate : null;
      };
      return (
        resolveMatchingPending(resolvePendingThreadForSession?.(workspaceId, engine)) ??
        resolveMatchingPending(resolvePendingThreadForTurn?.(workspaceId, engine, turnId))
      );
    },
    [getActiveTurnIdForThread, resolvePendingThreadForSession, resolvePendingThreadForTurn],
  );

  const emitTurnSettlementAudit = useCallback(
    (
      result: "settled" | "rejected",
      payload: Record<string, unknown>,
    ) => {
      const threadId =
        typeof payload.threadId === "string" ? payload.threadId : "";
      onDebug?.({
        id: `${Date.now()}-turn-settlement-${result}`,
        timestamp: Date.now(),
        source: "client",
        label: `thread/session:turn-settlement:${result}`,
        payload: {
          diagnosticCategory: "foreground-terminal-settlement",
          engine: threadId ? inferEngineFromThreadId(threadId) : null,
          settlementResult: result,
          ...payload,
        },
      });
    },
    [onDebug],
  );

  const onThreadStarted = useCallback(
    (workspaceId: string, thread: Record<string, unknown>) => {
      const threadId = asString(thread.id);
      if (!threadId) {
        return;
      }
      if (isBackgroundHelperThread(threadId, thread)) {
        dispatch({ type: "hideThread", workspaceId, threadId });
        return;
      }
      // 乐观创建的 codex 会话在后台预热了真实线程，app-server 会为它推一条
      // thread/started。首次发消息 finalize 换绑前放它进侧边栏，就会和
      // `codex-pending-*` 条目并列成两条空会话。
      if (
        inferEngineFromThreadId(threadId) === "codex" &&
        isCodexPrewarmThreadStart(workspaceId, threadId)
      ) {
        return;
      }
      if (isThreadHidden(workspaceId, threadId)) {
        return;
      }
      if (isSharedOwnedNativeThreadId(workspaceId, threadId)) {
        return;
      }
      const customName = getCustomName(workspaceId, threadId);
      const canApplyLiveName =
        !customName && !isAutoTitlePending(workspaceId, threadId);
      const liveIdentity = resolveCodexSubagentIdentity(threadId, thread);
      dispatch({
        type: "ensureThread",
        workspaceId,
        threadId,
        engine: inferEngineFromThreadId(threadId),
        ...(liveIdentity.parentThreadId
          ? { parentThreadId: liveIdentity.parentThreadId }
          : {}),
        ...(canApplyLiveName && liveIdentity.name
          ? { name: liveIdentity.name }
          : {}),
        ...extractThreadProviderMetadata(thread),
      });
      if (inferEngineFromThreadId(threadId) === "codex") {
        dispatch({
          type: "markCodexAcceptedTurn",
          threadId,
          fact: "empty-draft",
          source: "thread-start",
          timestamp: Date.now(),
        });
      }
      const timestamp = getThreadTimestamp(thread);
      const activityTimestamp = timestamp > 0 ? timestamp : Date.now();
      recordThreadActivity(workspaceId, threadId, activityTimestamp);
      dispatch({
        type: "setThreadTimestamp",
        workspaceId,
        threadId,
        timestamp: activityTimestamp,
      });

      if (canApplyLiveName && !liveIdentity.name) {
        const preview = asString(thread.preview).trim();
        if (preview) {
          const name = previewThreadName(preview, `Agent ${threadId.slice(0, 4)}`);
          dispatch({ type: "setThreadName", workspaceId, threadId, name });
        }
      }
      safeMessageActivity();
    },
    [dispatch, getCustomName, isAutoTitlePending, isThreadHidden, recordThreadActivity, safeMessageActivity],
  );

  const onTurnStarted = useCallback(
    (workspaceId: string, threadId: string, turnId: string) => {
      dispatch({
        type: "ensureThread",
        workspaceId,
        threadId,
        engine: inferEngineFromThreadId(threadId),
      });
      dispatch({
        type: "setThreadHistoryRestoredAt",
        threadId,
        timestamp: null,
      });
      dispatch({ type: "markContextCompacting", threadId, isCompacting: false });
      if (workspaceScopedHas(pendingInterruptsRef.current, workspaceId, threadId)) {
        workspaceScopedDelete(pendingInterruptsRef.current, workspaceId, threadId);
        const engine = inferEngineFromThreadId(threadId);
        const qoderProviderProfileId =
          engine === "qoder"
            ? resolveQoderProviderProfileIdForThread(
                getThreadProviderProfileId,
                workspaceId,
                threadId,
              )
            : null;
        if (engine === "codex" && turnId) {
          void interruptTurnService(workspaceId, threadId, turnId).catch(() => {});
        } else if (turnId) {
          const interrupt = qoderProviderProfileId
            ? engineInterruptTurnService(
                workspaceId,
                turnId,
                engine,
                qoderProviderProfileId,
              )
            : engineInterruptTurnService(workspaceId, turnId, engine);
          void interrupt.catch(() => {
            // Qoder 的旧 workspace-wide interrupt 不携带 distribution，不能
            // 作为 Qoder Global/CN 的兼容降级路径。
            if (engine !== "qoder") {
              void engineInterruptService(workspaceId).catch(() => {});
            }
          });
        }
        return;
      }
      markProcessing(threadId, true);
      if (turnId) {
        setActiveTurnId(threadId, turnId);
      }
    },
    [
      dispatch,
      getThreadProviderProfileId,
      markProcessing,
      pendingInterruptsRef,
      setActiveTurnId,
    ],
  );

  const onTurnCompleted = useCallback(
    (workspaceId: string, threadId: string, turnId: string) => {
      const aliasThreadId = resolvePendingAliasThread(workspaceId, threadId, turnId);
      const activeTurnId = getActiveTurnIdForThread?.(threadId) ?? null;
      const activeAliasTurnId = aliasThreadId
        ? (getActiveTurnIdForThread?.(aliasThreadId) ?? null)
        : null;
      const targetThreadIds = Array.from(
        new Set(aliasThreadId ? [threadId, aliasThreadId] : [threadId]),
      );
      const targetSnapshots = targetThreadIds.map((targetThreadId) => ({
        threadId: targetThreadId,
        activeTurnId:
          targetThreadId === threadId
            ? activeTurnId
            : targetThreadId === aliasThreadId
              ? activeAliasTurnId
              : (getActiveTurnIdForThread?.(targetThreadId) ?? null),
      }));
      const safeTargets = targetSnapshots.filter(
        (target) =>
          !turnId ||
          target.activeTurnId === null ||
          target.activeTurnId === turnId,
      );
      const rejectedTargets = targetSnapshots.filter(
        (target) => !safeTargets.some((safeTarget) => safeTarget.threadId === target.threadId),
      );
      if (safeTargets.length === 0) {
        emitTurnSettlementAudit("rejected", {
          workspaceId,
          threadId,
          turnId,
          aliasThreadId,
          activeTurnId,
          activeAliasTurnId,
          rejectedTargets,
          reason: "turn-mismatch",
          incomingTurnId: turnId || null,
          currentActiveTurnId: activeTurnId,
          targetThreadCount: targetSnapshots.length,
        });
        return false;
      }
      safeTargets.forEach(({ threadId: targetThreadId }) => {
        // A4 live-text 外部化：terminal settlement 必须把通道内「全文」一次写入
        // durable item。只 append shell 后尾段时，若 shell 首 delta 未进 reducer
        // 或 shellTextLength 失真，isStreaming 关闭后 UI 会只剩「已」「**」这类
        // 建壳碎片，重开历史才恢复（用户截图中的典型形态）。
        settleLiveAssistantFullText(dispatch, workspaceId, targetThreadId);
        dispatch({
          type: "clearProcessingGeneratedImages",
          threadId: targetThreadId,
        });
        dispatch({ type: "markTerminalSettlement", threadId: targetThreadId });
        dispatch({
          type: "finalizePendingToolStatuses",
          threadId: targetThreadId,
          status: "completed",
        });
        dispatch({
          type: "markContextCompacting",
          threadId: targetThreadId,
          isCompacting: false,
          timestamp: Date.now(),
        });
        dispatch({
          type: "settleThreadPlanInProgress",
          threadId: targetThreadId,
          targetStatus: "completed",
        });
        markProcessing(targetThreadId, false);
        setActiveTurnId(targetThreadId, null);
        workspaceScopedDelete(pendingInterruptsRef.current, workspaceId, targetThreadId);
        workspaceScopedDelete(interruptedThreadsRef.current, workspaceId, targetThreadId);
        // 重置分段计数，为下一个 turn 做准备
        dispatch({ type: "resetAgentSegment", threadId: targetThreadId });
        dispatch({ type: "markLatestAssistantMessageFinal", threadId: targetThreadId });
      });
      emitTurnSettlementAudit("settled", {
        workspaceId,
        threadId,
        turnId,
        aliasThreadId,
        activeTurnId,
        activeAliasTurnId,
        settledThreadIds: safeTargets.map((target) => target.threadId),
        rejectedTargets,
        reason: rejectedTargets.length > 0 ? "partial-turn-mismatch" : "matched",
        incomingTurnId: turnId || null,
        currentActiveTurnId: activeTurnId,
        targetThreadCount: targetSnapshots.length,
      });
      noteSharedRetryFromTurn(workspaceId, threadId, {
        outcome: "completed",
        attemptId: turnId || null,
      });
      return true;
    },
    [
      dispatch,
      emitTurnSettlementAudit,
      getActiveTurnIdForThread,
      interruptedThreadsRef,
      markProcessing,
      pendingInterruptsRef,
      resolvePendingAliasThread,
      setActiveTurnId,
    ],
  );

  const onTurnPlanUpdated = useCallback(
    (
      workspaceId: string,
      threadId: string,
      turnId: string,
      payload: { explanation: unknown; plan: unknown },
    ) => {
      dispatch({ type: "ensureThread", workspaceId, threadId, engine: inferEngineFromThreadId(threadId) });
      const normalized = normalizePlanUpdate(
        turnId,
        payload.explanation,
        payload.plan,
      );
      dispatch({ type: "setThreadPlan", threadId, plan: normalized });
    },
    [dispatch],
  );

  const onAssistantRuntimeReceipt = useCallback(
    (
      _workspaceId: string,
      threadId: string,
      runtimeReceipt: NonNullable<
        Extract<import("../../../types").ConversationItem, { kind: "message" }>["runtimeReceipt"]
      >,
    ) => {
      dispatch({
        type: "patchAssistantRuntimeReceipt",
        threadId,
        runtimeReceipt,
      });
    },
    [dispatch],
  );

  const onThreadTokenUsageUpdated = useCallback(
    (workspaceId: string, threadId: string, tokenUsage: Record<string, unknown>) => {
      dispatch({ type: "ensureThread", workspaceId, threadId, engine: inferEngineFromThreadId(threadId) });
      const sessionStats = normalizeDshSessionStats(
        tokenUsage.sessionStats ?? tokenUsage.session_stats,
      );
      const hasTokenEnvelope =
        tokenUsage.total != null ||
        tokenUsage.last != null ||
        tokenUsage.inputTokens != null ||
        tokenUsage.input_tokens != null ||
        tokenUsage.outputTokens != null ||
        tokenUsage.output_tokens != null;
      if (!hasTokenEnvelope && sessionStats) {
        dispatch({
          type: "setThreadSessionStats",
          threadId,
          sessionStats,
        });
        return;
      }
      if (!hasTokenEnvelope && tokenUsage.dshTodos !== undefined) {
        dispatch({
          type: "setThreadDshTodos",
          threadId,
          todos: normalizeDshTodos(tokenUsage.dshTodos) ?? [],
        });
        return;
      }
      if (!hasTokenEnvelope && tokenUsage.dshContextPatch) {
        dispatch({
          type: "patchThreadDshContextUsage",
          threadId,
          patch: tokenUsage.dshContextPatch as never,
        });
        return;
      }
      dispatch({
        type: "setThreadTokenUsage",
        threadId,
        tokenUsage: normalizeTokenUsage(tokenUsage),
      });
    },
    [dispatch],
  );

  const onAccountRateLimitsUpdated = useCallback(
    (workspaceId: string, rateLimits: Record<string, unknown>) => {
      dispatch({
        type: "setRateLimits",
        workspaceId,
        rateLimits: normalizeRateLimits(rateLimits),
      });
    },
    [dispatch],
  );

  const onTurnError = useCallback(
    (
      workspaceId: string,
      threadId: string,
      turnId: string,
      payload: {
        message: string;
        willRetry: boolean;
        suppressMessage?: boolean;
        executionTargetSnapshot?: TurnExecutionSnapshot;
      },
    ) => {
      if (payload.willRetry) {
        return;
      }
      const aliasThreadId = resolvePendingAliasThread(workspaceId, threadId, turnId);
      const activeTurnId = getActiveTurnIdForThread?.(threadId) ?? null;
      const activeAliasTurnId = aliasThreadId
        ? (getActiveTurnIdForThread?.(aliasThreadId) ?? null)
        : null;
      const matchesActiveTurn =
        !turnId ||
        activeTurnId === null ||
        activeTurnId === turnId ||
        activeAliasTurnId === turnId;
      if (!matchesActiveTurn) {
        return;
      }

      // If this thread was interrupted by user, the error is expected
      // (e.g. "Session stopped."). Clean up the interrupted flag and
      // suppress the redundant error message since interruptTurn already
      // displayed "Session stopped." to the user.
      const wasInterrupted = workspaceScopedHas(
        interruptedThreadsRef.current,
        workspaceId,
        threadId,
      );
      const shouldKeepInterruptedGuard =
        wasInterrupted && inferEngineFromThreadId(threadId) === "gemini";
      if (!shouldKeepInterruptedGuard) {
        workspaceScopedDelete(interruptedThreadsRef.current, workspaceId, threadId);
      }

      dispatch({ type: "ensureThread", workspaceId, threadId, engine: inferEngineFromThreadId(threadId) });
      settleLiveAssistantFullText(dispatch, workspaceId, threadId);
      dispatch({
        type: "clearProcessingGeneratedImages",
        threadId,
      });
      dispatch({ type: "markTerminalSettlement", threadId });
      dispatch({
        type: "finalizePendingToolStatuses",
        threadId,
        status: "failed",
      });
      dispatch({
        type: "settleThreadPlanInProgress",
        threadId,
        targetStatus: "pending",
      });
      dispatch({
        type: "markContextCompacting",
        threadId,
        isCompacting: false,
        timestamp: Date.now(),
      });
      markProcessing(threadId, false);
      markReviewing(threadId, false);
      setActiveTurnId(threadId, null);
      if (aliasThreadId) {
        settleLiveAssistantFullText(dispatch, workspaceId, aliasThreadId);
        dispatch({
          type: "clearProcessingGeneratedImages",
          threadId: aliasThreadId,
        });
        dispatch({
          type: "markTerminalSettlement",
          threadId: aliasThreadId,
        });
        dispatch({
          type: "finalizePendingToolStatuses",
          threadId: aliasThreadId,
          status: "failed",
        });
        dispatch({
          type: "markContextCompacting",
          threadId: aliasThreadId,
          isCompacting: false,
          timestamp: Date.now(),
        });
        dispatch({
          type: "settleThreadPlanInProgress",
          threadId: aliasThreadId,
          targetStatus: "pending",
        });
        markProcessing(aliasThreadId, false);
        markReviewing(aliasThreadId, false);
        setActiveTurnId(aliasThreadId, null);
        workspaceScopedDelete(pendingInterruptsRef.current, workspaceId, aliasThreadId);
        workspaceScopedDelete(interruptedThreadsRef.current, workspaceId, aliasThreadId);
      }

      if (!wasInterrupted && !payload.suppressMessage) {
        const stabilityDiagnostic = payload.message
          ? resolveThreadStabilityDiagnostic(payload.message)
          : null;
        if (stabilityDiagnostic) {
          onDebug?.({
            id: `${Date.now()}-thread-stability-diagnostic`,
            timestamp: Date.now(),
            source: "event",
            label: "thread/stability diagnostic",
            payload: {
              workspaceId,
              threadId,
              turnId,
              category: stabilityDiagnostic.category,
              rawMessage: stabilityDiagnostic.rawMessage,
              recoveryReason: stabilityDiagnostic.reconnectReason ?? null,
            },
          });
        }
        const message = payload.message
          ? t("threads.turnFailedWithMessage", { message: payload.message })
          : t("threads.turnFailed");
        const errorSnapshot = payload.executionTargetSnapshot ?? undefined;
        if (errorSnapshot) {
          pushThreadErrorMessage(
            workspaceId,
            threadId,
            message,
            errorSnapshot,
          );
        } else {
          pushThreadErrorMessage(workspaceId, threadId, message);
        }
        noteSharedRetryFromTurn(workspaceId, threadId, {
          outcome: wasInterrupted ? "cancelled" : "failed",
          message: payload.message,
          wasLocalInterrupt: wasInterrupted,
          snapshot: errorSnapshot,
          attemptId: turnId || null,
        });
        pushThreadFailureRuntimeNotice({
          workspaceId,
          threadId,
          turnId,
          engine: inferEngineFromThreadId(threadId),
          message: payload.message || message,
        });
      }
      safeMessageActivity();
    },
    [
      dispatch,
      getActiveTurnIdForThread,
      interruptedThreadsRef,
      markProcessing,
      markReviewing,
      onDebug,
      pendingInterruptsRef,
      pushThreadErrorMessage,
      resolvePendingAliasThread,
      safeMessageActivity,
      setActiveTurnId,
      t,
    ],
  );

  const onTurnStalled = useCallback(
    (
      workspaceId: string,
      threadId: string,
      turnId: string,
      payload: {
        message: string;
        reasonCode: string;
        stage: string;
        source: string;
        startedAtMs: number | null;
        timeoutMs: number | null;
      },
    ) => {
      const aliasThreadId = resolvePendingAliasThread(workspaceId, threadId, turnId);
      const activeTurnId = getActiveTurnIdForThread?.(threadId) ?? null;
      const activeAliasTurnId = aliasThreadId
        ? (getActiveTurnIdForThread?.(aliasThreadId) ?? null)
        : null;
      const matchesActiveTurn =
        !turnId ||
        activeTurnId === null ||
        activeTurnId === turnId ||
        activeAliasTurnId === turnId;
      if (!matchesActiveTurn) {
        return;
      }

      dispatch({ type: "ensureThread", workspaceId, threadId, engine: inferEngineFromThreadId(threadId) });
      settleLiveAssistantFullText(dispatch, workspaceId, threadId);
      dispatch({
        type: "clearProcessingGeneratedImages",
        threadId,
      });
      dispatch({ type: "markTerminalSettlement", threadId });
      dispatch({
        type: "settleThreadPlanInProgress",
        threadId,
        targetStatus: "pending",
      });
      dispatch({
        type: "markContextCompacting",
        threadId,
        isCompacting: false,
        timestamp: Date.now(),
      });
      markProcessing(threadId, false);
      markReviewing(threadId, false);
      setActiveTurnId(threadId, null);
      if (aliasThreadId) {
        settleLiveAssistantFullText(dispatch, workspaceId, aliasThreadId);
        dispatch({
          type: "clearProcessingGeneratedImages",
          threadId: aliasThreadId,
        });
        dispatch({
          type: "markTerminalSettlement",
          threadId: aliasThreadId,
        });
        dispatch({
          type: "settleThreadPlanInProgress",
          threadId: aliasThreadId,
          targetStatus: "pending",
        });
        dispatch({
          type: "markContextCompacting",
          threadId: aliasThreadId,
          isCompacting: false,
          timestamp: Date.now(),
        });
        markProcessing(aliasThreadId, false);
        markReviewing(aliasThreadId, false);
        setActiveTurnId(aliasThreadId, null);
      }
      onDebug?.({
        id: `${Date.now()}-thread-stability-diagnostic`,
        timestamp: Date.now(),
        source: "event",
        label: "thread/stability diagnostic",
        payload: {
          workspaceId,
          threadId,
          turnId,
          category: "resume_stalled",
          rawMessage: payload.message,
          reasonCode: payload.reasonCode,
          stage: payload.stage,
          source: payload.source,
          startedAtMs: payload.startedAtMs,
          timeoutMs: payload.timeoutMs,
        },
      });
      const isFusionStalled = payload.source === "queue-fusion-cutover";
      const message = payload.message
        ? t(
            isFusionStalled
              ? "threads.fusionTurnStalledWithMessage"
              : "threads.turnStalledWithMessage",
            { message: payload.message },
          )
        : t(isFusionStalled ? "threads.fusionTurnStalled" : "threads.turnStalled");
      pushThreadErrorMessage(workspaceId, threadId, message);
      noteSharedRetryFromTurn(workspaceId, threadId, {
        outcome: "failed",
        message: payload.message,
        attemptId: turnId || null,
      });
      pushThreadFailureRuntimeNotice({
        workspaceId,
        threadId,
        turnId,
        engine: inferEngineFromThreadId(threadId),
        message: payload.message || message,
      });
      safeMessageActivity();
    },
    [
      dispatch,
      getActiveTurnIdForThread,
      markProcessing,
      markReviewing,
      onDebug,
      pushThreadErrorMessage,
      resolvePendingAliasThread,
      safeMessageActivity,
      setActiveTurnId,
      t,
    ],
  );

  const onContextCompacted = useCallback(
    (
      workspaceId: string,
      threadId: string,
      turnId: string,
      payload?: ContextCompactionSourcePayload,
    ) => {
      const timestamp = Date.now();
      const targetThreadIds = collectCompactionTargetThreadIds(threadId);
      const wasCodexCompacting = targetThreadIds.some(isCodexCompactionInFlight);
      const isCodexCompaction = payload
        ? targetThreadIds.some((targetThreadId) => isCodexContextCompaction(targetThreadId))
        : wasCodexCompacting;
      setCodexCompactionInFlight(targetThreadIds, false);
      const compactionSource = resolveCompactionSource(payload);
      targetThreadIds.forEach((targetThreadId) => {
        const compactionAction: ThreadAction = {
          type: "markContextCompacting",
          threadId: targetThreadId,
          isCompacting: false,
          timestamp,
          ...(isCodexCompaction ? { completionStatus: "completed" as const } : {}),
          ...(compactionSource !== undefined ? { source: compactionSource } : {}),
        };
        dispatch({
          type: "ensureThread",
          workspaceId,
          threadId: targetThreadId,
          engine: inferEngineFromThreadId(targetThreadId),
        });
        dispatch(compactionAction);
      });
      const resolvedTurnId = turnId || `auto-${timestamp}`;
      if (isCodexCompaction) {
        const shouldAppendCompletedFallback = Boolean(payload) && !wasCodexCompacting;
        targetThreadIds.forEach((targetThreadId) => {
          dispatch({
            type: "settleCodexCompactionMessage",
            threadId: targetThreadId,
            text: t("threads.codexCompactionCompleted"),
            fallbackMessageId: buildCodexCompactionCompletionFallbackId(
              targetThreadId,
              resolvedTurnId,
            ),
            appendIfAlreadyCompleted: shouldAppendCompletedFallback,
          });
        });
      } else {
        targetThreadIds.forEach((targetThreadId) => {
          dispatch({
            type: "appendContextCompacted",
            threadId: targetThreadId,
            turnId: resolvedTurnId,
          });
        });
      }
      targetThreadIds.forEach((targetThreadId) => {
        recordThreadActivity(workspaceId, targetThreadId, timestamp);
      });
      safeMessageActivity();
    },
    [
      collectCompactionTargetThreadIds,
      dispatch,
      isCodexCompactionInFlight,
      recordThreadActivity,
      safeMessageActivity,
      setCodexCompactionInFlight,
      t,
    ],
  );

  const onContextCompacting = useCallback(
    (
      workspaceId: string,
      threadId: string,
      _payload: {
        usagePercent: number | null;
        thresholdPercent: number | null;
        targetPercent: number | null;
        auto?: boolean | null;
        manual?: boolean | null;
      },
    ) => {
      const targetThreadIds = collectCompactionTargetThreadIds(threadId);
      const isCodexCompaction = targetThreadIds.some((targetThreadId) =>
        isCodexContextCompaction(targetThreadId),
      );
      setCodexCompactionInFlight(targetThreadIds, isCodexCompaction);
      const timestamp = Date.now();
      const compactionSource = resolveCompactionSource(_payload);
      targetThreadIds.forEach((targetThreadId) => {
        const compactionAction: ThreadAction = {
          type: "markContextCompacting",
          threadId: targetThreadId,
          isCompacting: true,
          timestamp,
          ...(compactionSource !== undefined ? { source: compactionSource } : {}),
        };
        dispatch({
          type: "ensureThread",
          workspaceId,
          threadId: targetThreadId,
          engine: inferEngineFromThreadId(targetThreadId),
        });
        dispatch(compactionAction);
      });
      if (isCodexCompaction) {
        targetThreadIds.forEach((targetThreadId) => {
          dispatch({
            type: "appendCodexCompactionMessage",
            threadId: targetThreadId,
            text: t("threads.codexCompactionStarted"),
          });
        });
      }
      targetThreadIds.forEach((targetThreadId) => {
        recordThreadActivity(workspaceId, targetThreadId, timestamp);
      });
      safeMessageActivity();
    },
    [
      collectCompactionTargetThreadIds,
      dispatch,
      recordThreadActivity,
      safeMessageActivity,
      setCodexCompactionInFlight,
      t,
    ],
  );

  const onContextCompactionFailed = useCallback(
    (workspaceId: string, threadId: string, reason: string) => {
      const timestamp = Date.now();
      const targetThreadIds = collectCompactionTargetThreadIds(threadId);
      setCodexCompactionInFlight(targetThreadIds, false);
      targetThreadIds.forEach((targetThreadId) => {
        dispatch({
          type: "ensureThread",
          workspaceId,
          threadId: targetThreadId,
          engine: inferEngineFromThreadId(targetThreadId),
        });
        dispatch({
          type: "markContextCompacting",
          threadId: targetThreadId,
          isCompacting: false,
          timestamp,
        });
      });
      const message = reason
        ? t("threads.contextCompactionFailedWithMessage", { message: reason })
        : t("threads.contextCompactionFailed");
      const stabilityDiagnostic = reason
        ? resolveThreadStabilityDiagnostic(reason)
        : null;
      if (stabilityDiagnostic) {
        onDebug?.({
          id: `${Date.now()}-thread-stability-diagnostic`,
          timestamp: Date.now(),
          source: "event",
          label: "thread/stability diagnostic",
          payload: {
            workspaceId,
            threadId: targetThreadIds[0] ?? threadId,
            category: stabilityDiagnostic.category,
            rawMessage: stabilityDiagnostic.rawMessage,
            recoveryReason: stabilityDiagnostic.reconnectReason ?? null,
            stage: "context-compaction",
          },
        });
      }
      targetThreadIds.forEach((targetThreadId) => {
        pushThreadErrorMessage(workspaceId, targetThreadId, message);
      });
      pushThreadFailureRuntimeNotice({
        workspaceId,
        threadId: targetThreadIds[0] ?? threadId,
        engine: inferEngineFromThreadId(targetThreadIds[0] ?? threadId),
        message: reason || message,
      });
      safeMessageActivity();
    },
    [
      collectCompactionTargetThreadIds,
      dispatch,
      onDebug,
      pushThreadErrorMessage,
      safeMessageActivity,
      setCodexCompactionInFlight,
      t,
    ],
  );

  const onThreadSessionIdUpdated = useCallback(
    (
      workspaceId: string,
      threadId: string,
      sessionId: string,
      engineHint?: "claude" | "opencode" | "codex" | "gemini" | "grok" | "kimi" | "pi" | "dsh" | "qoder" | null,
      turnId?: string | null,
    ) => {
      const explicitEnginePrefix = threadId.startsWith("claude:")
        || threadId.startsWith("claude-pending-")
        || isClaudeForkThreadId(threadId)
        ? "claude"
        : threadId.startsWith("gemini:")
          || threadId.startsWith("gemini-pending-")
          ? "gemini"
        : threadId.startsWith("grok:")
          || threadId.startsWith("grok-pending-")
          ? "grok"
        : threadId.startsWith("kimi:")
          || threadId.startsWith("kimi-pending-")
          ? "kimi"
        : threadId.startsWith("pi:")
          || threadId.startsWith("pi-pending-")
          ? "pi"
        : threadId.startsWith("qoder:")
          || threadId.startsWith("qoder-pending-")
          ? "qoder"
        : threadId.startsWith("opencode:")
          || threadId.startsWith("opencode-pending-")
          ? "opencode"
        : threadId.startsWith("dsh:")
          || threadId.startsWith("dsh-pending-")
          ? "dsh"
          : null;
      const hintedEngine =
        engineHint === "claude" || engineHint === "gemini" || engineHint === "grok" || engineHint === "kimi" || engineHint === "pi" || engineHint === "qoder" || engineHint === "opencode" || engineHint === "dsh"
          ? engineHint
          : null;
      const pendingByEngine: Record<PendingNativeEngine, string | null> = {
        opencode: resolvePendingThreadForSession?.(workspaceId, "opencode") ?? null,
        gemini: resolvePendingThreadForSession?.(workspaceId, "gemini") ?? null,
        grok: resolvePendingThreadForSession?.(workspaceId, "grok") ?? null,
        kimi: resolvePendingThreadForSession?.(workspaceId, "kimi") ?? null,
        claude: resolvePendingThreadForSession?.(workspaceId, "claude") ?? null,
        pi: resolvePendingThreadForSession?.(workspaceId, "pi") ?? null,
        qoder: resolvePendingThreadForSession?.(workspaceId, "qoder") ?? null,
        dsh: resolvePendingThreadForSession?.(workspaceId, "dsh") ?? null,
      };
      const pendingOpenCode = pendingByEngine.opencode;
      const pendingGemini = pendingByEngine.gemini;
      const pendingGrok = pendingByEngine.grok;
      const pendingKimi = pendingByEngine.kimi;
      const pendingPi = pendingByEngine.pi;
      const pendingQoder = pendingByEngine.qoder;
      const pendingClaude = pendingByEngine.claude;
      const pendingDsh = pendingByEngine.dsh;
      logSessionTrace("event", {
        workspaceId,
        threadId,
        sessionId,
        engineHint: engineHint ?? null,
        turnId: turnId ?? null,
        explicitEnginePrefix,
        pendingOpenCode,
        pendingGemini,
        pendingGrok,
        pendingKimi,
        pendingPi,
        pendingQoder,
        pendingClaude,
        pendingDsh,
      });

      const enginePrefix =
        explicitEnginePrefix
        ?? hintedEngine
        ?? uniquePendingEngine(pendingByEngine);
      if (!enginePrefix) {
        logSessionTrace("skip:no-engine-prefix", {
          workspaceId,
          threadId,
          sessionId,
          engineHint: engineHint ?? null,
          pendingOpenCode,
          pendingGemini,
          pendingGrok,
          pendingKimi,
          pendingPi,
          pendingClaude,
          pendingDsh,
        });
        return;
      }

      const qoderEventIdentity =
        enginePrefix === "qoder" && threadId.startsWith("qoder:")
          ? parseQoderSessionIdentity(
              threadId,
              getThreadProviderProfileId?.(workspaceId, threadId) ?? null,
            )
          : null;
      if (enginePrefix === "qoder" && threadId.startsWith("qoder:") && !qoderEventIdentity) {
        logSessionTrace("skip:conflicting-qoder-runtime-owner", {
          workspaceId,
          threadId,
          sessionId,
          enginePrefix,
        });
        return;
      }
      const qoderProviderProfileId =
        enginePrefix === "qoder"
          ? (qoderEventIdentity?.providerProfileId ??
            resolveQoderProviderProfileIdForThread(
              getThreadProviderProfileId,
              workspaceId,
              threadId,
            ) ??
            resolveQoderProviderProfileIdForThread(
              getThreadProviderProfileId,
              workspaceId,
              pendingByEngine.qoder ?? "",
            ))
          : null;
      const newThreadId =
        enginePrefix === "qoder"
          ? canonicalQoderThreadId(sessionId, qoderProviderProfileId)
          : `${enginePrefix}:${sessionId}`;
      if (!newThreadId) {
        logSessionTrace("skip:invalid-qoder-session-identity", {
          workspaceId,
          threadId,
          sessionId,
          enginePrefix,
        });
        return;
      }
      const qoderEventSessionIdentity =
        enginePrefix === "qoder"
          ? parseQoderSessionIdentity(sessionId, qoderProviderProfileId)
          : null;
      const isQoderLegacyIdentityUpgrade =
        enginePrefix === "qoder" &&
        qoderEventIdentity?.isLegacy === true &&
        qoderEventSessionIdentity?.rawSessionId ===
          qoderEventIdentity.rawSessionId;
      const turnBoundPendingThreadId =
        resolvePendingThreadForTurn?.(workspaceId, enginePrefix, turnId) ?? null;

      const sameEngineFinalizedPrefix = `${enginePrefix}:`;
      const hasAnyEnginePrefix =
        threadId.startsWith("claude:")
        || threadId.startsWith("claude-pending-")
        || isClaudeForkThreadId(threadId)
        || threadId.startsWith("gemini:")
        || threadId.startsWith("gemini-pending-")
        || threadId.startsWith("grok:")
        || threadId.startsWith("grok-pending-")
        || threadId.startsWith("kimi:")
        || threadId.startsWith("kimi-pending-")
        || threadId.startsWith("pi:")
        || threadId.startsWith("pi-pending-")
        || threadId.startsWith("qoder:")
        || threadId.startsWith("qoder-pending-")
        || threadId.startsWith("opencode:")
        || threadId.startsWith("opencode-pending-")
        || threadId.startsWith("dsh:")
        || threadId.startsWith("dsh-pending-");
      const hasForeignEnginePrefix = (
        (enginePrefix !== "claude" && (threadId.startsWith("claude:") || threadId.startsWith("claude-pending-")))
        || (enginePrefix !== "gemini" && (threadId.startsWith("gemini:") || threadId.startsWith("gemini-pending-")))
        || (enginePrefix !== "grok" && (threadId.startsWith("grok:") || threadId.startsWith("grok-pending-")))
        || (enginePrefix !== "kimi" && (threadId.startsWith("kimi:") || threadId.startsWith("kimi-pending-")))
        || (enginePrefix !== "pi" && (threadId.startsWith("pi:") || threadId.startsWith("pi-pending-")))
        || (enginePrefix !== "qoder" && (threadId.startsWith("qoder:") || threadId.startsWith("qoder-pending-")))
        || (enginePrefix !== "opencode" && (threadId.startsWith("opencode:") || threadId.startsWith("opencode-pending-")))
        || (enginePrefix !== "dsh" && (threadId.startsWith("dsh:") || threadId.startsWith("dsh-pending-")))
      );

      if (
        threadId.startsWith(sameEngineFinalizedPrefix)
        && threadId !== newThreadId
        && !isQoderLegacyIdentityUpgrade
      ) {
        logSessionTrace("skip:finalized-mismatch", {
          workspaceId,
          threadId,
          newThreadId,
          enginePrefix,
          activeThreadId,
        });
        return;
      }

      // Claude re-announces its session id at the start of every turn, so an
      // established conversation keeps emitting finalized session-id updates
      // while it streams. Rebinding a pending thread onto such a target would
      // merge a brand-new session into an unrelated in-flight conversation
      // (its user bubble shows up in the old timeline), so the active-pending
      // fallbacks below must never fire when the target already has items.
      const newThreadIsEstablished =
        hasEstablishedThreadItems?.(newThreadId) ?? false;
      let sourceThreadId: string | null = null;
      if (threadId === newThreadId) {
        // Some runtimes emit session-id updates with finalized thread ids only.
        // Rebind conservatively: prefer an exact turn-bound pending match, and
        // otherwise only fall back to the active pending thread for the engine.
        const pendingThreadId = pendingByEngine[enginePrefix];
        if (isPendingThreadForEngine(enginePrefix, turnBoundPendingThreadId)) {
          sourceThreadId = turnBoundPendingThreadId;
        } else if (
          !newThreadIsEstablished
          && isPendingThreadForEngine(enginePrefix, pendingThreadId)
          && (
            pendingThreadId === activeThreadId ||
            activeThreadId === newThreadId
          )
        ) {
          sourceThreadId = pendingThreadId;
        } else {
          logSessionTrace(
            newThreadIsEstablished
              ? "skip:established-target"
              : "skip:already-finalized",
            {
              workspaceId,
              threadId,
              newThreadId,
              enginePrefix,
              activeThreadId,
              pendingThreadId: pendingThreadId ?? null,
              turnBoundPendingThreadId,
              turnId: turnId ?? null,
            },
          );
          return;
        }
      } else if (isPendingThreadForEngine(enginePrefix, threadId)) {
        sourceThreadId = threadId;
      } else if (isQoderLegacyIdentityUpgrade) {
        // 旧版 `qoder:<raw>` 已是 finalized id，但还没有 distribution。
        // 同一 raw ACP id 的 SessionStarted 仅升级 identity，不能当成换会话拒绝。
        sourceThreadId = threadId;
      } else if (!hasAnyEnginePrefix && !hasForeignEnginePrefix) {
        const pendingThreadId = pendingByEngine[enginePrefix];
        // Safety boundary: for non-prefixed thread ids, only bind to the
        // currently active pending thread unless a turn-bound mapping exists.
        // Turn-bound matches are safe to rebind even when the user has already
        // switched selection, because the turn identity is more precise than
        // workspace-level active-thread heuristics.
        if (isPendingThreadForEngine(enginePrefix, turnBoundPendingThreadId)) {
          sourceThreadId = turnBoundPendingThreadId;
        } else if (
          !newThreadIsEstablished
          && isPendingThreadForEngine(enginePrefix, pendingThreadId)
          && (
            pendingThreadId === activeThreadId ||
            activeThreadId === newThreadId
          )
        ) {
          sourceThreadId = pendingThreadId;
        } else {
          logSessionTrace(
            newThreadIsEstablished
              ? "skip:established-target"
              : "skip:non-prefixed-not-active",
            {
              workspaceId,
              threadId,
              newThreadId,
              enginePrefix,
              pendingThreadId: pendingThreadId ?? null,
              turnBoundPendingThreadId,
              activeThreadId,
              turnId: turnId ?? null,
            },
          );
        }
      }

      if (!sourceThreadId || sourceThreadId === newThreadId) {
        logSessionTrace("skip:no-pending-source", {
          workspaceId,
          threadId,
          newThreadId,
          sourceThreadId,
          hasForeignEnginePrefix,
          enginePrefix,
          turnBoundPendingThreadId,
          turnId: turnId ?? null,
        });
        return;
      }

      logSessionTrace("rename", {
        workspaceId,
        oldThreadId: sourceThreadId,
        newThreadId,
        enginePrefix,
        eventThreadId: threadId,
        turnBoundPendingThreadId,
        turnId: turnId ?? null,
      });
      const { movedPendingInterrupt } = migrateThreadInterruptGuards(
        sourceThreadId,
        newThreadId,
      );
      // If the user interrupted during pending->finalized rebind and the target
      // thread already has an active turn id, execute interrupt immediately.
      if (movedPendingInterrupt) {
        const activeTurnId = getActiveTurnIdForThread?.(newThreadId) ?? null;
        if (activeTurnId) {
          workspaceScopedDelete(pendingInterruptsRef.current, workspaceId, newThreadId);
          const qoderProviderProfileId =
            enginePrefix === "qoder"
              ? (resolveQoderProviderProfileIdForThread(
                  getThreadProviderProfileId,
                  workspaceId,
                  sourceThreadId,
                ) ??
                resolveQoderProviderProfileIdForThread(
                  getThreadProviderProfileId,
                  workspaceId,
                  newThreadId,
                ))
              : null;
          const interrupt = qoderProviderProfileId
            ? engineInterruptTurnService(
                workspaceId,
                activeTurnId,
                enginePrefix,
                qoderProviderProfileId,
              )
            : engineInterruptTurnService(workspaceId, activeTurnId, enginePrefix);
          void interrupt.catch(() => {
            if (enginePrefix !== "qoder") {
              void engineInterruptService(workspaceId).catch(() => {});
            }
          });
        }
      }
      // Rename the thread from claude-pending-* to claude:{sessionId}
      dispatch({
        type: "renameThreadId",
        workspaceId,
        oldThreadId: sourceThreadId,
        newThreadId,
      });
      // A4 live-text 外部化：随迁通道条目，流式中改名后订阅（新 threadId）
      // 才能继续读到累计文本。
      renameLiveAssistantTextThread(sourceThreadId, newThreadId);
      renameLiveItemDeltaThread(sourceThreadId, newThreadId);
      if (
        sourceThreadId.startsWith("shared:") ||
        newThreadId.startsWith("shared:")
      ) {
        renameRuntimeReceipt(workspaceId, sourceThreadId, newThreadId);
      }
      renameCustomNameKey(workspaceId, sourceThreadId, newThreadId);
      renameAutoTitlePendingKey(workspaceId, sourceThreadId, newThreadId);
      renamePendingMemoryCaptureKey(sourceThreadId, newThreadId);
      void renameThreadTitleMapping(workspaceId, sourceThreadId, newThreadId);
    },
    [
      dispatch,
      logSessionTrace,
      renameAutoTitlePendingKey,
      renameCustomNameKey,
      renamePendingMemoryCaptureKey,
      renameThreadTitleMapping,
      resolvePendingThreadForSession,
      resolvePendingThreadForTurn,
      migrateThreadInterruptGuards,
      getActiveTurnIdForThread,
      getThreadProviderProfileId,
      hasEstablishedThreadItems,
      pendingInterruptsRef,
      activeThreadId,
    ],
  );

  return {
    onThreadStarted,
    onTurnStarted,
    onTurnCompleted,
    onTurnPlanUpdated,
    onThreadTokenUsageUpdated,
    onAssistantRuntimeReceipt,
    onAccountRateLimitsUpdated,
    onTurnError,
    onTurnStalled,
    onContextCompacting,
    onContextCompacted,
    onContextCompactionFailed,
    onThreadSessionIdUpdated,
  };
}
