import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import type { ConversationItem, ThreadSummary } from "../../../types";
import {
  listThreads as listThreadsService,
  getOpenCodeSessionList as getOpenCodeSessionListService,
  loadClaudeSession as loadClaudeSessionService,
  loadGeminiSession as loadGeminiSessionService,
  loadGrokSession as loadGrokSessionService,
  loadKimiSession as loadKimiSessionService,
  loadDshSession as loadDshSessionService,
  loadPiSession as loadPiSessionService,
  loadQoderSession as loadQoderSessionService,
  resumeThread as resumeThreadService,
} from "../../../services/tauri";
import {
  buildItemsFromThread,
  getThreadTimestamp,
  isReviewingFromThread,
  mergeThreadItems,
  previewThreadName,
} from "../../../utils/threadItems";
import {
  extractClaudeHistoryTokenUsage,
  parseClaudeHistoryMessagesWithShadowRecovery,
  CLAUDE_UI_HISTORY_WINDOW,
} from "../loaders/claudeHistoryLoader";
import { parseGeminiHistoryMessages } from "../loaders/geminiHistoryParser";
import { parseGrokHistoryMessages } from "../loaders/grokHistoryParser";
import { parseKimiHistoryMessages } from "../loaders/kimiHistoryParser";
import {
  DSH_UI_HISTORY_WINDOW,
  extractDshHistoryCurrentModel,
  extractDshHistoryTodos,
  extractDshHistoryTokenUsage,
} from "../loaders/dshHistoryLoader";
import { seedDshComposerSelectionFromHost } from "../../../app-shell-parts/selectedComposerSession";
import { parseDshHistoryMessages } from "../loaders/dshHistoryParser";
import { parsePiHistoryMessages } from "../loaders/piHistoryParser";
import { parseQoderHistoryMessages } from "../loaders/qoderHistoryParser";
import { parseQoderSessionIdentity } from "../utils/qoderSessionIdentity";
import {
  hydrateHistory,
  mergeHistoryProjectionItems,
} from "../assembly/conversationAssembler";
import { asString } from "../utils/threadNormalize";
import {
  collectKnownCodexThreadIds,
  normalizeComparableWorkspacePath,
} from "./useThreadActions.workspacePath";
import {
  createThreadHistoryContinuationDecisionDebugEntry,
  createThreadHistoryReadableSurfaceDebugEntry,
} from "./useThreadActions.recoveryDiagnostics";
import {
  collectRelatedThreadIdsFromSnapshot,
  extractThreadSizeBytes,
  inferThreadEngineSource,
  isAskUserQuestionToolItem,
  shouldIncludeWorkspaceThreadEntry,
  isLocalSessionScanUnavailable,
  isTerminalToolStatus,
  isThreadResumeNotFoundError,
  isPendingThreadId,
  listReplacementThreadCandidates,
  mapWithConcurrency,
  mergeRecoveredThreadSummaries,
  resolveThreadSourceMeta,
  restoreThreadParentLinksFromSnapshot,
  selectRecoveredNewThreadDecision,
  selectReplacementThreadByMessageHistoryDecision,
  selectReplacementThreadDecision,
  shouldReplaceUserInputQueueFromSnapshot,
  type ThreadRecoveryDecision,
} from "./useThreadActions.helpers";
import {
  buildPartialHistoryDiagnostic,
  resolveThreadStabilityDiagnostic,
} from "../utils/stabilityDiagnostics";
import { isClaudeForkThreadId } from "../utils/claudeForkThread";
import { createThreadHistoryLoaderForThread } from "./useThreadActions.historyLoaderFactory";
import {
  RELATED_THREAD_LOAD_CONCURRENCY,
  THREAD_LIST_LOAD_OLDER_PAGE_SIZE,
  THREAD_RECOVERY_HISTORY_MATCH_CANDIDATES,
  THREAD_RECOVERY_MAX_FETCH_DURATION_MS,
  THREAD_RECOVERY_MAX_PAGES,
} from "./useThreadActions.threadList";
import { type UseThreadActionsOptions } from "./useThreadActions.types";
import type { HistoryLoadingProgress } from "../utils/historyLoadingProgress";
import {
  buildNativeHistoryFinalizeProgress,
  buildNativeHistoryHydrateProgress,
  yieldHistoryLoadingPaint,
} from "../utils/historyLoadingProgress";
import { runNativeHistoryOpenStages } from "../utils/runNativeHistoryOpenStages";
import { subscribeMappedDshHistoryLoadProgress } from "../utils/subscribeMappedDshHistoryLoadProgress";
import { dispatchThreadItemsProgressively } from "../utils/dispatchThreadItemsProgressively";
import {
  clearPendingOlderHistory,
  getPendingOlderHistory,
  rememberFullHistoryForWindow,
  replacePendingOlderHistoryItems,
} from "../utils/pendingOlderHistory";
import { setOlderHistoryRequester } from "../utils/olderHistoryRequestBridge";
import { createOlderHistoryRequester } from "../utils/createOlderHistoryRequester";
import { publishThreadDiskHistoryWindows } from "../utils/threadDiskHistoryWindowStore";
import { notifyOlderHistoryBeforePrepend } from "../utils/olderHistoryScrollRestoreBridge";

function buildHistorySnapshotPaintKey(snapshot: {
  threadId?: string;
  items: Array<{ id?: string }>;
}): string {
  const items = snapshot.items;
  return [
    snapshot.threadId ?? "",
    String(items.length),
    items[0]?.id ?? "",
    items[items.length - 1]?.id ?? "",
  ].join(":");
}

export type ResumeThreadForWorkspaceOptions = {
  preferLocalCodexHistory?: boolean;
};

type ResumeThreadForWorkspaceContext = UseThreadActionsOptions & {
  reconcileMissingClaudeThread: (
    workspaceId: string,
    threadId: string,
  ) => boolean;
  workspacePathsByIdRef: MutableRefObject<Record<string, string>>;
  latestThreadsByWorkspaceRef: MutableRefObject<
    Record<string, ThreadSummary[]>
  >;
  previousThreadsByWorkspaceRef: MutableRefObject<
    Record<string, ThreadSummary[]>
  >;
  setThreadHistoryRecoveryFailed: (threadId: string, failed: boolean) => void;
  setThreadHistoryLoading?: (threadId: string, isLoading: boolean) => void;
  setThreadHistoryLoadingProgress?: (
    threadId: string,
    progress: HistoryLoadingProgress | null,
  ) => void;
};

type ResumeThreadForWorkspaceCallback = (
  workspaceId: string,
  threadId: string,
  force?: boolean,
  replaceLocal?: boolean,
  options?: { preferLocalCodexHistory?: boolean },
) => Promise<string | null>;

export function useThreadActionsResumeThreadForWorkspace(
  deps: ResumeThreadForWorkspaceContext,
): ResumeThreadForWorkspaceCallback {
  const {
    activeThreadIdByWorkspace,
    applyCollabThreadLinksFromThread,
    dispatch: rawDispatch,
    getCustomName,
    itemsByThread,
    historyWindowByThread,
    tokenUsageByThread = {},
    loadedThreadsRef,
    onDebug,
    resolveCanonicalThreadId,
    rememberThreadAlias,
    clearThreadAlias,
    replaceOnResumeRef,
    reconcileMissingClaudeThread,
    resolveWorkspacePath,
    threadActivityRef,
    threadStatusById,
    threadsByWorkspace,
    updateThreadParent,
    userInputRequests,
    useUnifiedHistoryLoader = false,
    workspacePathsByIdRef,
    latestThreadsByWorkspaceRef,
    previousThreadsByWorkspaceRef,
    setThreadHistoryRecoveryFailed: rawSetThreadHistoryRecoveryFailed,
    setThreadHistoryLoading,
    setThreadHistoryLoadingProgress,
  } = deps;
  const resumeRequestGenerationByScopeRef = useRef<Record<string, number>>({});
  const automaticRecoveryFailedByScopeRef = useRef<Record<string, true>>({});
  // Late Shared projection merge must read the live canvas, not resume-start snapshot.
  const itemsByThreadRef = useRef(itemsByThread);
  itemsByThreadRef.current = itemsByThread;
  const threadStatusByIdRef = useRef(threadStatusById);
  threadStatusByIdRef.current = threadStatusById;
  const historyWindowByThreadRef = useRef(historyWindowByThread ?? {});
  historyWindowByThreadRef.current = historyWindowByThread ?? {};
  const threadsByWorkspaceRef = useRef(threadsByWorkspace);
  threadsByWorkspaceRef.current = threadsByWorkspace;
  const activeThreadIdByWorkspaceRef = useRef(activeThreadIdByWorkspace);
  activeThreadIdByWorkspaceRef.current = activeThreadIdByWorkspace;
  const olderHistoryInFlightByThreadRef = useRef(
    new Map<string, { cursor: string; epoch: number }>(),
  );
  const olderHistoryDiskPageEpochByThreadRef = useRef<Record<string, number>>(
    {},
  );

  useEffect(() => {
    publishThreadDiskHistoryWindows(historyWindowByThread);
  }, [historyWindowByThread]);

  useEffect(() => {
    const activeThreadIds = new Set(
      Object.values(activeThreadIdByWorkspace).filter(
        (threadId): threadId is string => Boolean(threadId),
      ),
    );
    for (const threadId of olderHistoryInFlightByThreadRef.current.keys()) {
      if (activeThreadIds.has(threadId)) {
        continue;
      }
      olderHistoryDiskPageEpochByThreadRef.current[threadId] =
        (olderHistoryDiskPageEpochByThreadRef.current[threadId] ?? 0) + 1;
      olderHistoryInFlightByThreadRef.current.delete(threadId);
    }
  }, [activeThreadIdByWorkspace]);

  useEffect(() => {
    const requester = createOlderHistoryRequester({
      dispatch: rawDispatch,
      getHistoryWindow: (targetThreadId) =>
        historyWindowByThreadRef.current[targetThreadId],
      resolveWorkspace: (targetThreadId) => {
        for (const [workspaceId, threads] of Object.entries(
          threadsByWorkspaceRef.current,
        )) {
          if (!threads.some((thread) => thread.id === targetThreadId)) {
            continue;
          }
          const workspacePath =
            workspacePathsByIdRef.current[workspaceId] ??
            resolveWorkspacePath?.(workspaceId) ??
            "";
          if (!workspacePath) {
            return null;
          }
          return { workspaceId, workspacePath };
        }
        for (const [workspaceId, activeThreadId] of Object.entries(
          activeThreadIdByWorkspaceRef.current,
        )) {
          if (activeThreadId !== targetThreadId) {
            continue;
          }
          const workspacePath =
            workspacePathsByIdRef.current[workspaceId] ??
            resolveWorkspacePath?.(workspaceId) ??
            "";
          if (!workspacePath) {
            return null;
          }
          return { workspaceId, workspacePath };
        }
        return null;
      },
      getDiskPageEpoch: (targetThreadId) =>
        olderHistoryDiskPageEpochByThreadRef.current[targetThreadId] ?? 0,
      inFlightByThread: olderHistoryInFlightByThreadRef.current,
      notifyBeforePrepend: notifyOlderHistoryBeforePrepend,
    });
    setOlderHistoryRequester(requester);
    return () => {
      setOlderHistoryRequester(null);
    };
  }, [rawDispatch, resolveWorkspacePath, workspacePathsByIdRef]);

  const resumeThreadForWorkspace = useCallback(
    async (
      workspaceId: string,
      threadId: string,
      force = false,
      replaceLocal = false,
      options?: ResumeThreadForWorkspaceOptions,
    ) => {
      if (!threadId) {
        return null;
      }
      const canonicalThreadId =
        resolveCanonicalThreadId?.(threadId) ?? threadId;
      const requestScopeKey = `${workspaceId}\u0000${canonicalThreadId}`;
      if (
        !force &&
        automaticRecoveryFailedByScopeRef.current[requestScopeKey]
      ) {
        onDebug?.({
          id: `${Date.now()}-client-thread-resume-skipped`,
          timestamp: Date.now(),
          source: "client",
          label: "thread/resume skipped",
          payload: {
            workspaceId,
            threadId: canonicalThreadId,
            reason: "automatic-history-recovery-failed",
          },
        });
        return canonicalThreadId;
      }
      if (force) {
        delete automaticRecoveryFailedByScopeRef.current[requestScopeKey];
        rawSetThreadHistoryRecoveryFailed(canonicalThreadId, false);
      }
      const requestGeneration =
        (resumeRequestGenerationByScopeRef.current[requestScopeKey] ?? 0) + 1;
      resumeRequestGenerationByScopeRef.current[requestScopeKey] =
        requestGeneration;
      const isCurrentResumeRequest = () =>
        resumeRequestGenerationByScopeRef.current[requestScopeKey] ===
        requestGeneration;
      const dispatch: typeof rawDispatch = (action) => {
        if (isCurrentResumeRequest()) {
          rawDispatch(action);
        }
      };
      const setThreadHistoryRecoveryFailed = (
        targetThreadId: string,
        failed: boolean,
      ) => {
        if (isCurrentResumeRequest()) {
          const targetCanonicalThreadId =
            resolveCanonicalThreadId?.(targetThreadId) ?? targetThreadId;
          const targetScopeKey = `${workspaceId}\u0000${targetCanonicalThreadId}`;
          if (failed) {
            automaticRecoveryFailedByScopeRef.current[targetScopeKey] = true;
          } else {
            delete automaticRecoveryFailedByScopeRef.current[targetScopeKey];
          }
          rawSetThreadHistoryRecoveryFailed(targetThreadId, failed);
        }
      };
      const setThreadLoaded = (targetThreadId: string, loaded: boolean) => {
        if (isCurrentResumeRequest()) {
          loadedThreadsRef.current[targetThreadId] = loaded;
        }
      };
      const applyHydratedItems = async (
        targetThreadId: string,
        items: ConversationItem[],
        options?: { mode?: "tail-first" | "atomic" },
      ) => {
        const result = await dispatchThreadItemsProgressively(
          dispatch,
          targetThreadId,
          items,
          {
            mode: options?.mode ?? "tail-first",
            shouldContinue: () => isCurrentResumeRequest(),
          },
        );
        if (!isCurrentResumeRequest()) {
          return false;
        }
        if (result.remainingOlderCount > 0) {
          rememberFullHistoryForWindow(
            targetThreadId,
            items,
            result.displayedCount,
          );
        } else {
          clearPendingOlderHistory(targetThreadId);
        }
        return true;
      };
      const localItems = itemsByThread[threadId] ?? [];
      if (isPendingThreadId(threadId) || isClaudeForkThreadId(threadId)) {
        setThreadLoaded(threadId, true);
        setThreadHistoryRecoveryFailed(threadId, false);
        onDebug?.({
          id: `${Date.now()}-client-thread-resume-skipped`,
          timestamp: Date.now(),
          source: "client",
          label: "thread/resume skipped",
          payload: {
            workspaceId,
            threadId,
            reason: isClaudeForkThreadId(threadId)
              ? "provisional-claude-fork"
              : "optimistic-pending-thread",
          },
        });
        return threadId;
      }
      const markHistoryRecoveryFailure = (
        targetThreadId: string,
        targetLocalItems: ConversationItem[],
        reasonCode: string,
        fallbackWarningCount = 0,
      ) => {
        setThreadLoaded(targetThreadId, false);
        setThreadHistoryRecoveryFailed(targetThreadId, true);
        onDebug?.(
          createThreadHistoryReadableSurfaceDebugEntry({
            workspaceId,
            threadId: targetThreadId,
            sourceThreadId: threadId,
            reopenOutcome:
              targetLocalItems.length > 0 ? "degraded-readable" : "failed",
            reasonCode:
              targetLocalItems.length > 0
                ? "last-good-local-items-preserved"
                : reasonCode,
            localItemCount: targetLocalItems.length,
            snapshotItemCount: 0,
            fallbackWarningCount,
          }),
        );
      };
      const status = threadStatusById[threadId];
      if (!force && status?.isProcessing && localItems.length > 0) {
        onDebug?.({
          id: `${Date.now()}-client-thread-resume-skipped`,
          timestamp: Date.now(),
          source: "client",
          label: "thread/resume skipped",
          payload: { workspaceId, threadId, reason: "active-turn" },
        });
        return threadId;
      }
      const shouldPreserveLocalClaudeRealtimeItems =
        !force &&
        threadId.startsWith("claude:") &&
        localItems.length > 0 &&
        !replaceLocal &&
        replaceOnResumeRef.current[threadId] !== true;
      if (shouldPreserveLocalClaudeRealtimeItems) {
        onDebug?.({
          id: `${Date.now()}-client-thread-resume-skipped`,
          timestamp: Date.now(),
          source: "client",
          label: "thread/resume skipped",
          payload: {
            workspaceId,
            threadId,
            reason: "local-claude-realtime-items",
          },
        });
        setThreadLoaded(threadId, true);
        // 本地实时消息保留时不重放历史，但应用重启后 token 用量 store 是空的
        //（消息来自持久化快照、用量不持久化），单独从历史 JSONL 回填一次。
        if (!tokenUsageByThread[threadId]) {
          const usageWorkspacePath =
            workspacePathsByIdRef.current[workspaceId] ??
            resolveWorkspacePath?.(workspaceId) ??
            "";
          const usageSessionId = threadId.slice("claude:".length);
          if (usageWorkspacePath && usageSessionId) {
            void loadClaudeSessionService(usageWorkspacePath, usageSessionId)
              .then((result) => {
                if (!isCurrentResumeRequest()) {
                  return;
                }
                const tokenUsage = extractClaudeHistoryTokenUsage(result);
                if (tokenUsage) {
                  dispatch({
                    type: "setThreadTokenUsage",
                    threadId,
                    tokenUsage,
                  });
                }
              })
              .catch((error) => {
                if (!isCurrentResumeRequest()) {
                  return;
                }
                onDebug?.({
                  id: `${Date.now()}-claude-history-usage-backfill-error`,
                  timestamp: Date.now(),
                  source: "error",
                  label: "thread/claude history usage backfill error",
                  payload: {
                    workspaceId,
                    threadId,
                    error:
                      error instanceof Error ? error.message : String(error),
                  },
                });
              });
          }
        }
        return threadId;
      }
      if (useUnifiedHistoryLoader) {
        // hydrateHistorySnapshot is assigned below; Shared soft-timeout merge calls it late.
        let phaseAPaintedSnapshotKey: string | null = null;
        let hydrateHistorySnapshot: (
          effectiveThreadId: string,
          snapshot: Awaited<
            ReturnType<
              ReturnType<typeof createThreadHistoryLoaderForThread>["load"]
            >
          >,
          options?: { mode?: "tail-first" | "atomic" },
        ) => Promise<boolean> = async () => false;

        const createHistoryLoader = (targetThreadId: string) =>
          createThreadHistoryLoaderForThread({
            targetThreadId,
            workspaceId,
            workspacePath:
              workspacePathsByIdRef.current[workspaceId] ??
              resolveWorkspacePath?.(workspaceId) ??
              null,
            providerProfileId:
              latestThreadsByWorkspaceRef.current[workspaceId]?.find(
                (thread) => thread.id === targetThreadId,
              )?.providerProfileId ??
              threadsByWorkspaceRef.current[workspaceId]?.find(
                (thread) => thread.id === targetThreadId,
              )?.providerProfileId ??
              null,
            preferLocalCodexHistory: options?.preferLocalCodexHistory === true,
            onHistoryProgress: setThreadHistoryLoadingProgress
              ? (progress) => {
                  if (!isCurrentResumeRequest()) {
                    return;
                  }
                  setThreadHistoryLoadingProgress(targetThreadId, progress);
                }
              : undefined,
            onSharedPhaseAReady: (phaseASnapshot) => {
              // V0 is enough to paint. Drop the blocking curtain before
              // projection starts or times out (D1). Empty V0 must not
              // hydrate during Phase-A — wait for the open path to finish
              // so we do not mark loaded before projection settles.
              if (!isCurrentResumeRequest()) {
                return;
              }
              // Stamp before the first await so load() cannot re-hydrate the
              // same V0 on the same turn (projection skip / fast return).
              if (phaseASnapshot.items.length > 0) {
                phaseAPaintedSnapshotKey =
                  buildHistorySnapshotPaintKey(phaseASnapshot);
              }
              void (async () => {
                if (phaseASnapshot.items.length > 0) {
                  await hydrateHistorySnapshot(
                    targetThreadId,
                    phaseASnapshot,
                  );
                }
                if (!isCurrentResumeRequest()) {
                  return;
                }
                setThreadHistoryLoading?.(targetThreadId, false);
              })();
            },
            onSharedProjectionMerged: (mergedSnapshot) => {
              // Recovery「已解锁」与 history projection 解耦：后台 merge 不得挡发送。
              // 仅在仍是本次 resume 且线程未在跑 live turn 时应用。
              if (!isCurrentResumeRequest()) {
                return;
              }
              if (threadStatusByIdRef.current[targetThreadId]?.isProcessing) {
                return;
              }
              // 用「缓存全量 ⊕ 迟到 projection」而不是整表从头刷。
              const liveItems =
                itemsByThreadRef.current[targetThreadId] ?? [];
              const cached = getPendingOlderHistory(targetThreadId);
              const baseItems = cached?.items ?? liveItems;
              const projectionItems = mergedSnapshot.items;
              const nextItems =
                baseItems.length > 0
                  ? mergeHistoryProjectionItems(
                      baseItems,
                      projectionItems,
                      {
                        workspaceId,
                        threadId: targetThreadId,
                        engine: mergedSnapshot.engine,
                      },
                    )
                  : projectionItems;
              if (cached) {
                const pending = replacePendingOlderHistoryItems(
                  targetThreadId,
                  nextItems,
                );
                if (pending) {
                  dispatch({
                    type: "setThreadItems",
                    threadId: targetThreadId,
                    items: nextItems.slice(-pending.displayedCount),
                  });
                  return;
                }
              }
              void hydrateHistorySnapshot(
                targetThreadId,
                {
                  ...mergedSnapshot,
                  items: nextItems,
                },
              );
            },
          });
        hydrateHistorySnapshot = async (
          effectiveThreadId: string,
          snapshot: Awaited<
            ReturnType<ReturnType<typeof createHistoryLoader>["load"]>
          >,
          options?: { mode?: "tail-first" | "atomic" },
        ) => {
          if (!isCurrentResumeRequest()) {
            return false;
          }
          const assembledSnapshot = hydrateHistory(snapshot);
          const snapshotItems = assembledSnapshot.items;
          const effectiveLocalItems =
            effectiveThreadId === threadId
              ? localItems
              : (itemsByThread[effectiveThreadId] ?? []);
          dispatch({
            type: "ensureThread",
            workspaceId,
            threadId: effectiveThreadId,
            engine: assembledSnapshot.meta.engine,
          });
          if (snapshot.fallbackWarnings.length > 0) {
            const partialHistoryDiagnostic = buildPartialHistoryDiagnostic(
              snapshot.fallbackWarnings
                .map((entry) => String(entry.code ?? "unknown"))
                .join(", "),
            );
            onDebug?.({
              id: `${Date.now()}-history-loader-fallback`,
              timestamp: Date.now(),
              source: "client",
              label: "thread/history fallback",
              payload: {
                workspaceId,
                threadId: effectiveThreadId,
                warnings: snapshot.fallbackWarnings,
                diagnosticCategory: partialHistoryDiagnostic.category,
                diagnosticMessage: partialHistoryDiagnostic.rawMessage,
              },
            });
          }
          if (snapshotItems.length === 0) {
            if (effectiveThreadId.startsWith("shared:")) {
              setThreadHistoryRecoveryFailed(effectiveThreadId, false);
              dispatch({
                type: "setThreadHistoryRestoredAt",
                threadId: effectiveThreadId,
                timestamp: assembledSnapshot.meta.historyRestoredAtMs,
              });
              onDebug?.(
                createThreadHistoryReadableSurfaceDebugEntry({
                  workspaceId,
                  threadId: effectiveThreadId,
                  sourceThreadId: threadId,
                  reopenOutcome: "recovered",
                  localItemCount: effectiveLocalItems.length,
                  snapshotItemCount: 0,
                  fallbackWarningCount: snapshot.fallbackWarnings.length,
                }),
              );
              setThreadLoaded(effectiveThreadId, true);
              return true;
            }
            markHistoryRecoveryFailure(
              effectiveThreadId,
              effectiveLocalItems,
              "history-hydrate-empty",
              snapshot.fallbackWarnings.length,
            );
            return false;
          }
          setThreadHistoryRecoveryFailed(effectiveThreadId, false);
          if (!effectiveThreadId.startsWith("shared:")) {
            setThreadHistoryLoadingProgress?.(
              effectiveThreadId,
              buildNativeHistoryHydrateProgress("start", snapshotItems.length),
            );
            await yieldHistoryLoadingPaint();
            if (!isCurrentResumeRequest()) {
              return false;
            }
          }
          const applied = await applyHydratedItems(
            effectiveThreadId,
            snapshotItems,
            { mode: options?.mode ?? "tail-first" },
          );
          if (!applied) {
            return false;
          }
          dispatch({
            type: "setThreadPlan",
            threadId: effectiveThreadId,
            plan: assembledSnapshot.plan,
          });
          dispatch({
            type: "setThreadHistoryRestoredAt",
            threadId: effectiveThreadId,
            timestamp: assembledSnapshot.meta.historyRestoredAtMs,
          });
          dispatch({
            type: "setThreadHistoryWindow",
            threadId: effectiveThreadId,
            hasMore: assembledSnapshot.meta.historyHasMore === true,
            nextCursor: assembledSnapshot.meta.historyNextCursor ?? null,
          });
          if (snapshot.tokenUsage) {
            dispatch({
              type: "setThreadTokenUsage",
              threadId: effectiveThreadId,
              tokenUsage: snapshot.tokenUsage,
            });
          }
          onDebug?.(
            createThreadHistoryReadableSurfaceDebugEntry({
              workspaceId,
              threadId: effectiveThreadId,
              sourceThreadId: threadId,
              reopenOutcome: "recovered",
              localItemCount: effectiveLocalItems.length,
              snapshotItemCount: snapshotItems.length,
              fallbackWarningCount: snapshot.fallbackWarnings.length,
            }),
          );
          const hasLocalPendingQueue = userInputRequests.some(
            (request) =>
              request.workspace_id === workspaceId &&
              request.params.thread_id === effectiveThreadId,
          );
          const hasLocalPendingAskTool = effectiveLocalItems.some(
            (item) =>
              isAskUserQuestionToolItem(item) &&
              !isTerminalToolStatus(item.status),
          );
          if (
            shouldReplaceUserInputQueueFromSnapshot(
              snapshotItems,
              assembledSnapshot.userInputQueue.length,
              hasLocalPendingQueue || hasLocalPendingAskTool,
            )
          ) {
            dispatch({
              type: "clearUserInputRequestsForThread",
              workspaceId,
              threadId: effectiveThreadId,
            });
          }
          restoreThreadParentLinksFromSnapshot(
            effectiveThreadId,
            snapshotItems,
            updateThreadParent,
          );
          const relatedThreadIds = collectRelatedThreadIdsFromSnapshot(
            effectiveThreadId,
            snapshotItems,
          );
          relatedThreadIds.forEach((relatedThreadId) => {
            dispatch({
              type: "ensureThread",
              workspaceId,
              threadId: relatedThreadId,
              engine: "codex",
            });
          });
          if (relatedThreadIds.length > 0) {
            onDebug?.({
              id: `${Date.now()}-history-loader-related-deferred`,
              timestamp: Date.now(),
              source: "client",
              label: "thread/history related deferred",
              payload: {
                workspaceId,
                threadId: effectiveThreadId,
                relatedThreadCount: relatedThreadIds.length,
              },
            });
          }
          assembledSnapshot.userInputQueue.forEach((request) => {
            dispatch({ type: "addUserInputRequest", request });
          });
          setThreadLoaded(effectiveThreadId, true);
          if (!effectiveThreadId.startsWith("shared:")) {
            setThreadHistoryLoadingProgress?.(
              effectiveThreadId,
              buildNativeHistoryFinalizeProgress(),
            );
          }
          return true;
        };
        // end hydrateHistorySnapshot assignment
        const loadHistorySnapshotWithBoundedEmptyRecovery = async (
          targetThreadId: string,
          initialSnapshot?: Awaited<
            ReturnType<ReturnType<typeof createHistoryLoader>["load"]>
          >,
        ) => {
          const firstSnapshot =
            initialSnapshot ??
            (await createHistoryLoader(targetThreadId).load(targetThreadId));
          if (!isCurrentResumeRequest()) {
            return firstSnapshot;
          }
          // Raw items already mean this snapshot is not an empty-loader miss.
          // Do not classify the full transcript just to decide whether to retry.
          if (firstSnapshot.items.length > 0) {
            return firstSnapshot;
          }
          if (targetThreadId.startsWith("shared:")) {
            return firstSnapshot;
          }
          onDebug?.({
            id: `${Date.now()}-history-loader-empty-retry`,
            timestamp: Date.now(),
            source: "client",
            label: "thread/history empty retry",
            payload: {
              workspaceId,
              threadId: targetThreadId,
              reasonCode: "history-empty-first-attempt",
            },
          });
          try {
            return await createHistoryLoader(targetThreadId).load(
              targetThreadId,
            );
          } catch (retryError) {
            if (!isCurrentResumeRequest()) {
              return firstSnapshot;
            }
            onDebug?.({
              id: `${Date.now()}-history-loader-empty-retry-error`,
              timestamp: Date.now(),
              source: "error",
              label: "thread/history empty retry error",
              payload: {
                workspaceId,
                threadId: targetThreadId,
                error:
                  retryError instanceof Error
                    ? retryError.message
                    : String(retryError),
              },
            });
            return firstSnapshot;
          }
        };
        const recoverReplacementThread = async (): Promise<{
          threadId: string;
          decision: ThreadRecoveryDecision;
          snapshot?: Awaited<
            ReturnType<ReturnType<typeof createHistoryLoader>["load"]>
          >;
        } | null> => {
          const existingSummaries =
            latestThreadsByWorkspaceRef.current[workspaceId] ??
            threadsByWorkspace[workspaceId] ??
            [];
          const recoveryBaselineSummaries =
            previousThreadsByWorkspaceRef.current[workspaceId] ??
            threadsByWorkspace[workspaceId] ??
            [];
          const staleSummary =
            existingSummaries.find((entry) => entry.id === threadId) ??
            (threadsByWorkspace[workspaceId] ?? []).find(
              (entry) => entry.id === threadId,
            );
          const engineSource = inferThreadEngineSource(threadId, staleSummary);
          const fallbackStaleActivityAt =
            (threadActivityRef.current[workspaceId] ?? {})[threadId] ?? 0;
          const effectiveStaleSummary =
            staleSummary ??
            (fallbackStaleActivityAt > 0
              ? {
                  id: threadId,
                  name: getCustomName(workspaceId, threadId) ?? "",
                  updatedAt: fallbackStaleActivityAt,
                  engineSource,
                  threadKind: "native",
                }
              : undefined);
          let nextSummaries = existingSummaries;
          let directRecoveredDecision: ThreadRecoveryDecision | null = null;
          if (engineSource === "codex") {
            const workspacePath = normalizeComparableWorkspacePath(
              workspacePathsByIdRef.current[workspaceId] ??
                resolveWorkspacePath?.(workspaceId) ??
                "",
            );
            if (workspacePath) {
              const activeThreadId =
                activeThreadIdByWorkspace[workspaceId] ?? "";
              const knownCodexThreadIds = collectKnownCodexThreadIds(
                existingSummaries,
                activeThreadId,
              );
              const matchingThreads: Record<string, unknown>[] = [];
              const recoveryStartedAt = Date.now();
              let pagesFetched = 0;
              let cursor: string | null = null;
              do {
                pagesFetched += 1;
                const response = (await listThreadsService(
                  workspaceId,
                  cursor,
                  // Recovery scans need larger pages than first-paint (5).
                  THREAD_LIST_LOAD_OLDER_PAGE_SIZE,
                )) as Record<string, unknown>;
                if (!isCurrentResumeRequest()) {
                  return null;
                }
                const result = (response.result ?? response) as Record<
                  string,
                  unknown
                >;
                const data = Array.isArray(result.data)
                  ? (result.data as Record<string, unknown>[])
                  : [];
                const allowKnownCodexWithoutCwd =
                  isLocalSessionScanUnavailable(result);
                matchingThreads.push(
                  ...data.filter((entry) =>
                    shouldIncludeWorkspaceThreadEntry(
                      entry,
                      workspacePath,
                      knownCodexThreadIds,
                      allowKnownCodexWithoutCwd,
                    ),
                  ),
                );
                cursor = (result.nextCursor ?? result.next_cursor ?? null) as
                  string | null;
                const replacementCandidate = selectReplacementThreadDecision({
                  staleThreadId: threadId,
                  staleSummary: effectiveStaleSummary,
                  summaries: mergeRecoveredThreadSummaries(
                    existingSummaries,
                    matchingThreads
                      .map((entry, index) => {
                        const id = asString(entry.id).trim();
                        const preview = asString(entry.preview).trim();
                        const customName = getCustomName(workspaceId, id);
                        const fallbackName = `Agent ${index + 1}`;
                        return {
                          id,
                          name: customName
                            ? customName
                            : preview.length > 0
                              ? previewThreadName(preview, fallbackName)
                              : fallbackName,
                          updatedAt: getThreadTimestamp(entry),
                          sizeBytes: extractThreadSizeBytes(entry),
                          engineSource: "codex" as const,
                          threadKind: "native" as const,
                          ...resolveThreadSourceMeta(entry),
                        } satisfies ThreadSummary;
                      })
                      .filter((entry) => entry.id),
                    "codex",
                  ),
                });
                if (
                  replacementCandidate.summary &&
                  (replacementCandidate.isPersistent || !cursor)
                ) {
                  break;
                }
                if (pagesFetched >= THREAD_RECOVERY_MAX_PAGES) {
                  break;
                }
                if (
                  Date.now() - recoveryStartedAt >=
                  THREAD_RECOVERY_MAX_FETCH_DURATION_MS
                ) {
                  break;
                }
              } while (cursor);
              const refreshedCodexSummaries = matchingThreads
                .map((entry, index) => {
                  const id = asString(entry.id).trim();
                  const preview = asString(entry.preview).trim();
                  const customName = getCustomName(workspaceId, id);
                  const fallbackName = `Agent ${index + 1}`;
                  return {
                    id,
                    name: customName
                      ? customName
                      : preview.length > 0
                        ? previewThreadName(preview, fallbackName)
                        : fallbackName,
                    updatedAt: getThreadTimestamp(entry),
                    sizeBytes: extractThreadSizeBytes(entry),
                    engineSource: "codex" as const,
                    threadKind: "native" as const,
                    ...resolveThreadSourceMeta(entry),
                  } satisfies ThreadSummary;
                })
                .filter((entry) => entry.id);
              directRecoveredDecision = selectRecoveredNewThreadDecision({
                staleThreadId: threadId,
                previousSummaries: recoveryBaselineSummaries,
                summaries: refreshedCodexSummaries,
                staleSummary: effectiveStaleSummary,
              });
              nextSummaries = mergeRecoveredThreadSummaries(
                existingSummaries,
                refreshedCodexSummaries,
                "codex",
              );
            }
          } else if (engineSource === "opencode") {
            const sessions = await getOpenCodeSessionListService(
              workspaceId,
            ).catch(() => []);
            if (!isCurrentResumeRequest()) {
              return null;
            }
            const refreshedOpenCodeSummaries = (
              Array.isArray(sessions) ? sessions : []
            )
              .map((session) => {
                const sessionUpdatedAt =
                  typeof session.updatedAt === "number" &&
                  Number.isFinite(session.updatedAt)
                    ? Math.max(0, session.updatedAt)
                    : 0;
                const id = `opencode:${session.sessionId}`;
                return {
                  id,
                  name:
                    getCustomName(workspaceId, id) ||
                    previewThreadName(session.title, "OpenCode Session"),
                  updatedAt: sessionUpdatedAt,
                  sizeBytes: extractThreadSizeBytes(
                    session as Record<string, unknown>,
                  ),
                  engineSource: "opencode" as const,
                  threadKind: "native" as const,
                } satisfies ThreadSummary;
              })
              .filter((entry) => entry.id);
            nextSummaries = mergeRecoveredThreadSummaries(
              existingSummaries,
              refreshedOpenCodeSummaries,
              "opencode",
            );
          }
          if (nextSummaries !== existingSummaries) {
            dispatch({
              type: "setThreads",
              workspaceId,
              threads: nextSummaries,
            });
            latestThreadsByWorkspaceRef.current = {
              ...latestThreadsByWorkspaceRef.current,
              [workspaceId]: nextSummaries,
            };
          }
          const summaryMatch = selectReplacementThreadDecision({
            staleThreadId: threadId,
            summaries: nextSummaries,
            staleSummary: effectiveStaleSummary,
          });
          if (summaryMatch.summary) {
            return {
              threadId: summaryMatch.summary.id,
              decision: summaryMatch,
            };
          }
          const newlyRecoveredMatch = selectRecoveredNewThreadDecision({
            staleThreadId: threadId,
            previousSummaries: recoveryBaselineSummaries,
            summaries: nextSummaries,
            staleSummary: effectiveStaleSummary,
          });
          if (newlyRecoveredMatch.summary) {
            return {
              threadId: newlyRecoveredMatch.summary.id,
              decision: newlyRecoveredMatch,
            };
          }
          if (directRecoveredDecision?.summary) {
            return {
              threadId: directRecoveredDecision.summary.id,
              decision: directRecoveredDecision,
            };
          }

          const staleItems = itemsByThread[threadId] ?? [];
          if (staleItems.length === 0) {
            return null;
          }

          const historyCandidates = listReplacementThreadCandidates({
            staleThreadId: threadId,
            summaries: nextSummaries,
            staleSummary,
          })
            .sort((left, right) => right.updatedAt - left.updatedAt)
            .slice(0, THREAD_RECOVERY_HISTORY_MATCH_CANDIDATES);
          if (historyCandidates.length === 0) {
            return null;
          }
          const historyCandidateById = new Map(
            historyCandidates.map((summary) => [summary.id, summary] as const),
          );

          const candidateSnapshots = await mapWithConcurrency(
            historyCandidates.map((summary) => summary.id),
            RELATED_THREAD_LOAD_CONCURRENCY,
            async (candidateThreadId) => {
              const summary = historyCandidateById.get(candidateThreadId);
              if (!summary) {
                return null;
              }
              try {
                const snapshot = await createHistoryLoader(summary.id).load(
                  summary.id,
                );
                if (!isCurrentResumeRequest()) {
                  return null;
                }
                return { summary, snapshot };
              } catch (candidateError) {
                if (!isCurrentResumeRequest()) {
                  return null;
                }
                const diagnostic = buildPartialHistoryDiagnostic(
                  candidateError instanceof Error
                    ? candidateError.message
                    : String(candidateError),
                );
                onDebug?.({
                  id: `${Date.now()}-history-loader-recovery-candidate-error`,
                  timestamp: Date.now(),
                  source: "error",
                  label: "thread/history recovery candidate error",
                  payload: {
                    workspaceId,
                    staleThreadId: threadId,
                    candidateThreadId: summary.id,
                    diagnosticCategory: diagnostic.category,
                    error:
                      candidateError instanceof Error
                        ? candidateError.message
                        : String(candidateError),
                  },
                });
                return null;
              }
            },
          );
          if (!isCurrentResumeRequest()) {
            return null;
          }
          const historyMatch = selectReplacementThreadByMessageHistoryDecision({
            staleThreadId: threadId,
            staleItems,
            candidates: candidateSnapshots
              .filter(
                (
                  candidate,
                ): candidate is {
                  summary: (typeof historyCandidates)[number];
                  snapshot: Awaited<
                    ReturnType<ReturnType<typeof createHistoryLoader>["load"]>
                  >;
                } => candidate !== null,
              )
              .map(({ summary, snapshot }) => ({
                summary,
                items: snapshot.items,
              })),
          });
          if (!historyMatch.summary) {
            return null;
          }
          const matchedSnapshot = candidateSnapshots.find(
            (candidate) => candidate?.summary.id === historyMatch.summary?.id,
          )?.snapshot;
          return {
            threadId: historyMatch.summary.id,
            decision: historyMatch,
            ...(matchedSnapshot ? { snapshot: matchedSnapshot } : {}),
          };
        };
        try {
          const snapshot =
            await loadHistorySnapshotWithBoundedEmptyRecovery(threadId);
          if (!isCurrentResumeRequest()) {
            return threadId;
          }
          if (
            phaseAPaintedSnapshotKey &&
            buildHistorySnapshotPaintKey(snapshot) === phaseAPaintedSnapshotKey
          ) {
            return threadId;
          }
          await hydrateHistorySnapshot(threadId, snapshot);
          if (!isCurrentResumeRequest()) {
            return threadId;
          }
          return threadId;
        } catch (error) {
          if (!isCurrentResumeRequest()) {
            return threadId;
          }
          if (threadId.startsWith("shared:")) {
            const diagnostic =
              error instanceof Error
                ? resolveThreadStabilityDiagnostic(error.message)
                : resolveThreadStabilityDiagnostic(String(error));
            onDebug?.({
              id: `${Date.now()}-shared-history-loader-error`,
              timestamp: Date.now(),
              source: "error",
              label: "thread/shared history loader error",
              payload: {
                workspaceId,
                threadId,
                error: error instanceof Error ? error.message : String(error),
                diagnosticCategory:
                  diagnostic?.category ?? "shared_projection_unavailable",
              },
            });
            setThreadLoaded(threadId, false);
            setThreadHistoryRecoveryFailed(threadId, false);
            return threadId;
          }
          if (isThreadResumeNotFoundError(error)) {
            try {
              const recoveredThread = await recoverReplacementThread();
              if (!isCurrentResumeRequest()) {
                return threadId;
              }
              if (recoveredThread) {
                const replacementThreadId = recoveredThread.threadId;
                const replacementSnapshot =
                  await loadHistorySnapshotWithBoundedEmptyRecovery(
                    replacementThreadId,
                    recoveredThread.snapshot,
                  );
                if (!isCurrentResumeRequest()) {
                  return threadId;
                }
                const replacementHydrated = await hydrateHistorySnapshot(
                  replacementThreadId,
                  replacementSnapshot,
                );
                if (!isCurrentResumeRequest()) {
                  return threadId;
                }
                if (!replacementHydrated) {
                  markHistoryRecoveryFailure(
                    threadId,
                    localItems,
                    "replacement-history-hydrate-empty",
                    replacementSnapshot.fallbackWarnings.length,
                  );
                  return threadId;
                }
                onDebug?.(
                  createThreadHistoryContinuationDecisionDebugEntry({
                    workspaceId,
                    staleThreadId: threadId,
                    replacementThreadId,
                    decision: recoveredThread.decision,
                  }),
                );
                dispatch({
                  type: "clearUserInputRequestsForThread",
                  workspaceId,
                  threadId,
                });
                setThreadLoaded(threadId, false);
                if (recoveredThread.decision.isPersistent) {
                  rememberThreadAlias?.(threadId, replacementThreadId);
                } else {
                  clearThreadAlias?.(threadId);
                }
                dispatch({
                  type: "setActiveThreadId",
                  workspaceId,
                  threadId: replacementThreadId,
                });
                onDebug?.({
                  id: `${Date.now()}-history-loader-recovered-thread-alias`,
                  timestamp: Date.now(),
                  source: "client",
                  label: "thread/history recovered stale thread",
                  payload: {
                    workspaceId,
                    staleThreadId: threadId,
                    replacementThreadId,
                    recoveryStrategy: recoveredThread.decision.strategy,
                    recoveryConfidence: recoveredThread.decision.confidence,
                    recoveryScoreGap: recoveredThread.decision.scoreGap,
                    recoveryReasonCode: recoveredThread.decision.reasonCode,
                    recoveryFeatureSignals:
                      recoveredThread.decision.featureSignals,
                    aliasPersisted: recoveredThread.decision.isPersistent,
                  },
                });
                return replacementThreadId;
              }
            } catch (recoveryError) {
              if (!isCurrentResumeRequest()) {
                return threadId;
              }
              const diagnostic = buildPartialHistoryDiagnostic(
                recoveryError instanceof Error
                  ? recoveryError.message
                  : String(recoveryError),
              );
              onDebug?.({
                id: `${Date.now()}-history-loader-recovery-error`,
                timestamp: Date.now(),
                source: "error",
                label: "thread/history recovery error",
                payload: {
                  diagnosticCategory: diagnostic.category,
                  error:
                    recoveryError instanceof Error
                      ? recoveryError.message
                      : String(recoveryError),
                },
              });
            }
          }
          const stabilityDiagnostic =
            error instanceof Error
              ? resolveThreadStabilityDiagnostic(error.message)
              : resolveThreadStabilityDiagnostic(String(error));
          onDebug?.({
            id: `${Date.now()}-history-loader-error`,
            timestamp: Date.now(),
            source: "error",
            label: "thread/history loader error",
            payload: {
              error: error instanceof Error ? error.message : String(error),
              diagnosticCategory:
                stabilityDiagnostic?.category ?? "partial_history",
              recoveryReason: stabilityDiagnostic?.reconnectReason ?? null,
            },
          });
          // Fallback to legacy path to preserve recovery.
        }
      }
      // Claude sessions don't use Codex thread/resume RPC —
      // load message history from JSONL and populate the thread
      const workspacePath =
        workspacePathsByIdRef.current[workspaceId] ??
        resolveWorkspacePath?.(workspaceId) ??
        "";
      if (threadId.startsWith("claude:")) {
        dispatch({
          type: "ensureThread",
          workspaceId,
          threadId,
          engine: "claude",
        });
        if (!workspacePath) {
          markHistoryRecoveryFailure(
            threadId,
            localItems,
            "history-workspace-path-missing",
          );
          return threadId;
        }
        if (force || !loadedThreadsRef.current[threadId]) {
          const realSessionId = threadId.slice("claude:".length);
          try {
            const result = await loadClaudeSessionService(
              workspacePath,
              realSessionId,
              { limit: CLAUDE_UI_HISTORY_WINDOW },
            );
            if (!isCurrentResumeRequest()) {
              return threadId;
            }
            const claudeRecord = result as {
              messages?: unknown;
              hasMore?: boolean;
              nextCursor?: string | null;
            };
            // Handle both new format { messages, usage } and old format (array)
            const messagesData = claudeRecord.messages ?? result;

            const items = parseClaudeHistoryMessagesWithShadowRecovery({
              messagesData,
              workspacePath,
              workspaceId,
              threadId,
            });
            if (items.length > 0) {
              setThreadHistoryRecoveryFailed(threadId, false);
              const appliedClaudeItems = await applyHydratedItems(
                threadId,
                items,
              );
              if (!appliedClaudeItems) {
                return threadId;
              }
              onDebug?.(
                createThreadHistoryReadableSurfaceDebugEntry({
                  workspaceId,
                  threadId,
                  reopenOutcome: "recovered",
                  snapshotItemCount: items.length,
                  localItemCount: localItems.length,
                }),
              );
            } else {
              markHistoryRecoveryFailure(
                threadId,
                localItems,
                "history-hydrate-empty",
              );
              return threadId;
            }
            dispatch({
              type: "setThreadHistoryRestoredAt",
              threadId,
              timestamp: Date.now(),
            });
            dispatch({
              type: "setThreadHistoryWindow",
              threadId,
              hasMore: claudeRecord.hasMore === true,
              nextCursor: claudeRecord.nextCursor ?? null,
            });

            // Dispatch usage data if available
            const restoredTokenUsage = extractClaudeHistoryTokenUsage(result);
            if (restoredTokenUsage) {
              dispatch({
                type: "setThreadTokenUsage",
                threadId,
                tokenUsage: restoredTokenUsage,
              });
            }
          } catch (error) {
            if (!isCurrentResumeRequest()) {
              return threadId;
            }
            const diagnostic =
              error instanceof Error
                ? resolveThreadStabilityDiagnostic(error.message)
                : resolveThreadStabilityDiagnostic(String(error));
            onDebug?.({
              id: `${Date.now()}-claude-history-load-error`,
              timestamp: Date.now(),
              source: "error",
              label: "thread/claude history load error",
              payload: {
                workspaceId,
                threadId,
                error: error instanceof Error ? error.message : String(error),
                diagnosticCategory: diagnostic?.category ?? "partial_history",
                reopenOutcome:
                  localItems.length > 0 ? "degraded-readable" : "failed",
              },
            });
            if (isThreadResumeNotFoundError(error)) {
              const preservedReadableSurface = reconcileMissingClaudeThread(
                workspaceId,
                threadId,
              );
              if (preservedReadableSurface) {
                markHistoryRecoveryFailure(
                  threadId,
                  localItems,
                  "history-load-failed",
                );
              } else {
                setThreadHistoryRecoveryFailed(threadId, false);
              }
              return preservedReadableSurface ? threadId : null;
            }
            markHistoryRecoveryFailure(
              threadId,
              localItems,
              "history-load-failed",
            );
            return threadId;
          }
        }
        setThreadLoaded(threadId, true);
        return threadId;
      }
      if (threadId.startsWith("opencode:")) {
        dispatch({
          type: "ensureThread",
          workspaceId,
          threadId,
          engine: "opencode",
        });
        setThreadLoaded(threadId, true);
        return threadId;
      }
      if (threadId.startsWith("gemini:")) {
        dispatch({
          type: "ensureThread",
          workspaceId,
          threadId,
          engine: "gemini",
        });
        if (!workspacePath) {
          markHistoryRecoveryFailure(
            threadId,
            localItems,
            "history-workspace-path-missing",
          );
          return threadId;
        }
        if (!loadedThreadsRef.current[threadId]) {
          const realSessionId = threadId.slice("gemini:".length);
          try {
            const result = await loadGeminiSessionService(
              workspacePath,
              realSessionId,
            );
            if (!isCurrentResumeRequest()) {
              return threadId;
            }
            const messagesData =
              (result as { messages?: unknown }).messages ?? result;
            const items = parseGeminiHistoryMessages(messagesData);
            if (items.length > 0) {
              setThreadHistoryRecoveryFailed(threadId, false);
              const appliedGeminiItems = await applyHydratedItems(
                threadId,
                items,
              );
              if (!appliedGeminiItems) {
                return threadId;
              }
            } else {
              markHistoryRecoveryFailure(
                threadId,
                localItems,
                "history-hydrate-empty",
              );
              return threadId;
            }
            dispatch({
              type: "setThreadHistoryRestoredAt",
              threadId,
              timestamp: Date.now(),
            });
          } catch {
            if (!isCurrentResumeRequest()) {
              return threadId;
            }
            markHistoryRecoveryFailure(
              threadId,
              localItems,
              "history-load-failed",
            );
            return threadId;
          }
        }
        setThreadLoaded(threadId, true);
        return threadId;
      }
      if (threadId.startsWith("grok:")) {
        dispatch({
          type: "ensureThread",
          workspaceId,
          threadId,
          engine: "grok",
        });
        if (workspacePath && !loadedThreadsRef.current[threadId]) {
          const realSessionId = threadId.slice("grok:".length);
          try {
            await runNativeHistoryOpenStages({
              report: (progress) => {
                if (!isCurrentResumeRequest()) {
                  return;
                }
                setThreadHistoryLoadingProgress?.(threadId, progress);
              },
              shouldContinue: isCurrentResumeRequest,
              load: () =>
                loadGrokSessionService(workspacePath, realSessionId),
              extractMessages: (payload) =>
                (payload as { messages?: unknown }).messages ?? payload,
              parse: parseGrokHistoryMessages,
              hydrate: async (items) => {
                if (items.length > 0) {
                  await applyHydratedItems(threadId, items);
                }
              },
            });
            if (!isCurrentResumeRequest()) {
              return threadId;
            }
            dispatch({
              type: "setThreadHistoryRestoredAt",
              threadId,
              timestamp: Date.now(),
            });
          } catch {
            // Failed to load Grok session history — not fatal
          }
        }
        loadedThreadsRef.current[threadId] = true;
        return threadId;
      }
      if (threadId.startsWith("kimi:")) {
        dispatch({
          type: "ensureThread",
          workspaceId,
          threadId,
          engine: "kimi",
        });
        if (workspacePath && !loadedThreadsRef.current[threadId]) {
          const realSessionId = threadId.slice("kimi:".length);
          try {
            await runNativeHistoryOpenStages({
              report: (progress) => {
                if (!isCurrentResumeRequest()) {
                  return;
                }
                setThreadHistoryLoadingProgress?.(threadId, progress);
              },
              shouldContinue: isCurrentResumeRequest,
              load: () =>
                loadKimiSessionService(workspacePath, realSessionId),
              extractMessages: (payload) =>
                (payload as { messages?: unknown }).messages ?? payload,
              parse: parseKimiHistoryMessages,
              hydrate: async (items) => {
                if (items.length > 0) {
                  await applyHydratedItems(threadId, items);
                }
              },
            });
            if (!isCurrentResumeRequest()) {
              return threadId;
            }
            dispatch({
              type: "setThreadHistoryRestoredAt",
              threadId,
              timestamp: Date.now(),
            });
          } catch {
            // Failed to load Kimi session history — not fatal
          }
        }
        loadedThreadsRef.current[threadId] = true;
        return threadId;
      }
      if (threadId.startsWith("dsh:")) {
        dispatch({
          type: "ensureThread",
          workspaceId,
          threadId,
          engine: "dsh",
        });
        if (workspacePath && !loadedThreadsRef.current[threadId]) {
          const realSessionId = threadId.slice("dsh:".length);
          const reportDshProgress = (progress: HistoryLoadingProgress) => {
            if (!isCurrentResumeRequest()) {
              return;
            }
            setThreadHistoryLoadingProgress?.(threadId, progress);
          };
          const stopPageProgress = subscribeMappedDshHistoryLoadProgress({
            threadId,
            hostSessionId: realSessionId,
            onProgress: reportDshProgress,
          });
          try {
            const staged = await runNativeHistoryOpenStages({
              report: reportDshProgress,
              shouldContinue: isCurrentResumeRequest,
              load: () =>
                loadDshSessionService(workspacePath, realSessionId, {
                  limit: DSH_UI_HISTORY_WINDOW,
                }),
              extractMessages: (payload) =>
                (payload as { messages?: unknown }).messages ?? payload,
              parse: parseDshHistoryMessages,
              hydrate: async (items) => {
                if (items.length > 0) {
                  await applyHydratedItems(threadId, items);
                }
              },
            });
            if (!isCurrentResumeRequest()) {
              return threadId;
            }
            const restoredCurrentModel = extractDshHistoryCurrentModel(
              staged?.result ?? null,
            );
            if (restoredCurrentModel) {
              seedDshComposerSelectionFromHost({
                workspaceId,
                threadId,
                catalogId: restoredCurrentModel.catalogId,
                effort: restoredCurrentModel.effort,
              });
            }
            const restoredTokenUsage = extractDshHistoryTokenUsage(
              staged?.result ?? null,
            );
            if (restoredTokenUsage) {
              dispatch({
                type: "setThreadTokenUsage",
                threadId,
                tokenUsage: restoredTokenUsage,
              });
            } else {
              const restoredTodos = extractDshHistoryTodos(staged?.result ?? null);
              if (restoredTodos !== undefined) {
                dispatch({
                  type: "setThreadDshTodos",
                  threadId,
                  todos: restoredTodos,
                });
              }
            }
            const dshWindow = staged?.result as
              | { hasMore?: boolean; nextCursor?: string | null }
              | null
              | undefined;
            dispatch({
              type: "setThreadHistoryWindow",
              threadId,
              hasMore: dshWindow?.hasMore === true,
              nextCursor: dshWindow?.nextCursor ?? null,
            });
            dispatch({
              type: "setThreadHistoryRestoredAt",
              threadId,
              timestamp: Date.now(),
            });
          } catch {
            // Failed to load DSH session history — not fatal
          } finally {
            stopPageProgress();
          }
        }
        loadedThreadsRef.current[threadId] = true;
        return threadId;
      }
      if (threadId.startsWith("pi:")) {
        dispatch({
          type: "ensureThread",
          workspaceId,
          threadId,
          engine: "pi",
        });
        if (workspacePath && !loadedThreadsRef.current[threadId]) {
          const realSessionId = threadId.slice("pi:".length);
          try {
            await runNativeHistoryOpenStages({
              report: (progress) => {
                if (!isCurrentResumeRequest()) {
                  return;
                }
                setThreadHistoryLoadingProgress?.(threadId, progress);
              },
              shouldContinue: isCurrentResumeRequest,
              load: () => loadPiSessionService(workspacePath, realSessionId),
              extractMessages: (payload) =>
                (payload as { messages?: unknown }).messages ?? payload,
              parse: parsePiHistoryMessages,
              hydrate: async (items) => {
                if (items.length > 0) {
                  await applyHydratedItems(threadId, items);
                }
              },
            });
            if (!isCurrentResumeRequest()) {
              return threadId;
            }
            dispatch({
              type: "setThreadHistoryRestoredAt",
              threadId,
              timestamp: Date.now(),
            });
          } catch {
            // Failed to load PI session history — not fatal
          }
        }
        loadedThreadsRef.current[threadId] = true;
        return threadId;
      }
      if (threadId.startsWith("qoder:")) {
        dispatch({
          type: "ensureThread",
          workspaceId,
          threadId,
          engine: "qoder",
        });
        if (workspacePath && !loadedThreadsRef.current[threadId]) {
          const storedQoderProviderProfileId =
            latestThreadsByWorkspaceRef.current[workspaceId]?.find(
              (thread) => thread.id === threadId,
            )?.providerProfileId ??
            threadsByWorkspaceRef.current[workspaceId]?.find(
              (thread) => thread.id === threadId,
            )?.providerProfileId ??
            null;
          const qoderIdentity = parseQoderSessionIdentity(
            threadId,
            storedQoderProviderProfileId,
          );
          if (!qoderIdentity) {
            // Embedded profile 与 stored owner 冲突时不回落到 Global，避免同 raw
            // id 的 Global/CN 历史被错误读取。
            loadedThreadsRef.current[threadId] = true;
            return threadId;
          }
          try {
            await runNativeHistoryOpenStages({
              report: (progress) => {
                if (!isCurrentResumeRequest()) {
                  return;
                }
                setThreadHistoryLoadingProgress?.(threadId, progress);
              },
              shouldContinue: isCurrentResumeRequest,
              load: () =>
                loadQoderSessionService(
                  workspacePath,
                  qoderIdentity.rawSessionId,
                  qoderIdentity.providerProfileId,
                ),
              extractMessages: (payload) =>
                (payload as { messages?: unknown }).messages ?? payload,
              parse: parseQoderHistoryMessages,
              hydrate: async (items) => {
                if (items.length > 0) {
                  await applyHydratedItems(threadId, items);
                }
              },
            });
            if (!isCurrentResumeRequest()) {
              return threadId;
            }
            dispatch({
              type: "setThreadHistoryRestoredAt",
              threadId,
              timestamp: Date.now(),
            });
          } catch {
            // Failed to load Qoder session history — not fatal
          }
        }
        loadedThreadsRef.current[threadId] = true;
        return threadId;
      }
      if (!force && loadedThreadsRef.current[threadId]) {
        return threadId;
      }
      if (
        status?.isProcessing &&
        loadedThreadsRef.current[threadId] &&
        !force
      ) {
        onDebug?.({
          id: `${Date.now()}-client-thread-resume-skipped`,
          timestamp: Date.now(),
          source: "client",
          label: "thread/resume skipped",
          payload: { workspaceId, threadId, reason: "active-turn" },
        });
        return threadId;
      }
      onDebug?.({
        id: `${Date.now()}-client-thread-resume`,
        timestamp: Date.now(),
        source: "client",
        label: "thread/resume",
        payload: { workspaceId, threadId },
      });
      try {
        const response = (await resumeThreadService(
          workspaceId,
          threadId,
        )) as Record<string, unknown> | null;
        if (!isCurrentResumeRequest()) {
          return threadId;
        }
        onDebug?.({
          id: `${Date.now()}-server-thread-resume`,
          timestamp: Date.now(),
          source: "server",
          label: "thread/resume response",
          payload: response,
        });
        const result = (response?.result ?? response) as Record<
          string,
          unknown
        > | null;
        const thread = (result?.thread ?? response?.thread ?? null) as Record<
          string,
          unknown
        > | null;
        if (thread) {
          dispatch({
            type: "ensureThread",
            workspaceId,
            threadId,
            engine: "codex",
          });
          applyCollabThreadLinksFromThread(threadId, thread);
          const items = buildItemsFromThread(thread);
          const localItems = itemsByThread[threadId] ?? [];
          const shouldReplace =
            replaceLocal || replaceOnResumeRef.current[threadId] === true;
          if (shouldReplace) {
            replaceOnResumeRef.current[threadId] = false;
          }
          if (localItems.length > 0 && !shouldReplace) {
            if (items.length === 0) {
              markHistoryRecoveryFailure(
                threadId,
                localItems,
                "history-hydrate-empty",
              );
              return threadId;
            }
            setThreadHistoryRecoveryFailed(threadId, false);
            dispatch({
              type: "setThreadHistoryRestoredAt",
              threadId,
              timestamp: Date.now(),
            });
            setThreadLoaded(threadId, true);
            return threadId;
          }
          const hasOverlap =
            items.length > 0 &&
            localItems.length > 0 &&
            items.some((item) =>
              localItems.some((local) => local.id === item.id),
            );
          const mergedItems =
            items.length > 0
              ? shouldReplace
                ? items
                : localItems.length > 0 && !hasOverlap
                  ? localItems
                  : mergeThreadItems(items, localItems)
              : localItems;
          if (mergedItems.length > 0) {
            setThreadHistoryRecoveryFailed(threadId, false);
            const appliedMergedItems = await applyHydratedItems(
              threadId,
              mergedItems,
            );
            if (!appliedMergedItems) {
              return threadId;
            }
          } else {
            markHistoryRecoveryFailure(
              threadId,
              localItems,
              "history-hydrate-empty",
            );
            return threadId;
          }
          dispatch({
            type: "setThreadHistoryRestoredAt",
            threadId,
            timestamp: Date.now(),
          });
          dispatch({
            type: "markReviewing",
            threadId,
            isReviewing: isReviewingFromThread(thread),
          });
          const preview = asString(thread?.preview ?? "");
          const customName = getCustomName(workspaceId, threadId);
          if (!customName && preview) {
            dispatch({
              type: "setThreadName",
              workspaceId,
              threadId,
              name: previewThreadName(preview, `Agent ${threadId.slice(0, 4)}`),
            });
          }
          const lastAgentMessage = [...mergedItems]
            .reverse()
            .find(
              (item) => item.kind === "message" && item.role === "assistant",
            ) as ConversationItem | undefined;
          const lastText =
            lastAgentMessage && lastAgentMessage.kind === "message"
              ? lastAgentMessage.text
              : preview;
          if (lastText) {
            dispatch({
              type: "setLastAgentMessage",
              threadId,
              text: lastText,
              timestamp: getThreadTimestamp(thread),
            });
          }
          setThreadLoaded(threadId, true);
          return threadId;
        }
        markHistoryRecoveryFailure(
          threadId,
          localItems,
          "history-response-missing",
        );
        return threadId;
      } catch (error) {
        if (!isCurrentResumeRequest()) {
          return threadId;
        }
        markHistoryRecoveryFailure(threadId, localItems, "history-load-failed");
        onDebug?.({
          id: `${Date.now()}-client-thread-resume-error`,
          timestamp: Date.now(),
          source: "error",
          label: "thread/resume error",
          payload: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
    [
      activeThreadIdByWorkspace,
      applyCollabThreadLinksFromThread,
      updateThreadParent,
      rawDispatch,
      getCustomName,
      itemsByThread,
      tokenUsageByThread,
      latestThreadsByWorkspaceRef,
      loadedThreadsRef,
      onDebug,
      clearThreadAlias,
      previousThreadsByWorkspaceRef,
      rememberThreadAlias,
      replaceOnResumeRef,
      reconcileMissingClaudeThread,
      resolveCanonicalThreadId,
      resolveWorkspacePath,
      threadActivityRef,
      threadStatusById,
      threadsByWorkspace,
      userInputRequests,
      useUnifiedHistoryLoader,
      workspacePathsByIdRef,
      rawSetThreadHistoryRecoveryFailed,
      setThreadHistoryLoading,
      setThreadHistoryLoadingProgress,
    ],
  );
  return resumeThreadForWorkspace;
}
