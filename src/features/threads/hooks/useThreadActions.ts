import { startTransition, useCallback, useMemo, useRef } from "react";
import {
  yieldIfInteractiveInputPending,
  yieldToInteractiveInput,
} from "../../../utils/interactiveMainThread";
import type { ThreadSummary, WorkspaceInfo } from "../../../types";
import {
  connectWorkspace as connectWorkspaceService,
  listThreadTitles as listThreadTitlesService,
  listThreads as listThreadsService,
  listClaudeSessions as listClaudeSessionsForFallbackSeedService,
  listGeminiSessions as listGeminiSessionsService,
  listGrokSessions as listGrokSessionsService,
  listKimiSessions as listKimiSessionsService,
  listPiSessions as listPiSessionsService,
  listQoderSessions as listQoderSessionsService,
  listDshSessions as listDshSessionsService,
  getOpenCodeSessionList as getOpenCodeSessionListService,
  listSessionIndexForWorkspace as listSessionIndexForWorkspaceService,
  rememberSessionIndexWorkspacePath,
} from "../../../services/tauri";
import {
  buildNativeIndexEarlyPaintSummaries,
  projectNativeIndexRowsToSummaries,
  shouldRememberHideUnreadiness,
} from "./useThreadActions.nativeIndexProjection";
import {
  expandVisibilityHideSet,
  isFullyVerifiedSharedNativeVisibility,
  isUsableSharedNativeVisibility,
  hasVerifiedSharedHide,
  lastVerifiedSharedHide,
  rememberVerifiedSharedHideIfComplete,
  strengthenVerifiedSharedHide,
  unionHideSets,
} from "./sharedNativeVisibility";
import * as tauriServices from "../../../services/tauri";
import {
  getThreadTimestamp,
  previewThreadName,
} from "../../../utils/threadItems";
import { listSharedSessions as listSharedSessionsService } from "../../shared-session/services/sharedSessions";
import {
  buildNativeOwnerToSharedThreadMap,
  expandHiddenSharedBindingIds,
  normalizeSharedSessionSummaries,
  remapThreadParentsToSharedOwners,
  toSharedThreadSummary,
} from "../../shared-session/runtime/sharedSessionSummaries";
import { getCollabWorkerNativeHideIds } from "../../multi-agent/runtime/collabNativeHideRegistry";
import { asString } from "../utils/threadNormalize";
import { sanitizeNativeSessionTitle } from "../utils/sessionDisplayProjection";
import { resolveMergedThreadCreatedAt } from "../utils/threadSummarySort";
import { clearLiveAssistantText } from "../utils/liveAssistantTextChannel";
import { clearLiveItemDelta } from "../utils/liveItemDeltaChannel";
import { resolveCodexSubagentIdentity } from "../utils/codexSubagentIdentity";
import { saveThreadActivity } from "../utils/threadStorage";
import {
  collectKnownCodexThreadIds,
  normalizeComparableWorkspacePath,
} from "./useThreadActions.workspacePath";
import {
  useAutomaticRuntimeRecovery,
  type AutomaticRuntimeRecoverySource,
} from "./useAutomaticRuntimeRecovery";
import {
  createArchiveClaudeThreadAction,
  createArchiveThreadAction,
  createDeleteThreadForWorkspaceAction,
  createRenameThreadTitleMappingAction,
} from "./useThreadActions.sessionActions";
import {
  buildHiddenAutomaticSessionIdSet,
  extractThreadSizeBytes,
  filterHiddenAutomaticThreadSummaries,
  isAutomaticHelperSessionTitle,
  filterRetainableContinuitySummaries,
  hasHealthyThreadSummaries,
  isLocalSessionScanUnavailable,
  isRetainableEngineContinuitySummary,
  isWorkspaceNotConnectedError,
  markThreadSummariesDegraded,
  mergeCodexCatalogSessionSummaries,
  mergeDegradedCodexContinuitySummaries,
  mergeDegradedClaudeContinuitySummaries,
  mergeGeminiSessionSummaries,
  mergeGrokSessionSummaries,
  mergeKimiSessionSummaries,
  mergePiSessionSummaries,
  mergeQoderSessionSummaries,
  mergeDshSessionSummaries,
  mergeThreadSummaryPreservingStableIdentity,
  normalizeGeminiSessionSummaries,
  normalizeGrokSessionSummaries,
  normalizeKimiSessionSummaries,
  normalizePiSessionSummaries,
  normalizeQoderSessionSummaries,
  normalizeDshSessionSummaries,
  normalizeThreadListPartialSource,
  resolveThreadSourceMeta,
  seedLastGoodClaudeIntoMerged,
  seedLastGoodOpenCodeIntoMerged,
  shouldIncludeWorkspaceThreadEntry,
  shouldApplyCodexSidebarContinuity,
  shouldApplyClaudeSidebarContinuity,
  isSharedCollabWorkerSpawnTitle,
  isSharedControlPlaneSpawnTitle,
  stripHiddenSharedBindingSummaries,
  threadIdInHiddenSharedBindingSet,
  threadIdMatchesHiddenAutomaticSessionSet,
  withTimeout,
  type GeminiSessionSummary,
  type GrokSessionSummary,
  type KimiSessionSummary,
  type QoderSessionSummary,
  type DshSessionSummary,
} from "./useThreadActions.helpers";
import {
  QODER_CN_PROVIDER_PROFILE_ID,
  QODER_GLOBAL_PROVIDER_PROFILE_ID,
} from "../constants/codexProviderProfiles";
import { canonicalQoderThreadId } from "../utils/qoderSessionIdentity";
import { buildPartialHistoryDiagnostic } from "../utils/stabilityDiagnostics";
import { buildThreadDebugCorrelation } from "../utils/threadDebugCorrelation";
import { useThreadActionsSessionRuntime } from "./useThreadActionsSessionRuntime";
import { useThreadActionsSessionCatalog } from "./useThreadActionsSessionCatalog";
import {
  applySessionArchiveState,
  useReconcileMissingClaudeThread,
} from "./useThreadActions.localState";
import { useThreadActionsResumeThreadForWorkspace } from "./useThreadActionsResumeThread";
import { useLoadOlderThreadsForWorkspace } from "./useThreadActionsLoadOlder";
import { useThreadHistoryLoadingState } from "./useThreadHistoryLoadingState";
import {
  GEMINI_SESSION_CACHE_TTL_MS,
  GEMINI_SESSION_FETCH_TIMEOUT_MS,
  GROK_SESSION_CACHE_TTL_MS,
  GROK_SESSION_FETCH_TIMEOUT_MS,
  KIMI_SESSION_CACHE_TTL_MS,
  KIMI_SESSION_FETCH_TIMEOUT_MS,
  DSH_SESSION_CACHE_TTL_MS,
  DSH_SESSION_FETCH_TIMEOUT_MS,
  PI_SESSION_CACHE_TTL_MS,
  PI_SESSION_FETCH_TIMEOUT_MS,
  QODER_SESSION_CACHE_TTL_MS,
  QODER_SESSION_FETCH_TIMEOUT_MS,
  NATIVE_SESSION_LIST_FETCH_TIMEOUT_MS,
  OPENCODE_FULL_CATALOG_FETCH_TIMEOUT_MS,
  THREAD_LIST_LIVE_REQUEST_TIMEOUT_MS,
  THREAD_LIST_MAX_EMPTY_PAGES,
  THREAD_LIST_MAX_EMPTY_PAGES_WITH_ACTIVITY,
  THREAD_LIST_MAX_FETCH_DURATION_MS,
  THREAD_LIST_MAX_TOTAL_PAGES,
  THREAD_LIST_PAGE_SIZE,
  countCatalogSessionsByEngine,
  countSummariesByEngine,
  resolveInitialThreadListTargetCount,
  resolveNativeSessionListLimit,
  resolveThreadListCursorForDisplay,
  type StartupThreadHydrationMode,
} from "./useThreadActions.threadList";
import {
  buildLastGoodSnapshotBlockedEngines,
  findCatalogSourceStatusForEngine,
  hasAuthoritativeCatalogMembershipProof,
  isIncompleteCatalogSourceStatus,
  resolveLastGoodFloorProjection,
  type ThreadEngineSource,
  type LastGoodThreadSummariesByEngine,
  useThreadActionsLastGoodSnapshots,
} from "./useThreadActions.lastGoodSnapshots";
import type { UseThreadActionsOptions } from "./useThreadActions.types";

export function useThreadActions({
  dispatch,
  itemsByThread,
  historyWindowByThread,
  tokenUsageByThread = {},
  userInputRequests,
  threadsByWorkspace,
  activeThreadIdByWorkspace,
  threadListCursorByWorkspace,
  threadStatusById,
  onDebug,
  getCustomName,
  threadActivityRef,
  loadedThreadsRef,
  replaceOnResumeRef,
  applyCollabThreadLinksFromThread,
  updateThreadParent,
  onThreadTitleMappingsLoaded,
  onRenameThreadTitleMapping,
  onCodexPendingThreadFinalized,
  resolveCanonicalThreadId,
  rememberThreadAlias,
  clearThreadAlias,
  resolveWorkspacePath,
  useUnifiedHistoryLoader = false,
  sessionAttributionMode = "related",
}: UseThreadActionsOptions) {
  const {
    historyLoadingByThreadId,
    historyLoadingProgressByThreadId,
    setThreadHistoryLoading,
    setThreadHistoryLoadingProgress,
    setThreadHistoryRecoveryFailed,
  } = useThreadHistoryLoadingState();
  // Map workspaceId → filesystem path, populated in listThreadsForWorkspace
  const workspacePathsByIdRef = useRef<Record<string, string>>({});
  const geminiSessionCacheRef = useRef<
    Record<string, { fetchedAt: number; sessions: GeminiSessionSummary[] }>
  >({});
  const geminiRefreshAttemptedRef = useRef<Record<string, boolean>>({});
  const kimiSessionCacheRef = useRef<
    Record<string, { fetchedAt: number; sessions: KimiSessionSummary[] }>
  >({});
  const kimiRefreshAttemptedRef = useRef<Record<string, boolean>>({});
  const piSessionCacheRef = useRef<
    Record<string, { fetchedAt: number; sessions: KimiSessionSummary[] }>
  >({});
  const piRefreshAttemptedRef = useRef<Record<string, boolean>>({});
  const qoderSessionCacheRef = useRef<
    Record<string, { fetchedAt: number; sessions: QoderSessionSummary[] }>
  >({});
  const qoderRefreshAttemptedRef = useRef<Record<string, boolean>>({});
  const grokSessionCacheRef = useRef<
    Record<string, { fetchedAt: number; sessions: GrokSessionSummary[] }>
  >({});
  const grokRefreshAttemptedRef = useRef<Record<string, boolean>>({});
  const dshSessionCacheRef = useRef<
    Record<string, { fetchedAt: number; sessions: DshSessionSummary[] }>
  >({});
  const dshRefreshAttemptedRef = useRef<Record<string, boolean>>({});
  const threadListRequestSeqRef = useRef<Record<string, number>>({});
  const lastGoodThreadSummariesByWorkspaceEngineRef = useRef<
    Record<string, LastGoodThreadSummariesByEngine>
  >({});
  const previousThreadsByWorkspaceRef = useRef(threadsByWorkspace);
  const latestThreadsByWorkspaceRef = useRef(threadsByWorkspace);
  if (latestThreadsByWorkspaceRef.current !== threadsByWorkspace) {
    previousThreadsByWorkspaceRef.current = latestThreadsByWorkspaceRef.current;
  }
  latestThreadsByWorkspaceRef.current = threadsByWorkspace;
  const listWorkspaceSessionsService = Object.prototype.hasOwnProperty.call(
    tauriServices,
    "listWorkspaceSessions",
  )
    ? tauriServices.listWorkspaceSessions
    : null;
  const canListWorkspaceSessions =
    typeof listWorkspaceSessionsService === "function";
  const listWorkspaceSessionArchiveEvidenceService =
    Object.prototype.hasOwnProperty.call(
      tauriServices,
      "listWorkspaceSessionArchiveEvidence",
    )
      ? tauriServices.listWorkspaceSessionArchiveEvidence
      : null;
  const { loadActiveProjectCatalogSessions, loadArchivedSessionMap } =
    useThreadActionsSessionCatalog({
      canListWorkspaceSessions,
      listWorkspaceSessionsService,
      listWorkspaceSessionArchiveEvidenceService,
    });
  const {
    beginAutomaticRuntimeRecovery,
    getAutomaticRuntimeRecoveryPartialSource,
  } = useAutomaticRuntimeRecovery(connectWorkspaceService);
  const {
    getLastGoodThreadSummaries,
    getLastGoodThreadSummariesForEngine,
    rememberLastGoodThreadSummariesByEngine,
    removeThreadFromCachedSummaries,
  } = useThreadActionsLastGoodSnapshots({
    latestThreadsByWorkspaceRef,
    previousThreadsByWorkspaceRef,
    lastGoodThreadSummariesByWorkspaceEngineRef,
    threadsByWorkspace,
  });

  const reconcileMissingClaudeThread = useReconcileMissingClaudeThread({
    activeThreadIdByWorkspace,
    dispatch,
    itemsByThread,
    loadedThreadsRef,
    onDebug,
    removeThreadFromCachedSummaries,
  });

  const renameThreadTitleMapping = useMemo(
    () =>
      createRenameThreadTitleMappingAction({
        getCustomName,
        onRenameThreadTitleMapping,
      }),
    [getCustomName, onRenameThreadTitleMapping],
  );

  const resumeThreadForWorkspace = useThreadActionsResumeThreadForWorkspace({
    activeThreadIdByWorkspace,
    applyCollabThreadLinksFromThread,
    dispatch,
    getCustomName,
    itemsByThread,
    historyWindowByThread,
    tokenUsageByThread,
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
    useUnifiedHistoryLoader,
    workspacePathsByIdRef,
    latestThreadsByWorkspaceRef,
    previousThreadsByWorkspaceRef,
    threadListCursorByWorkspace,
    setThreadHistoryRecoveryFailed,
    setThreadHistoryLoading,
    setThreadHistoryLoadingProgress,
  });

  const {
    startThreadForWorkspace,
    finalizeCodexPendingThread,
    startSharedSessionForWorkspace,
    forkThreadForWorkspace,
    forkClaudeSessionFromMessageForWorkspace,
    forkSessionFromMessageForWorkspace,
  } = useThreadActionsSessionRuntime({
    activeThreadIdByWorkspace,
    dispatch,
    itemsByThread,
    loadedThreadsRef,
    onCodexPendingThreadFinalized,
    onDebug,
    renameThreadTitleMapping,
    resumeThreadForWorkspace,
    threadsByWorkspace,
    workspacePathsByIdRef,
  });

  const refreshThread = useCallback(
    async (workspaceId: string, threadId: string) => {
      if (!threadId) {
        return null;
      }
      replaceOnResumeRef.current[threadId] = true;
      return resumeThreadForWorkspace(workspaceId, threadId, true, true);
    },
    [replaceOnResumeRef, resumeThreadForWorkspace],
  );

  const resetWorkspaceThreads = useCallback(
    (workspaceId: string) => {
      const threadIds = new Set<string>();
      const list = threadsByWorkspace[workspaceId] ?? [];
      list.forEach((thread) => threadIds.add(thread.id));
      const activeThread = activeThreadIdByWorkspace[workspaceId];
      if (activeThread) {
        threadIds.add(activeThread);
      }
      threadIds.forEach((threadId) => {
        loadedThreadsRef.current[threadId] = false;
      });
    },
    [activeThreadIdByWorkspace, loadedThreadsRef, threadsByWorkspace],
  );

  const listThreadsForWorkspace = useCallback(
    async (
      workspace: WorkspaceInfo,
      options?: {
        preserveState?: boolean;
        includeOpenCodeSessions?: boolean;
        /**
         * Opt-in engine disk `list_*` fan-out (Gemini/Grok/Kimi/PI).
         * Default false: sidebar hydrate uses Session Index.
         */
        includeEngineDiskLists?: boolean;
        deletedThreadIds?: string[];
        recoverySource?: AutomaticRuntimeRecoverySource;
        allowRuntimeReconnect?: boolean;
        startupHydrationMode?: StartupThreadHydrationMode;
        /**
         * Force Session Index writers to rescan (quiet soft re-sync after
         * first-paint). Default false so warm SQLite answers in ms.
         */
        forceSessionIndexSync?: boolean;
        /** Orchestrator cancel/stale flag — skip late setThreads after soft-ignore cancel. */
        isStale?: () => boolean;
        /** Importer refresh: merge SQLite rows onto the current list. */
        mergeExistingThreads?: boolean;
      },
    ) => {
      // Store workspace path for Claude session loading
      workspacePathsByIdRef.current[workspace.id] = workspace.path;
      rememberSessionIndexWorkspacePath(workspace.id, workspace.path);
      const requestSeq =
        (threadListRequestSeqRef.current[workspace.id] ?? 0) + 1;
      threadListRequestSeqRef.current[workspace.id] = requestSeq;
      const isLatestThreadListRequest = () =>
        threadListRequestSeqRef.current[workspace.id] === requestSeq &&
        !(options?.isStale?.() ?? false);
      // Runtime workspace switch (soft-ignore cancel): stop further IPC/merge
      // stages after isStale. In-flight single invoke may finish; no fan-out after.
      const abandonIfStale = (): { applied: false; stale: true } | null =>
        isLatestThreadListRequest() ? null : { applied: false, stale: true };
      const preserveState = options?.preserveState ?? false;
      const isFirstPaintHydration =
        options?.startupHydrationMode === "first-paint";
      // First-paint never fans out OpenCode/native multi-engine lists.
      const includeOpenCodeSessions =
        !isFirstPaintHydration && (options?.includeOpenCodeSessions ?? true);
      // Sidebar production never opts into disk lists. Tests / Session
      // management may still pass includeEngineDiskLists: true.
      const includeEngineDiskLists =
        !isFirstPaintHydration && options?.includeEngineDiskLists === true;
      const deletedThreadIds = [
        ...new Set(
          (options?.deletedThreadIds ?? [])
            .map((threadId) => threadId.trim())
            .filter(Boolean),
        ),
      ];
      const deletedThreadIdSet = new Set(deletedThreadIds);
      const filterDeletedSummaries = (summaries: ThreadSummary[]) =>
        deletedThreadIdSet.size === 0
          ? summaries
          : summaries.filter((summary) => !deletedThreadIdSet.has(summary.id));
      const filterRootVisibleAutomaticSummaries = (
        summaries: ThreadSummary[],
      ) =>
        summaries.filter(
          (summary) =>
            summary.autoSession?.visibility !== "hidden" &&
            !isAutomaticHelperSessionTitle(summary.name),
        );
      const getLastGoodThreadSummariesWithoutDeleted = () =>
        filterRootVisibleAutomaticSummaries(
          filterDeletedSummaries(getLastGoodThreadSummaries(workspace.id)),
        );
      const getLastGoodThreadSummariesForEngineWithoutDeleted = (
        engine: ThreadEngineSource,
      ) =>
        filterRootVisibleAutomaticSummaries(
          filterDeletedSummaries(
            getLastGoodThreadSummariesForEngine(workspace.id, engine),
          ),
        );
      const recoverySource = options?.recoverySource ?? "thread-list-live";
      const allowRuntimeReconnect = options?.allowRuntimeReconnect ?? true;
      let appliedThreadListUpdate = false;
      let visibleThreadCount = 0;
      let authoritativeEmpty = false;
      const workspacePath = normalizeComparableWorkspacePath(workspace.path);
      deletedThreadIds.forEach((threadId) => {
        loadedThreadsRef.current[threadId] = false;
        removeThreadFromCachedSummaries(workspace.id, threadId);
        clearLiveAssistantText(threadId);
        clearLiveItemDelta(threadId);
        dispatch({ type: "removeThread", workspaceId: workspace.id, threadId });
      });
      if (!preserveState) {
        dispatch({
          type: "setThreadListLoading",
          workspaceId: workspace.id,
          isLoading: true,
        });
        dispatch({
          type: "setThreadListCursor",
          workspaceId: workspace.id,
          cursor: null,
        });
      }
      onDebug?.({
        id: `${Date.now()}-client-thread-list`,
        timestamp: Date.now(),
        source: "client",
        label: "thread/list",
        payload: buildThreadDebugCorrelation(
          {
            workspaceId: workspace.id,
            action: "thread-list-refresh",
            engine: "multi",
          },
          { path: workspace.path },
        ),
      });
      const archivedSessionMapPromise = loadArchivedSessionMap(workspace.id);
      try {
        let degradedPartialSource: string | null = null;
        const partialSourcesSeen = new Set<string>();
        const rememberPartialSource = (value: unknown) => {
          const normalized = normalizeThreadListPartialSource(value);
          if (normalized) {
            partialSourcesSeen.add(normalized);
            if (!degradedPartialSource) {
              degradedPartialSource = normalized;
            }
          }
        };
        {
          const abandoned = abandonIfStale();
          if (abandoned) {
            return abandoned;
          }
        }
        // Session Index: list-level multi-engine source (SQLite).
        // CRITICAL UX: on first-paint, await index FIRST and paint immediately.
        // Do NOT wait for titles/shared/codex live list — that left the sidebar
        // stuck on stale sidebarSnapshot for seconds (user: old list → late correct).
        // One display page (20) per engine feeds the mixed top-20 view; older
        // rows arrive via keyset paging (sidebar 更多).
        const sessionIndexLimit = resolveInitialThreadListTargetCount(workspace);
        // Only explicit soft re-sync forces writers; cold first-paint must hit
        // warm SQLite (ms) so stale sidebarSnapshot is replaced immediately.
        const forceIndexSync = Boolean(options?.forceSessionIndexSync);
        const sessionIndexTimeoutMs = isFirstPaintHydration
          ? forceIndexSync
            ? 6_000
            : 2_500
          : NATIVE_SESSION_LIST_FETCH_TIMEOUT_MS;
        let sessionIndexPage: Awaited<
          ReturnType<typeof listSessionIndexForWorkspaceService>
        > | null = null;
        if (typeof listSessionIndexForWorkspaceService === "function") {
          sessionIndexPage = await withTimeout(
            listSessionIndexForWorkspaceService(workspace.id, {
              limit: sessionIndexLimit,
              // Warm SQLite should answer without rescan; force only soft re-sync.
              syncIfNeeded: !isFirstPaintHydration,
              forceSync: forceIndexSync,
            })
              .then((page) => page ?? null)
              .catch(() => null),
            sessionIndexTimeoutMs,
          );
          // First-paint 2.5s can expire if a writer is still running. Retry a
          // warm read so already-indexed native PI rows still reach the sidebar.
          if (
            sessionIndexPage === null &&
            isFirstPaintHydration &&
            !forceIndexSync
          ) {
            sessionIndexPage = await withTimeout(
              listSessionIndexForWorkspaceService(workspace.id, {
                limit: sessionIndexLimit,
                syncIfNeeded: false,
                forceSync: false,
              })
                .then((page) => page ?? null)
                .catch(() => null),
              800,
            );
          }
        }
        {
          const abandoned = abandonIfStale();
          if (abandoned) {
            return abandoned;
          }
        }
        // Progressive paint: replace stale snapshot ASAP with index rows.
        // Urgent dispatch (not startTransition) so WebView paints before heavy work.
        // Never paint ordinary native Index rows with an empty/unverified hide set.
        let earlyIndexPaintApplied = false;
        const indexVisibility = sessionIndexPage?.visibility ?? null;
        const visibilityHideSet = expandVisibilityHideSet(indexVisibility);
        const verifiedHideSet = lastVerifiedSharedHide(workspace.id);
        const canProjectIndexNatives =
          isUsableSharedNativeVisibility(indexVisibility) ||
          hasVerifiedSharedHide(workspace.id);
        const earlyPaintHideSet = unionHideSets(
          visibilityHideSet,
          verifiedHideSet,
          expandHiddenSharedBindingIds([...getCollabWorkerNativeHideIds()]),
        );
        rememberVerifiedSharedHideIfComplete(
          workspace.id,
          indexVisibility,
          earlyPaintHideSet,
        );
        if (
          isFirstPaintHydration &&
          !options?.mergeExistingThreads &&
          sessionIndexPage &&
          Array.isArray(sessionIndexPage.data) &&
          sessionIndexPage.data.length > 0
        ) {
          if (shouldRememberHideUnreadiness(canProjectIndexNatives)) {
            rememberPartialSource("shared-visibility-unavailable");
          }
          const earlyIndexSummaries = buildNativeIndexEarlyPaintSummaries({
            rows: sessionIndexPage.data,
            workspaceId: workspace.id,
            getCustomName,
            hideSet: earlyPaintHideSet,
            currentThreads: threadsByWorkspace[workspace.id],
            lastGood: getLastGoodThreadSummariesWithoutDeleted(),
            hideReady: canProjectIndexNatives,
          });
          if (earlyIndexSummaries.length > 0) {
            // Urgent early paint still yields one macrotask when a click is
            // pending — WebView2 hit-test starvation freezes harder than a
            // one-tick delay. Staleness is re-checked after the yield below.
            await yieldIfInteractiveInputPending();
          }
          if (earlyIndexSummaries.length > 0 && isLatestThreadListRequest()) {
            dispatch({
              type: "setThreads",
              workspaceId: workspace.id,
              threads: earlyIndexSummaries,
              unionMembership: true,
            });
            earlyIndexPaintApplied = true;
            appliedThreadListUpdate = true;
            onDebug?.({
              id: `${Date.now()}-client-session-index-early-paint`,
              timestamp: Date.now(),
              source: "client",
              label: "thread/list session-index early-paint",
              payload: {
                workspaceId: workspace.id,
                rowCount: earlyIndexSummaries.length,
                source: sessionIndexPage.source,
                syncMs: sessionIndexPage.syncMs ?? null,
                engines: sessionIndexPage.engines,
                visibilityAvailable: Boolean(indexVisibility?.available),
                hiddenCount: earlyPaintHideSet.size,
              },
            });
          }
        } else if (sessionIndexPage === null) {
          rememberPartialSource("session-index-timeout");
        }

        let mappedTitles: Record<string, string> = {};
        try {
          // Titles/shared must not hang the whole list path forever: orchestrator
          // timeout alone still leaves this promise running under soft-ignore.
          // Prefer shorter title timeout after early index paint.
          const titlesResult = await withTimeout(
            // Coerce null→{} before the race so withTimeout's null strictly
            // means "timed out" (invoke may legitimately resolve null).
            listThreadTitlesService(workspace.id).then((value) => value ?? {}),
            earlyIndexPaintApplied
              ? Math.min(NATIVE_SESSION_LIST_FETCH_TIMEOUT_MS, 4_000)
              : NATIVE_SESSION_LIST_FETCH_TIMEOUT_MS,
          );
          if (titlesResult === null) {
            mappedTitles = {};
            rememberPartialSource("thread-titles-timeout");
          } else {
            mappedTitles = titlesResult;
            onThreadTitleMappingsLoaded?.(workspace.id, mappedTitles);
          }
        } catch {
          mappedTitles = {};
        }
        {
          const abandoned = abandonIfStale();
          if (abandoned) {
            return abandoned;
          }
        }
        const sharedSessionsResult = await withTimeout(
          // Coerce null→[] so the null sentinel only means timeout (see above).
          listSharedSessionsService(workspace.id)
            .catch(() => [])
            .then((value) => value ?? []),
          NATIVE_SESSION_LIST_FETCH_TIMEOUT_MS,
        );
        if (sharedSessionsResult === null) {
          rememberPartialSource("shared-sessions-timeout");
        }
        {
          const abandoned = abandonIfStale();
          if (abandoned) {
            return abandoned;
          }
        }
        const sharedSessions = normalizeSharedSessionSummaries(
          sharedSessionsResult ?? [],
        );
        const hiddenSharedBindingIds = unionHideSets(
          expandHiddenSharedBindingIds([
            ...sharedSessions.flatMap((session) => session.nativeThreadIds),
            // 协作 worker realtime 登记的 native id（改名 Agent N 后仍能 strip）
            ...getCollabWorkerNativeHideIds(),
          ]),
          visibilityHideSet,
          verifiedHideSet,
        );
        if (isFullyVerifiedSharedNativeVisibility(indexVisibility)) {
          rememberVerifiedSharedHideIfComplete(
            workspace.id,
            indexVisibility,
            hiddenSharedBindingIds,
          );
        } else {
          strengthenVerifiedSharedHide(workspace.id, hiddenSharedBindingIds);
        }
        const nativeOwnerToSharedThreadId =
          buildNativeOwnerToSharedThreadMap(sharedSessions);
        const existingThreads = filterDeletedSummaries(
          threadsByWorkspace[workspace.id] ?? [],
        );
        const activeThreadId = activeThreadIdByWorkspace[workspace.id] ?? "";
        const knownCodexThreadIds = collectKnownCodexThreadIds(
          existingThreads,
          activeThreadId,
        );
        const engineById = new Map(
          existingThreads.map((thread) => [thread.id, thread.engineSource]),
        );
        const hasGeminiSignal =
          existingThreads.some(
            (thread) =>
              thread.engineSource === "gemini" ||
              thread.id.startsWith("gemini:") ||
              thread.id.startsWith("gemini-pending-"),
          ) ||
          activeThreadId.startsWith("gemini:") ||
          activeThreadId.startsWith("gemini-pending-") ||
          Object.keys(mappedTitles).some((id) => id.startsWith("gemini:"));
        const cachedGemini = geminiSessionCacheRef.current[workspace.id];
        const hasFreshGeminiCache =
          !!cachedGemini &&
          Date.now() - cachedGemini.fetchedAt <= GEMINI_SESSION_CACHE_TTL_MS;
        const hasKimiSignal =
          existingThreads.some(
            (thread) =>
              thread.engineSource === "kimi" ||
              thread.id.startsWith("kimi:") ||
              thread.id.startsWith("kimi-pending-"),
          ) ||
          activeThreadId.startsWith("kimi:") ||
          activeThreadId.startsWith("kimi-pending-") ||
          Object.keys(mappedTitles).some((id) => id.startsWith("kimi:"));
        const cachedKimi = kimiSessionCacheRef.current[workspace.id];
        const hasFreshKimiCache =
          !!cachedKimi &&
          Date.now() - cachedKimi.fetchedAt <= KIMI_SESSION_CACHE_TTL_MS;
        const hasPiSignal =
          existingThreads.some(
            (thread) =>
              thread.engineSource === "pi" ||
              thread.id.startsWith("pi:") ||
              thread.id.startsWith("pi-pending-"),
          ) ||
          activeThreadId.startsWith("pi:") ||
          activeThreadId.startsWith("pi-pending-") ||
          Object.keys(mappedTitles).some((id) => id.startsWith("pi:"));
        const cachedPi = piSessionCacheRef.current[workspace.id];
        const hasFreshPiCache =
          !!cachedPi &&
          Date.now() - cachedPi.fetchedAt <= PI_SESSION_CACHE_TTL_MS;
        const hasQoderSignal =
          existingThreads.some(
            (thread) =>
              thread.engineSource === "qoder" ||
              thread.id.startsWith("qoder:") ||
              thread.id.startsWith("qoder-pending-"),
          ) ||
          activeThreadId.startsWith("qoder:") ||
          activeThreadId.startsWith("qoder-pending-") ||
          Object.keys(mappedTitles).some((id) => id.startsWith("qoder:"));
        const cachedQoder = qoderSessionCacheRef.current[workspace.id];
        const hasFreshQoderCache =
          !!cachedQoder &&
          Date.now() - cachedQoder.fetchedAt <= QODER_SESSION_CACHE_TTL_MS;
        const hasGrokSignal =
          existingThreads.some(
            (thread) =>
              thread.engineSource === "grok" ||
              thread.id.startsWith("grok:") ||
              thread.id.startsWith("grok-pending-"),
          ) ||
          activeThreadId.startsWith("grok:") ||
          activeThreadId.startsWith("grok-pending-") ||
          Object.keys(mappedTitles).some((id) => id.startsWith("grok:"));
        const hasDshSignal =
          existingThreads.some(
            (thread) =>
              thread.engineSource === "dsh" ||
              thread.id.startsWith("dsh:") ||
              thread.id.startsWith("dsh-pending-"),
          ) ||
          activeThreadId.startsWith("dsh:") ||
          activeThreadId.startsWith("dsh-pending-") ||
          Object.keys(mappedTitles).some((id) => id.startsWith("dsh:"));
        const cachedGrok = grokSessionCacheRef.current[workspace.id];
        const hasFreshGrokCache =
          !!cachedGrok &&
          Date.now() - cachedGrok.fetchedAt <= GROK_SESSION_CACHE_TTL_MS;
        const cachedDsh = dshSessionCacheRef.current[workspace.id];
        const hasFreshDshCache =
          !!cachedDsh &&
          Date.now() - cachedDsh.fetchedAt <= DSH_SESSION_CACHE_TTL_MS;
        const knownActivityByThread =
          threadActivityRef.current[workspace.id] ?? {};
        const hasKnownActivity = Object.keys(knownActivityByThread).length > 0;
        const matchingThreads: Record<string, unknown>[] = [];
        // First paint: only the visible root budget (default 5). More via Load older.
        const targetCount = resolveInitialThreadListTargetCount(workspace);
        const pageSize = Math.max(THREAD_LIST_PAGE_SIZE, targetCount);
        const maxPagesWithoutMatch = hasKnownActivity
          ? THREAD_LIST_MAX_EMPTY_PAGES_WITH_ACTIVITY
          : THREAD_LIST_MAX_EMPTY_PAGES;
        let pagesFetched = 0;
        const fetchStartedAt = Date.now();
        let cursor: string | null = null;
        do {
          {
            const abandoned = abandonIfStale();
            if (abandoned) {
              return abandoned;
            }
          }
          pagesFetched += 1;
          let response: Record<string, unknown>;
          try {
            const liveResponse = await withTimeout(
              (async () => {
                try {
                  return await listThreadsService(
                    workspace.id,
                    cursor,
                    pageSize,
                  );
                } catch (error) {
                  if (
                    !isWorkspaceNotConnectedError(error) ||
                    !allowRuntimeReconnect
                  ) {
                    throw error;
                  }
                  const recovery = beginAutomaticRuntimeRecovery(
                    workspace.id,
                    recoverySource,
                  );
                  if (recovery.kind === "waiter") {
                    rememberPartialSource("guarded-recovery-waiter");
                    onDebug?.({
                      id: `${Date.now()}-client-workspace-recovery-waiter`,
                      timestamp: Date.now(),
                      source: "client",
                      label: "workspace/recovery waiter before thread list",
                      payload: buildThreadDebugCorrelation(
                        {
                          workspaceId: workspace.id,
                          action: "thread-list-refresh",
                          engine: "codex",
                          recoveryState: "degraded",
                        },
                        { recoverySource },
                      ),
                    });
                    throw error;
                  }
                  if (recovery.kind === "cooldown") {
                    rememberPartialSource("automatic-recovery-cooldown");
                    onDebug?.({
                      id: `${Date.now()}-client-workspace-recovery-cooldown`,
                      timestamp: Date.now(),
                      source: "client",
                      label: "workspace/recovery cooldown before thread list",
                      payload: buildThreadDebugCorrelation(
                        {
                          workspaceId: workspace.id,
                          action: "thread-list-refresh",
                          engine: "codex",
                          recoveryState: "degraded",
                        },
                        { recoverySource },
                      ),
                    });
                    throw error;
                  }
                  onDebug?.({
                    id: `${Date.now()}-client-workspace-reconnect-before-thread-list`,
                    timestamp: Date.now(),
                    source: "client",
                    label: "workspace/reconnect before thread list",
                    payload: buildThreadDebugCorrelation(
                      {
                        workspaceId: workspace.id,
                        action: "thread-list-refresh",
                        engine: "codex",
                        recoveryState: "recovering",
                      },
                      { recoverySource },
                    ),
                  });
                  await recovery.promise;
                  return await listThreadsService(
                    workspace.id,
                    cursor,
                    pageSize,
                  );
                }
              })(),
              THREAD_LIST_LIVE_REQUEST_TIMEOUT_MS,
            );
            if (liveResponse === null) {
              rememberPartialSource(
                getAutomaticRuntimeRecoveryPartialSource(workspace.id) ??
                  "thread-list-live-timeout",
              );
              onDebug?.({
                id: `${Date.now()}-client-thread-list-live-timeout`,
                timestamp: Date.now(),
                source: "error",
                label: "thread/list live timeout",
                payload: {
                  workspaceId: workspace.id,
                  cursor,
                  timeoutMs: THREAD_LIST_LIVE_REQUEST_TIMEOUT_MS,
                },
              });
              break;
            }
            response = liveResponse as Record<string, unknown>;
          } catch (error) {
            if (!isWorkspaceNotConnectedError(error)) {
              throw error;
            }
            rememberPartialSource("workspace-not-connected");
            onDebug?.({
              id: `${Date.now()}-client-thread-list-codex-unavailable`,
              timestamp: Date.now(),
              source: "client",
              label: "thread/list codex unavailable",
              payload: buildThreadDebugCorrelation(
                {
                  workspaceId: workspace.id,
                  action: "thread-list-codex-unavailable",
                  engine: "codex",
                  recoveryState: "recovering",
                },
                {
                  reason:
                    error instanceof Error ? error.message : String(error),
                },
              ),
            });
            break;
          }
          onDebug?.({
            id: `${Date.now()}-server-thread-list`,
            timestamp: Date.now(),
            source: "server",
            label: "thread/list response",
            payload: response,
          });
          const result = (response.result ?? response) as Record<
            string,
            unknown
          >;
          rememberPartialSource(result.partialSource ?? result.partial_source);
          const data = Array.isArray(result?.data)
            ? (result.data as Record<string, unknown>[])
            : [];
          const allowKnownCodexWithoutCwd =
            isLocalSessionScanUnavailable(result);
          const nextCursor = (result?.nextCursor ??
            result?.next_cursor ??
            null) as string | null;
          matchingThreads.push(
            ...data.filter((thread) =>
              shouldIncludeWorkspaceThreadEntry(
                thread,
                workspacePath,
                knownCodexThreadIds,
                allowKnownCodexWithoutCwd,
              ),
            ),
          );
          cursor = nextCursor;
          if (
            matchingThreads.length === 0 &&
            pagesFetched >= maxPagesWithoutMatch
          ) {
            onDebug?.({
              id: `${Date.now()}-client-thread-list-stop-empty-pages`,
              timestamp: Date.now(),
              source: "client",
              label: "thread/list stop",
              payload: {
                workspaceId: workspace.id,
                reason: "too-many-empty-pages",
                pagesFetched,
                maxPagesWithoutMatch,
              },
            });
            break;
          }
          if (pagesFetched >= THREAD_LIST_MAX_TOTAL_PAGES) {
            onDebug?.({
              id: `${Date.now()}-client-thread-list-stop-page-cap`,
              timestamp: Date.now(),
              source: "client",
              label: "thread/list stop",
              payload: {
                workspaceId: workspace.id,
                reason: "page-cap",
                pagesFetched,
                pageCap: THREAD_LIST_MAX_TOTAL_PAGES,
              },
            });
            break;
          }
          if (
            Date.now() - fetchStartedAt >=
            THREAD_LIST_MAX_FETCH_DURATION_MS
          ) {
            onDebug?.({
              id: `${Date.now()}-client-thread-list-stop-time-budget`,
              timestamp: Date.now(),
              source: "client",
              label: "thread/list stop",
              payload: {
                workspaceId: workspace.id,
                reason: "time-budget",
                pagesFetched,
                budgetMs: THREAD_LIST_MAX_FETCH_DURATION_MS,
              },
            });
            break;
          }
        } while (cursor && matchingThreads.length < targetCount);

        const uniqueById = new Map<string, Record<string, unknown>>();
        matchingThreads.forEach((thread) => {
          const id = String(thread?.id ?? "");
          if (id && !uniqueById.has(id)) {
            uniqueById.set(id, thread);
          }
        });
        const uniqueThreads = Array.from(uniqueById.values());
        const activityByThread = threadActivityRef.current[workspace.id] ?? {};
        const nextActivityByThread = { ...activityByThread };
        let didChangeActivity = false;
        uniqueThreads.forEach((thread) => {
          const threadId = String(thread?.id ?? "");
          if (!threadId) {
            return;
          }
          const timestamp = getThreadTimestamp(thread);
          if (timestamp > (nextActivityByThread[threadId] ?? 0)) {
            nextActivityByThread[threadId] = timestamp;
            didChangeActivity = true;
          }
        });
        uniqueThreads.sort((a, b) => {
          const aId = String(a?.id ?? "");
          const bId = String(b?.id ?? "");
          const aCreated = getThreadTimestamp(a);
          const bCreated = getThreadTimestamp(b);
          const aActivity = Math.max(nextActivityByThread[aId] ?? 0, aCreated);
          const bActivity = Math.max(nextActivityByThread[bId] ?? 0, bCreated);
          return bActivity - aActivity;
        });
        const summaries = uniqueThreads
          .slice(0, targetCount)
          .map((thread, index) => {
            const id = String(thread?.id ?? "");
            const preview = asString(thread?.preview ?? "").trim();
            const nativeTitle = sanitizeNativeSessionTitle(
              asString(thread?.nativeTitle ?? "").trim(),
            );
            const mappedTitle = mappedTitles[id];
            const customName = getCustomName(workspace.id, id) || mappedTitle;
            const liveIdentity = resolveCodexSubagentIdentity(id, thread);
            const fallbackName = `Agent ${index + 1}`;
            const name = customName
              ? customName
              : nativeTitle ||
                (liveIdentity.name ??
                  (preview.length > 0
                    ? previewThreadName(preview, fallbackName)
                    : fallbackName));
            const engineSource = engineById.get(id) ?? ("codex" as const);
            const sourceMeta = resolveThreadSourceMeta(thread);
            return {
              id,
              name,
              updatedAt: getThreadTimestamp(thread),
              sizeBytes: extractThreadSizeBytes(thread),
              engineSource,
              threadKind: "native" as const,
              folderId:
                typeof thread.folderId === "string" &&
                thread.folderId.trim().length > 0
                  ? thread.folderId.trim()
                  : null,
              ...sourceMeta,
              ...(liveIdentity.parentThreadId
                ? { parentThreadId: liveIdentity.parentThreadId }
                : {}),
            };
          })
          .filter(
            (entry) =>
              entry.id &&
              !threadIdInHiddenSharedBindingSet(
                entry.id,
                hiddenSharedBindingIds,
              ),
          );

        let allSummaries: ThreadSummary[] = summaries;
        const mergedById = new Map<string, ThreadSummary>();
        allSummaries.forEach((entry) => mergedById.set(entry.id, entry));
        const lastGoodThreadSummaries = getLastGoodThreadSummaries(
          workspace.id,
        );
        const nativeSessionListLimit = resolveNativeSessionListLimit(workspace);

        // Merge Session Index into live codex page (titles now available).
        // Early paint already showed index; this enrich names + keep live identity.
        {
          const abandoned = abandonIfStale();
          if (abandoned) {
            return abandoned;
          }
        }
        if (sessionIndexPage) {
          rememberPartialSource(sessionIndexPage.partialSource);
          const canMergeIndexNatives =
            isUsableSharedNativeVisibility(indexVisibility) ||
            hasVerifiedSharedHide(workspace.id);
          if (shouldRememberHideUnreadiness(canMergeIndexNatives)) {
            rememberPartialSource("shared-visibility-unavailable");
            getLastGoodThreadSummariesWithoutDeleted().forEach((summary) => {
              if (!mergedById.has(summary.id)) {
                mergedById.set(summary.id, summary);
              }
            });
          }
          const indexSummaries = projectNativeIndexRowsToSummaries(
            sessionIndexPage.data ?? [],
            {
              workspaceId: workspace.id,
              mappedTitles,
              getCustomName,
              hiddenSharedBindingIds,
            },
          );
          // Index is list authority for first-paint multi-engine membership:
          // seed missing engines and prefer newer timestamps.
          indexSummaries.forEach((summary) => {
            const prev = mergedById.get(summary.id);
            if (!prev) {
              mergedById.set(summary.id, summary);
              return;
            }
            if (summary.updatedAt >= prev.updatedAt) {
              mergedById.set(summary.id, {
                ...summary,
                name:
                  mappedTitles[summary.id] ||
                  getCustomName(workspace.id, summary.id) ||
                  prev.name ||
                  summary.name,
                folderId: prev.folderId ?? summary.folderId,
                autoSession: prev.autoSession ?? summary.autoSession,
                providerProfileId:
                  prev.providerProfileId ?? summary.providerProfileId,
                providerProfileName:
                  prev.providerProfileName ?? summary.providerProfileName,
                parentThreadId: prev.parentThreadId ?? summary.parentThreadId,
              });
            }
          });
          if (!earlyIndexPaintApplied) {
            onDebug?.({
              id: `${Date.now()}-client-session-index`,
              timestamp: Date.now(),
              source: "client",
              label: "thread/list session-index",
              payload: {
                workspaceId: workspace.id,
                source: sessionIndexPage.source,
                synced: sessionIndexPage.synced,
                syncMs: sessionIndexPage.syncMs,
                rowCount: sessionIndexPage.data?.length ?? 0,
                engines: sessionIndexPage.engines,
                partialSource: sessionIndexPage.partialSource ?? null,
                firstPaint: isFirstPaintHydration,
              },
            });
          }
        }

        // Yield so clicks queued during codex paging can run before catalog.
        // Must abandon BEFORE starting multi-engine fan-out (soft-ignore cancel).
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        {
          const abandoned = abandonIfStale();
          if (abandoned) {
            return abandoned;
          }
        }
        // Budget is applied inside getOpenCodeSessionList so command-cost trace
        // reflects the budget (not zombie IPC wall-clock after withTimeout).
        const opencodeSessionsPromise = includeOpenCodeSessions
          ? getOpenCodeSessionListService(workspace.id, {
              timeoutMs: OPENCODE_FULL_CATALOG_FETCH_TIMEOUT_MS,
            })
          : Promise.resolve(
              [] as Awaited<ReturnType<typeof getOpenCodeSessionListService>>,
            );
        // Cold-start first-paint: skip multi-engine project catalog + Claude
        // disk seed. Session Index already seeded Claude/Codex/Kimi above.
        // Full catalog remains for Session Management / explicit force refresh.
        const projectCatalogSessionsPromise =
          !isFirstPaintHydration && canListWorkspaceSessions
            ? loadActiveProjectCatalogSessions(
                workspace.id,
                sessionAttributionMode,
              )
            : Promise.resolve(null);
        const claudeSessionsPromise = isFirstPaintHydration
          ? Promise.resolve(
              null as Awaited<
                ReturnType<typeof listClaudeSessionsForFallbackSeedService>
              > | null,
            )
          : withTimeout(
              listClaudeSessionsForFallbackSeedService(
                workspace.path,
                nativeSessionListLimit,
              ),
              NATIVE_SESSION_LIST_FETCH_TIMEOUT_MS,
            );
        const [claudeResult, opencodeResult, projectCatalogResult] =
          await Promise.allSettled([
            claudeSessionsPromise,
            opencodeSessionsPromise,
            projectCatalogSessionsPromise,
          ]);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        {
          const abandoned = abandonIfStale();
          if (abandoned) {
            return abandoned;
          }
        }
        const projectCatalogValue =
          projectCatalogResult.status === "fulfilled"
            ? projectCatalogResult.value
            : null;
        const hiddenAutomaticSessionIds = buildHiddenAutomaticSessionIdSet(
          projectCatalogValue?.hiddenAutomaticSessionIds,
        );
        const catalogClaudeSourceStatus = findCatalogSourceStatusForEngine(
          projectCatalogValue?.sourceStatuses,
          "claude",
        );
        // Native Claude history is a legacy fallback/diagnostic seed here.
        // When catalog reports Claude source status, catalog projection owns
        // membership and native rows must not widen or erase that projection.
        const shouldMergeNativeClaudeSessions = !catalogClaudeSourceStatus;
        if (isIncompleteCatalogSourceStatus(catalogClaudeSourceStatus)) {
          rememberPartialSource(
            catalogClaudeSourceStatus?.reason ??
              `claude-${catalogClaudeSourceStatus?.completeness}`,
          );
        }
        const claudeSuccessfulEmpty =
          shouldMergeNativeClaudeSessions &&
          claudeResult.status === "fulfilled" &&
          Array.isArray(claudeResult.value) &&
          claudeResult.value.length === 0;
        if (claudeResult.status === "fulfilled") {
          if (shouldMergeNativeClaudeSessions && claudeResult.value === null) {
            rememberPartialSource("claude-session-timeout");
            onDebug?.({
              id: `${Date.now()}-client-claude-session-timeout`,
              timestamp: Date.now(),
              source: "client",
              label: "thread/list claude timeout",
              payload: {
                workspaceId: workspace.id,
                timeoutMs: NATIVE_SESSION_LIST_FETCH_TIMEOUT_MS,
              },
            });
            // 在 partial-source merge 之前先 seed last-good Claude 条目，
            // 避免下游 catalog merge / archive merge 因看到空 Claude 子源而形成残缺基底。
            // 即便下游 partial-source 路径被绕过或将来重构，最终列表也不会丢失 Claude 历史。
            seedLastGoodClaudeIntoMerged(
              mergedById,
              getLastGoodThreadSummariesForEngineWithoutDeleted("claude"),
              hiddenSharedBindingIds,
            );
          }
          const claudeSessions =
            shouldMergeNativeClaudeSessions && Array.isArray(claudeResult.value)
              ? claudeResult.value
              : [];
          claudeSessions.forEach(
            (session: {
              sessionId: string;
              firstMessage: string;
              nativeTitle?: string | null;
              createdAt?: number;
              updatedAt: number;
              fileSizeBytes?: number;
              parentSessionId?: string | null;
            }) => {
              const id = `claude:${session.sessionId}`;
              const parentThreadId = session.parentSessionId
                ? `claude:${session.parentSessionId}`
                : null;
              if (threadIdInHiddenSharedBindingSet(id, hiddenSharedBindingIds)) {
                return;
              }
              if (
                threadIdMatchesHiddenAutomaticSessionSet(
                  id,
                  hiddenAutomaticSessionIds,
                )
              ) {
                return;
              }
              // Shared/control-plane 内部 session：raw 首包或 nativeTitle 行首 MOSSX_*
              if (
                isSharedControlPlaneSpawnTitle(session.firstMessage) ||
                isSharedControlPlaneSpawnTitle(session.nativeTitle)
              ) {
                return;
              }
              if (
                isAutomaticHelperSessionTitle(session.firstMessage) ||
                isAutomaticHelperSessionTitle(session.nativeTitle)
              ) {
                return;
              }
              const prev = mergedById.get(id);
              const updatedAt = session.updatedAt;
              const createdAt = resolveMergedThreadCreatedAt(prev, {
                createdAt: session.createdAt,
                updatedAt,
              });
              const mappedTitle = mappedTitles[id];
              const customTitle = getCustomName(workspace.id, id);
              const nativeTitle = sanitizeNativeSessionTitle(
                asString(session.nativeTitle).trim(),
              );
              const previewName = previewThreadName(
                session.firstMessage,
                "Claude Session",
              );
              if (
                isSharedControlPlaneSpawnTitle(mappedTitle) ||
                isSharedControlPlaneSpawnTitle(previewName)
              ) {
                return;
              }
              const next: ThreadSummary = {
                id,
                name:
                  customTitle ||
                  mappedTitle ||
                  nativeTitle ||
                  previewName,
                updatedAt,
                ...(createdAt !== undefined ? { createdAt } : {}),
                sizeBytes: extractThreadSizeBytes(
                  session as Record<string, unknown>,
                ),
                engineSource: "claude",
                threadKind: "native",
                parentThreadId,
              };
              if (!prev || next.updatedAt >= prev.updatedAt) {
                mergedById.set(
                  id,
                  mergeThreadSummaryPreservingStableIdentity(prev, next, {
                    mappedTitle,
                    customTitle,
                    nativeTitle,
                  }),
                );
              }
            },
          );
        } else if (shouldMergeNativeClaudeSessions) {
          rememberPartialSource("claude-session-error");
          onDebug?.({
            id: `${Date.now()}-client-claude-session-error`,
            timestamp: Date.now(),
            source: "client",
            label: "thread/list claude error",
            payload: {
              workspaceId: workspace.id,
              error: String(claudeResult.reason ?? "unknown error"),
            },
          });
          // 同 timeout 路径：reject 时也 seed last-good Claude，确保兜底前置。
          seedLastGoodClaudeIntoMerged(
            mergedById,
            getLastGoodThreadSummariesForEngineWithoutDeleted("claude"),
            hiddenSharedBindingIds,
          );
        }
        if (opencodeResult.status === "fulfilled") {
          if (opencodeResult.value === null) {
            rememberPartialSource("opencode-session-timeout");
            onDebug?.({
              id: `${Date.now()}-client-opencode-session-timeout`,
              timestamp: Date.now(),
              source: "client",
              label: "thread/list opencode timeout",
              payload: {
                workspaceId: workspace.id,
                timeoutMs: NATIVE_SESSION_LIST_FETCH_TIMEOUT_MS,
              },
            });
            // 与 Claude timeout 分支对称：seed last-good OpenCode 条目，
            // 防止下游 catalog merge / archive merge 因看到空 OpenCode 子源而形成残缺基底。
            seedLastGoodOpenCodeIntoMerged(
              mergedById,
              getLastGoodThreadSummariesForEngineWithoutDeleted("opencode"),
              hiddenSharedBindingIds,
            );
          }
          const opencodeSessions = Array.isArray(opencodeResult.value)
            ? opencodeResult.value
            : [];
          opencodeSessions.forEach((session) => {
            const id = `opencode:${session.sessionId}`;
            if (threadIdInHiddenSharedBindingSet(id, hiddenSharedBindingIds)) {
              return;
            }
            if (
              threadIdMatchesHiddenAutomaticSessionSet(
                id,
                hiddenAutomaticSessionIds,
              )
            ) {
              return;
            }
            if (
              isSharedControlPlaneSpawnTitle(session.title) ||
              isSharedControlPlaneSpawnTitle(mappedTitles[id])
            ) {
              return;
            }
            if (isAutomaticHelperSessionTitle(session.title)) {
              return;
            }
            const prev = mergedById.get(id);
            const sessionUpdatedAt =
              typeof session.updatedAt === "number" &&
              Number.isFinite(session.updatedAt)
                ? Math.max(0, session.updatedAt)
                : 0;
            const updatedAt =
              sessionUpdatedAt ||
              nextActivityByThread[id] ||
              prev?.updatedAt ||
              0;
            if (updatedAt > (nextActivityByThread[id] ?? 0)) {
              nextActivityByThread[id] = updatedAt;
              didChangeActivity = true;
            }
            const previewName = previewThreadName(
              session.title,
              "OpenCode Session",
            );
            if (isSharedControlPlaneSpawnTitle(previewName)) {
              return;
            }
            const createdAt = resolveMergedThreadCreatedAt(prev, {
              updatedAt,
            });
            const next: ThreadSummary = {
              id,
              name:
                mappedTitles[id] ||
                getCustomName(workspace.id, id) ||
                previewName,
              updatedAt,
              ...(createdAt !== undefined ? { createdAt } : {}),
              sizeBytes: extractThreadSizeBytes(
                session as Record<string, unknown>,
              ),
              engineSource: "opencode",
              threadKind: "native",
            };
            if (!prev || next.updatedAt >= prev.updatedAt) {
              mergedById.set(
                id,
                mergeThreadSummaryPreservingStableIdentity(prev, next, {
                  mappedTitle: mappedTitles[id],
                  customTitle: getCustomName(workspace.id, id),
                }),
              );
            }
          });
        } else {
          // 与 Claude rejected 分支对称：补全此前缺失的 else，
          // 确保 OpenCode 子源抛错时仍发出可观测诊断并 seed last-good，避免静默吞错。
          rememberPartialSource("opencode-session-error");
          onDebug?.({
            id: `${Date.now()}-client-opencode-session-error`,
            timestamp: Date.now(),
            source: "client",
            label: "thread/list opencode error",
            payload: {
              workspaceId: workspace.id,
              error: String(opencodeResult.reason ?? "unknown error"),
            },
          });
          seedLastGoodOpenCodeIntoMerged(
            mergedById,
            getLastGoodThreadSummariesForEngineWithoutDeleted("opencode"),
            hiddenSharedBindingIds,
          );
        }
        if (projectCatalogResult.status === "fulfilled") {
          if (projectCatalogValue === null) {
            rememberPartialSource("codex-catalog-timeout");
            onDebug?.({
              id: `${Date.now()}-client-codex-catalog-timeout`,
              timestamp: Date.now(),
              source: "client",
              label: "thread/list codex catalog timeout",
              payload: {
                workspaceId: workspace.id,
                timeoutMs: NATIVE_SESSION_LIST_FETCH_TIMEOUT_MS,
              },
            });
          }
          rememberPartialSource(projectCatalogValue?.partialSource);
          const projectCatalogSessions = (
            projectCatalogValue?.sessions ?? []
          ).filter((entry) => {
            if (deletedThreadIdSet.has(entry.sessionId)) return false;
            if (
              threadIdInHiddenSharedBindingSet(
                entry.sessionId,
                hiddenSharedBindingIds,
              )
            ) {
              return false;
            }
            // 协作 worker multi-line MOSSX+squad（改名成 Agent N 之前）
            // 不用任意 MOSSX 单行，避免 Provider Continuation 被误杀
            if (
              isSharedCollabWorkerSpawnTitle(entry.title) ||
              isSharedCollabWorkerSpawnTitle(entry.nativeTitle)
            ) {
              return false;
            }
            return true;
          });
          if (claudeSuccessfulEmpty && projectCatalogValue?.partialSource) {
            onDebug?.({
              id: `${Date.now()}-client-claude-successful-empty-degraded`,
              timestamp: Date.now(),
              source: "client",
              label: "thread/list claude successful empty degraded",
              payload: {
                workspaceId: workspace.id,
                partialSource: projectCatalogValue.partialSource,
                lastGoodCount: lastGoodThreadSummaries.length,
                currentEngineCounts: countSummariesByEngine(
                  Array.from(mergedById.values()),
                ),
                catalogEngineCounts: countCatalogSessionsByEngine(
                  projectCatalogSessions,
                ),
              },
            });
          }
          allSummaries = mergeCodexCatalogSessionSummaries(
            Array.from(mergedById.values()).sort(
              (a, b) => b.updatedAt - a.updatedAt,
            ),
            projectCatalogSessions,
            workspace.id,
            mappedTitles,
            getCustomName,
            hiddenSharedBindingIds,
          );
          mergedById.clear();
          allSummaries.forEach((entry) => mergedById.set(entry.id, entry));
        } else {
          rememberPartialSource("codex-catalog-error");
        }
        if (!includeOpenCodeSessions) {
          existingThreads.forEach((thread) => {
            if (
              thread.threadKind === "shared" ||
              threadIdInHiddenSharedBindingSet(
                thread.id,
                hiddenSharedBindingIds,
              )
            ) {
              return;
            }
            const isOpenCodeThread =
              thread.engineSource === "opencode" ||
              thread.id.startsWith("opencode:") ||
              thread.id.startsWith("opencode-pending-");
            if (
              !isOpenCodeThread ||
              !isRetainableEngineContinuitySummary("opencode", thread)
            ) {
              return;
            }
            const prev = mergedById.get(thread.id);
            const threadUpdatedAt = Number.isFinite(thread.updatedAt)
              ? Math.max(0, thread.updatedAt)
              : 0;
            const updatedAt =
              threadUpdatedAt ||
              nextActivityByThread[thread.id] ||
              prev?.updatedAt ||
              0;
            if (updatedAt > (nextActivityByThread[thread.id] ?? 0)) {
              nextActivityByThread[thread.id] = updatedAt;
              didChangeActivity = true;
            }
            const next: ThreadSummary = {
              ...thread,
              updatedAt,
              engineSource: "opencode",
              threadKind: thread.threadKind ?? "native",
            };
            if (!prev || next.updatedAt >= prev.updatedAt) {
              mergedById.set(thread.id, next);
            }
          });
        }
        if (hasDshSignal) {
          existingThreads.forEach((thread) => {
            if (
              thread.threadKind === "shared" ||
              threadIdInHiddenSharedBindingSet(
                thread.id,
                hiddenSharedBindingIds,
              )
            ) {
              return;
            }
            const isDshThread =
              thread.engineSource === "dsh" ||
              thread.id.startsWith("dsh:") ||
              thread.id.startsWith("dsh-pending-");
            if (
              !isDshThread ||
              !isRetainableEngineContinuitySummary("dsh", thread)
            ) {
              return;
            }
            const prev = mergedById.get(thread.id);
            const threadUpdatedAt = Number.isFinite(thread.updatedAt)
              ? Math.max(0, thread.updatedAt)
              : 0;
            const updatedAt =
              threadUpdatedAt ||
              nextActivityByThread[thread.id] ||
              prev?.updatedAt ||
              0;
            if (updatedAt > (nextActivityByThread[thread.id] ?? 0)) {
              nextActivityByThread[thread.id] = updatedAt;
              didChangeActivity = true;
            }
            const next: ThreadSummary = {
              ...thread,
              updatedAt,
              engineSource: "dsh",
              threadKind: thread.threadKind ?? "native",
            };
            if (!prev || next.updatedAt >= prev.updatedAt) {
              mergedById.set(thread.id, next);
            }
          });
        }
        allSummaries = Array.from(mergedById.values()).sort(
          (a, b) => b.updatedAt - a.updatedAt,
        );
        if (hasFreshGeminiCache && cachedGemini.sessions.length > 0) {
          allSummaries = mergeGeminiSessionSummaries(
            allSummaries,
            cachedGemini.sessions.filter(
              (session) =>
                !threadIdInHiddenSharedBindingSet(
                  `gemini:${session.sessionId}`,
                  hiddenSharedBindingIds,
                ),
            ),
            workspace.id,
            mappedTitles,
            getCustomName,
            hiddenSharedBindingIds,
          );
        }
        if (hasFreshKimiCache && cachedKimi.sessions.length > 0) {
          allSummaries = mergeKimiSessionSummaries(
            allSummaries,
            cachedKimi.sessions.filter(
              (session) =>
                !threadIdInHiddenSharedBindingSet(
                  `kimi:${session.sessionId}`,
                  hiddenSharedBindingIds,
                ),
            ),
            workspace.id,
            mappedTitles,
            getCustomName,
            hiddenSharedBindingIds,
          );
        }
        if (hasFreshPiCache && cachedPi.sessions.length > 0) {
          allSummaries = mergePiSessionSummaries(
            allSummaries,
            cachedPi.sessions.filter(
              (session) =>
                !threadIdInHiddenSharedBindingSet(
                  `pi:${session.sessionId}`,
                  hiddenSharedBindingIds,
                ),
            ),
            workspace.id,
            mappedTitles,
            getCustomName,
            hiddenSharedBindingIds,
          );
        }
        if (hasFreshQoderCache && cachedQoder.sessions.length > 0) {
          allSummaries = mergeQoderSessionSummaries(
            allSummaries,
            cachedQoder.sessions.filter(
              (session) => {
                const threadId = canonicalQoderThreadId(
                  session.sessionId,
                  session.providerProfileId,
                );
                return (
                  !!threadId &&
                  !threadIdInHiddenSharedBindingSet(
                    threadId,
                    hiddenSharedBindingIds,
                  )
                );
              },
            ),
            workspace.id,
            mappedTitles,
            getCustomName,
            hiddenSharedBindingIds,
          );
        }
        if (hasFreshGrokCache && cachedGrok.sessions.length > 0) {
          allSummaries = mergeGrokSessionSummaries(
            allSummaries,
            cachedGrok.sessions.filter(
              (session) =>
                !threadIdInHiddenSharedBindingSet(
                  `grok:${session.sessionId}`,
                  hiddenSharedBindingIds,
                ),
            ),
            workspace.id,
            mappedTitles,
            getCustomName,
            nativeOwnerToSharedThreadId,
            hiddenSharedBindingIds,
          );
        }
        if (hasFreshDshCache && cachedDsh.sessions.length > 0) {
          allSummaries = mergeDshSessionSummaries(
            allSummaries,
            cachedDsh.sessions.filter(
              (session) =>
                !threadIdInHiddenSharedBindingSet(
                  `dsh:${session.sessionId}`,
                  hiddenSharedBindingIds,
                ),
            ),
            workspace.id,
            mappedTitles,
            getCustomName,
            hiddenSharedBindingIds,
          );
        }
        // fix-shared-session-target-race-and-merge T5b：
        // 仅当 list 空/失败（catch→[]）时，用 previous frame existingThreads 补回 shared:。
        // 非空 list 视为权威全集：不得把「已删除但不在 list 中」的 shared 复活。
        const existingSharedSummaries = existingThreads.filter((s) =>
          s.id.startsWith("shared:"),
        );
        if (sharedSessions.length > 0) {
          const sharedSummaries = sharedSessions.map(toSharedThreadSummary);
          const merged = new Map<string, ThreadSummary>();
          [...sharedSummaries, ...allSummaries].forEach((entry) => {
            const previous = merged.get(entry.id);
            if (!previous || entry.updatedAt >= previous.updatedAt) {
              merged.set(entry.id, entry);
            }
          });
          allSummaries = Array.from(merged.values()).sort(
            (a, b) => b.updatedAt - a.updatedAt,
          );
          // Shared 合并后再次 remap：兜底 cache miss / 其它路径写入的 parent
          allSummaries = remapThreadParentsToSharedOwners(
            allSummaries,
            nativeOwnerToSharedThreadId,
          );
        } else if (existingSharedSummaries.length > 0) {
          // 空 list（含 error→[]）：补回 previous shared，避免侧栏整段丢 Shared
          const mergedBack = new Map<string, ThreadSummary>();
          allSummaries.forEach((entry) => mergedBack.set(entry.id, entry));
          existingSharedSummaries.forEach((entry) => {
            if (!mergedBack.has(entry.id)) {
              mergedBack.set(entry.id, entry);
            }
          });
          allSummaries = Array.from(mergedBack.values()).sort(
            (a, b) => b.updatedAt - a.updatedAt,
          );
        }
        const archivedSessionMap = await archivedSessionMapPromise;
        rememberPartialSource(archivedSessionMap?.partialSource);
        if (didChangeActivity) {
          const next = {
            ...threadActivityRef.current,
            [workspace.id]: nextActivityByThread,
          };
          threadActivityRef.current = next;
          saveThreadActivity(next);
        }

        {
          const abandoned = abandonIfStale();
          if (abandoned) {
            return abandoned;
          }
        }

        const hasAuthoritativeEmptyCatalog =
          allSummaries.length === 0 &&
          !degradedPartialSource &&
          hasAuthoritativeCatalogMembershipProof(
            projectCatalogValue?.sourceStatuses,
          );
        const emptyListFallbackSource =
          allSummaries.length === 0 && !hasAuthoritativeEmptyCatalog
            ? (degradedPartialSource ?? "empty-thread-list")
            : null;
        const lastGoodFloor = resolveLastGoodFloorProjection({
          indexSummaries: allSummaries,
          lastGoodSummaries: [
            ...filterRetainableContinuitySummaries(
              getLastGoodThreadSummariesWithoutDeleted(),
              hiddenSharedBindingIds,
            ),
            ...(options?.mergeExistingThreads
              ? filterRetainableContinuitySummaries(
                  existingThreads,
                  hiddenSharedBindingIds,
                )
              : []),
          ],
          hasAuthoritativeEmptyCatalog,
          excludedThreadIds: hiddenSharedBindingIds,
        });
        let visibleSummaries = lastGoodFloor.visibleSummaries;
        let lastGoodSnapshotCandidates = lastGoodFloor.rememberCandidates;
        if (emptyListFallbackSource && visibleSummaries.length > 0) {
          visibleSummaries = markThreadSummariesDegraded(
            visibleSummaries,
            emptyListFallbackSource,
            "last-good-fallback",
          );
          const diagnostic = buildPartialHistoryDiagnostic(
            `thread list fallback: ${emptyListFallbackSource}`,
          );
          onDebug?.({
            id: `${Date.now()}-client-thread-list-fallback`,
            timestamp: Date.now(),
            source: "client",
            label: "thread/list fallback",
            payload: buildThreadDebugCorrelation(
              {
                workspaceId: workspace.id,
                action: "thread-list-fallback",
                engine: "multi",
                diagnosticCategory: diagnostic.category,
                recoveryState: "degraded",
              },
              {
                partialSource: emptyListFallbackSource,
                fallbackCount: visibleSummaries.length,
                diagnosticMessage: diagnostic.rawMessage,
              },
            ),
          });
        } else if (degradedPartialSource) {
          if (shouldApplyClaudeSidebarContinuity(degradedPartialSource)) {
            visibleSummaries = mergeDegradedClaudeContinuitySummaries(
              visibleSummaries,
              getLastGoodThreadSummariesForEngineWithoutDeleted("claude"),
              hiddenSharedBindingIds,
            );
          }
          if (shouldApplyCodexSidebarContinuity(degradedPartialSource)) {
            visibleSummaries = mergeDegradedCodexContinuitySummaries(
              visibleSummaries,
              getLastGoodThreadSummariesForEngineWithoutDeleted("codex"),
            );
          }
          lastGoodSnapshotCandidates = visibleSummaries;
          visibleSummaries = markThreadSummariesDegraded(
            visibleSummaries,
            degradedPartialSource,
            "partial-thread-list",
          );
        }
        visibleSummaries = applySessionArchiveState(
          filterRootVisibleAutomaticSummaries(
            filterHiddenAutomaticThreadSummaries(
              filterDeletedSummaries(visibleSummaries),
              hiddenAutomaticSessionIds,
            ),
          ),
          archivedSessionMap,
        );
        if (lastGoodSnapshotCandidates) {
          rememberLastGoodThreadSummariesByEngine(
            workspace.id,
            applySessionArchiveState(
              filterRootVisibleAutomaticSummaries(
                filterHiddenAutomaticThreadSummaries(
                  filterDeletedSummaries(lastGoodSnapshotCandidates),
                  hiddenAutomaticSessionIds,
                ),
              ),
              archivedSessionMap,
            ),
            buildLastGoodSnapshotBlockedEngines(
              projectCatalogValue?.sourceStatuses,
              partialSourcesSeen,
            ),
          );
        }

        // 最终 hide 闸门：任何路径（cache merge / continuity / last-good）
        // 都不得把 Shared-owned native binding 写进侧栏。
        visibleSummaries = stripHiddenSharedBindingSummaries(
          visibleSummaries,
          hiddenSharedBindingIds,
        );
        {
          const abandoned = abandonIfStale();
          if (abandoned) {
            return abandoned;
          }
        }
        // Prefer input over list commit: if user is clicking, wait a few frames.
        await yieldToInteractiveInput({ maxRounds: 32 });
        {
          const abandoned = abandonIfStale();
          if (abandoned) {
            return abandoned;
          }
        }
        const sessionIndexOldest = sessionIndexPage?.data?.length
          ? sessionIndexPage.data[sessionIndexPage.data.length - 1]
          : null;
        const cursorForDisplay = resolveThreadListCursorForDisplay({
          catalogCursor: projectCatalogValue?.nextCursor ?? null,
          catalogPartialSource: projectCatalogValue?.partialSource ?? null,
          runtimeCursor: cursor,
          sessionIndexHasMore: sessionIndexPage?.hasMore ?? false,
          sessionIndexOldestKey: sessionIndexOldest
            ? {
                updatedAt: Number(sessionIndexOldest.updatedAt) || 0,
                sessionId: String(sessionIndexOldest.sessionId ?? "").trim(),
              }
            : null,
        });
        const previewUpdates: Array<{
          threadId: string;
          text: string;
          timestamp: number;
        }> = [];
        uniqueThreads.forEach((thread) => {
          const threadId = String(thread?.id ?? "");
          const preview = asString(thread?.preview ?? "").trim();
          if (!threadId || !preview) {
            return;
          }
          previewUpdates.push({
            threadId,
            text: preview,
            timestamp: getThreadTimestamp(thread) ?? Date.now(),
          });
        });
        // After early index paint, final setThreads must still land promptly so
        // titles/shared/live codex enrichments show. Prefer urgent dispatch on
        // first-paint (user already waited for stale snapshot to clear).
        const applyFinalThreadList = () => {
          if (!isLatestThreadListRequest()) {
            return;
          }
          dispatch({
            type: "setThreads",
            workspaceId: workspace.id,
            threads: visibleSummaries,
            unionMembership:
              Boolean(options?.mergeExistingThreads) ||
              sessionIndexPage?.hasMore === true,
          });
          dispatch({
            type: "setThreadListCursor",
            workspaceId: workspace.id,
            cursor: cursorForDisplay,
          });
          previewUpdates.forEach((entry) => {
            dispatch({
              type: "setLastAgentMessage",
              threadId: entry.threadId,
              text: entry.text,
              timestamp: entry.timestamp,
            });
          });
        };
        if (isFirstPaintHydration || earlyIndexPaintApplied) {
          applyFinalThreadList();
        } else {
          startTransition(() => {
            applyFinalThreadList();
          });
        }
        appliedThreadListUpdate = true;
        visibleThreadCount = visibleSummaries.length;
        authoritativeEmpty = hasAuthoritativeEmptyCatalog;
        if (hasHealthyThreadSummaries(visibleSummaries)) {
          latestThreadsByWorkspaceRef.current = {
            ...latestThreadsByWorkspaceRef.current,
            [workspace.id]: visibleSummaries,
          };
        }

        const hasAttemptedGeminiRefresh =
          geminiRefreshAttemptedRef.current[workspace.id] === true;
        const shouldRefreshGeminiSessions =
          isLatestThreadListRequest() &&
          includeEngineDiskLists &&
          (hasGeminiSignal || !!cachedGemini || !hasAttemptedGeminiRefresh);
        if (shouldRefreshGeminiSessions) {
          void (async () => {
            geminiRefreshAttemptedRef.current[workspace.id] = true;
            const geminiResult = await withTimeout(
              listGeminiSessionsService(workspace.path, 50),
              GEMINI_SESSION_FETCH_TIMEOUT_MS,
            );
            if (!isLatestThreadListRequest()) {
              return;
            }
            if (geminiResult === null) {
              onDebug?.({
                id: `${Date.now()}-client-gemini-session-timeout`,
                timestamp: Date.now(),
                source: "client",
                label: "thread/list gemini timeout",
                payload: {
                  workspaceId: workspace.id,
                  timeoutMs: GEMINI_SESSION_FETCH_TIMEOUT_MS,
                },
              });
              return;
            }
            const normalizedGeminiSessions =
              normalizeGeminiSessionSummaries(geminiResult);
            geminiSessionCacheRef.current[workspace.id] = {
              fetchedAt: Date.now(),
              sessions: normalizedGeminiSessions,
            };
            const currentSnapshot =
              latestThreadsByWorkspaceRef.current[workspace.id] ?? [];
            const baselineSummaries =
              currentSnapshot.length > 0 ? currentSnapshot : allSummaries;
            // Gemini Shared 已退役，但仍走同一 hide 契约，避免 stale set 误注入。
            const sharedSessionsForGeminiHide = normalizeSharedSessionSummaries(
              (await withTimeout(
                listSharedSessionsService(workspace.id).catch(() => []),
                NATIVE_SESSION_LIST_FETCH_TIMEOUT_MS,
              )) ?? [],
            );
            if (!isLatestThreadListRequest()) {
              return;
            }
            // fresh ∪ outer：shared list 失败回空时不得放宽已有 hide 可见性。
            const freshHiddenSharedBindingIds = expandHiddenSharedBindingIds([
              ...sharedSessionsForGeminiHide.flatMap(
                (session) => session.nativeThreadIds,
              ),
              ...hiddenSharedBindingIds,
              ...getCollabWorkerNativeHideIds(),
            ]);
            const nextSummaries = mergeGeminiSessionSummaries(
              baselineSummaries,
              normalizedGeminiSessions.filter(
                (session) =>
                  !threadIdInHiddenSharedBindingSet(
                    `gemini:${session.sessionId}`,
                    freshHiddenSharedBindingIds,
                  ),
              ),
              workspace.id,
              mappedTitles,
              getCustomName,
              freshHiddenSharedBindingIds,
            );
            const visibleNextSummaries = applySessionArchiveState(
              stripHiddenSharedBindingSummaries(
                nextSummaries,
                freshHiddenSharedBindingIds,
              ),
              await archivedSessionMapPromise,
            );
            const unchanged =
              visibleNextSummaries.length === baselineSummaries.length &&
              visibleNextSummaries.every((entry, index) => {
                const prev = baselineSummaries[index];
                return (
                  !!prev &&
                  prev.id === entry.id &&
                  prev.name === entry.name &&
                  prev.updatedAt === entry.updatedAt &&
                  prev.engineSource === entry.engineSource &&
                  prev.threadKind === entry.threadKind
                );
              });
            if (!unchanged) {
              // Input-aware batch boundary: let a pending click land before
              // this commit, then re-verify freshness — a newer list request
              // (or soft-cancel) during the yield must win over this apply.
              await yieldIfInteractiveInputPending();
              if (!isLatestThreadListRequest()) {
                return;
              }
              dispatch({
                type: "setThreads",
                workspaceId: workspace.id,
                threads: visibleNextSummaries,
                unionMembership: true,
              });
              latestThreadsByWorkspaceRef.current = {
                ...latestThreadsByWorkspaceRef.current,
                [workspace.id]: visibleNextSummaries,
              };
            }
          })();
        }

        const hasAttemptedKimiRefresh =
          kimiRefreshAttemptedRef.current[workspace.id] === true;
        const shouldRefreshKimiSessions =
          isLatestThreadListRequest() &&
          includeEngineDiskLists &&
          (hasKimiSignal || !!cachedKimi || !hasAttemptedKimiRefresh);
        const hasAttemptedGrokRefresh =
          grokRefreshAttemptedRef.current[workspace.id] === true;
        const shouldRefreshGrokSessions =
          isLatestThreadListRequest() &&
          includeEngineDiskLists &&
          (hasGrokSignal || !!cachedGrok || !hasAttemptedGrokRefresh);
        const hasAttemptedDshRefresh =
          dshRefreshAttemptedRef.current[workspace.id] === true;
        // Sidebar first-paint / Index soft re-sync never probes DSH host.
        // Disk/host list is opt-in only (tests / Session Management).
        const shouldRefreshDshSessions =
          isLatestThreadListRequest() &&
          includeEngineDiskLists &&
          (hasDshSignal || !!cachedDsh || !hasAttemptedDshRefresh);
        if (shouldRefreshGrokSessions) {
          void (async () => {
            grokRefreshAttemptedRef.current[workspace.id] = true;
            const grokResult = await withTimeout(
              listGrokSessionsService(workspace.path, 50),
              GROK_SESSION_FETCH_TIMEOUT_MS,
            );
            if (!isLatestThreadListRequest()) {
              return;
            }
            if (grokResult === null) {
              onDebug?.({
                id: `${Date.now()}-client-grok-session-timeout`,
                timestamp: Date.now(),
                source: "client",
                label: "thread/list grok timeout",
                payload: {
                  workspaceId: workspace.id,
                  timeoutMs: GROK_SESSION_FETCH_TIMEOUT_MS,
                },
              });
              return;
            }
            const normalizedGrokSessions =
              normalizeGrokSessionSummaries(grokResult);
            grokSessionCacheRef.current[workspace.id] = {
              fetchedAt: Date.now(),
              sessions: normalizedGrokSessions,
            };
            const currentSnapshot =
              latestThreadsByWorkspaceRef.current[workspace.id] ?? [];
            const baselineSummaries =
              currentSnapshot.length > 0 ? currentSnapshot : allSummaries;
            // 异步 refresh 时 binding 可能已 materialize；必须重建 hide set，
            // 禁止复用 listThreads 开头的 stale 闭包（创建 Shared 时往往是空集）。
            const sharedSessionsForRemap = normalizeSharedSessionSummaries(
              (await withTimeout(
                listSharedSessionsService(workspace.id).catch(() => []),
                NATIVE_SESSION_LIST_FETCH_TIMEOUT_MS,
              )) ?? [],
            );
            if (!isLatestThreadListRequest()) {
              return;
            }
            // fresh ∪ outer：shared list 失败回空时不得放宽已有 hide 可见性。
            const freshHiddenSharedBindingIds = expandHiddenSharedBindingIds([
              ...sharedSessionsForRemap.flatMap((session) => session.nativeThreadIds),
              ...hiddenSharedBindingIds,
              ...getCollabWorkerNativeHideIds(),
            ]);
            const nativeOwnerToShared =
              buildNativeOwnerToSharedThreadMap(sharedSessionsForRemap);
            const nextSummaries = mergeGrokSessionSummaries(
              baselineSummaries,
              normalizedGrokSessions.filter(
                (session) =>
                  !threadIdInHiddenSharedBindingSet(
                    `grok:${session.sessionId}`,
                    freshHiddenSharedBindingIds,
                  ),
              ),
              workspace.id,
              mappedTitles,
              getCustomName,
              nativeOwnerToShared,
              freshHiddenSharedBindingIds,
            );
            const visibleNextSummaries = applySessionArchiveState(
              stripHiddenSharedBindingSummaries(
                nextSummaries,
                freshHiddenSharedBindingIds,
              ),
              await archivedSessionMapPromise,
            );
            const unchanged =
              visibleNextSummaries.length === baselineSummaries.length &&
              visibleNextSummaries.every((entry, index) => {
                const prev = baselineSummaries[index];
                return (
                  !!prev &&
                  prev.id === entry.id &&
                  prev.name === entry.name &&
                  prev.updatedAt === entry.updatedAt &&
                  prev.engineSource === entry.engineSource &&
                  prev.threadKind === entry.threadKind &&
                  (prev.parentThreadId ?? null) === (entry.parentThreadId ?? null)
                );
              });
            if (!unchanged) {
              // Input-aware batch boundary: let a pending click land before
              // this commit, then re-verify freshness — a newer list request
              // (or soft-cancel) during the yield must win over this apply.
              await yieldIfInteractiveInputPending();
              if (!isLatestThreadListRequest()) {
                return;
              }
              dispatch({
                type: "setThreads",
                workspaceId: workspace.id,
                threads: visibleNextSummaries,
                unionMembership: true,
              });
              latestThreadsByWorkspaceRef.current = {
                ...latestThreadsByWorkspaceRef.current,
                [workspace.id]: visibleNextSummaries,
              };
            }
          })();
        }
        if (shouldRefreshKimiSessions) {
          void (async () => {
            kimiRefreshAttemptedRef.current[workspace.id] = true;
            const kimiResult = await withTimeout(
              listKimiSessionsService(workspace.path, 50),
              KIMI_SESSION_FETCH_TIMEOUT_MS,
            );
            if (!isLatestThreadListRequest()) {
              return;
            }
            if (kimiResult === null) {
              onDebug?.({
                id: `${Date.now()}-client-kimi-session-timeout`,
                timestamp: Date.now(),
                source: "client",
                label: "thread/list kimi timeout",
                payload: {
                  workspaceId: workspace.id,
                  timeoutMs: KIMI_SESSION_FETCH_TIMEOUT_MS,
                },
              });
              return;
            }
            const normalizedKimiSessions =
              normalizeKimiSessionSummaries(kimiResult);
            kimiSessionCacheRef.current[workspace.id] = {
              fetchedAt: Date.now(),
              sessions: normalizedKimiSessions,
            };
            const currentSnapshot =
              latestThreadsByWorkspaceRef.current[workspace.id] ?? [];
            const baselineSummaries =
              currentSnapshot.length > 0 ? currentSnapshot : allSummaries;
            // 与 Grok 同构：异步路径用 fresh hide set，避免 pending→established
            // rebind 后仍按 list 开头的空/旧 hide set 注入 native 行。
            const sharedSessionsForKimiHide = normalizeSharedSessionSummaries(
              (await withTimeout(
                listSharedSessionsService(workspace.id).catch(() => []),
                NATIVE_SESSION_LIST_FETCH_TIMEOUT_MS,
              )) ?? [],
            );
            if (!isLatestThreadListRequest()) {
              return;
            }
            // fresh ∪ outer：shared list 失败回空时不得放宽已有 hide 可见性。
            const freshHiddenSharedBindingIds = expandHiddenSharedBindingIds([
              ...sharedSessionsForKimiHide.flatMap(
                (session) => session.nativeThreadIds,
              ),
              ...hiddenSharedBindingIds,
              ...getCollabWorkerNativeHideIds(),
            ]);
            const nativeOwnerToSharedKimi =
              buildNativeOwnerToSharedThreadMap(sharedSessionsForKimiHide);
            // 与 Grok 异步路径对齐：merge 后 parent-id 改挂 shared:（有 parent 才生效）
            const nextSummaries = remapThreadParentsToSharedOwners(
              mergeKimiSessionSummaries(
                baselineSummaries,
                normalizedKimiSessions.filter(
                  (session) =>
                    !threadIdInHiddenSharedBindingSet(
                      `kimi:${session.sessionId}`,
                      freshHiddenSharedBindingIds,
                    ),
                ),
                workspace.id,
                mappedTitles,
                getCustomName,
                freshHiddenSharedBindingIds,
              ),
              nativeOwnerToSharedKimi,
            );
            const visibleNextSummaries = applySessionArchiveState(
              stripHiddenSharedBindingSummaries(
                nextSummaries,
                freshHiddenSharedBindingIds,
              ),
              await archivedSessionMapPromise,
            );
            const unchanged =
              visibleNextSummaries.length === baselineSummaries.length &&
              visibleNextSummaries.every((entry, index) => {
                const prev = baselineSummaries[index];
                return (
                  !!prev &&
                  prev.id === entry.id &&
                  prev.name === entry.name &&
                  prev.updatedAt === entry.updatedAt &&
                  prev.engineSource === entry.engineSource &&
                  prev.threadKind === entry.threadKind &&
                  (prev.parentThreadId ?? null) === (entry.parentThreadId ?? null)
                );
              });
            if (!unchanged) {
              // Input-aware batch boundary: let a pending click land before
              // this commit, then re-verify freshness — a newer list request
              // (or soft-cancel) during the yield must win over this apply.
              await yieldIfInteractiveInputPending();
              if (!isLatestThreadListRequest()) {
                return;
              }
              dispatch({
                type: "setThreads",
                workspaceId: workspace.id,
                threads: visibleNextSummaries,
                unionMembership: true,
              });
              latestThreadsByWorkspaceRef.current = {
                ...latestThreadsByWorkspaceRef.current,
                [workspace.id]: visibleNextSummaries,
              };
            }
          })();
        }
        if (shouldRefreshDshSessions) {
          void (async () => {
            dshRefreshAttemptedRef.current[workspace.id] = true;
            const dshResult = await withTimeout(
              listDshSessionsService(workspace.path, 50),
              DSH_SESSION_FETCH_TIMEOUT_MS,
            );
            if (!isLatestThreadListRequest()) {
              return;
            }
            if (dshResult === null) {
              onDebug?.({
                id: `${Date.now()}-client-dsh-session-timeout`,
                timestamp: Date.now(),
                source: "client",
                label: "thread/list dsh timeout",
                payload: {
                  workspaceId: workspace.id,
                  timeoutMs: DSH_SESSION_FETCH_TIMEOUT_MS,
                },
              });
              return;
            }
            const normalizedDshSessions =
              normalizeDshSessionSummaries(dshResult);
            dshSessionCacheRef.current[workspace.id] = {
              fetchedAt: Date.now(),
              sessions: normalizedDshSessions,
            };
            const currentSnapshot =
              latestThreadsByWorkspaceRef.current[workspace.id] ?? [];
            const baselineSummaries =
              currentSnapshot.length > 0 ? currentSnapshot : allSummaries;
            const nextSummaries = mergeDshSessionSummaries(
              baselineSummaries,
              normalizedDshSessions.filter(
                (session) =>
                  !threadIdInHiddenSharedBindingSet(
                    `dsh:${session.sessionId}`,
                    hiddenSharedBindingIds,
                  ),
              ),
              workspace.id,
              mappedTitles,
              getCustomName,
              hiddenSharedBindingIds,
            );
            const visibleNextSummaries = applySessionArchiveState(
              stripHiddenSharedBindingSummaries(
                nextSummaries,
                hiddenSharedBindingIds,
              ),
              await archivedSessionMapPromise,
            );
            const unchanged =
              visibleNextSummaries.length === baselineSummaries.length &&
              visibleNextSummaries.every((entry, index) => {
                const prev = baselineSummaries[index];
                return (
                  !!prev &&
                  prev.id === entry.id &&
                  prev.name === entry.name &&
                  prev.updatedAt === entry.updatedAt &&
                  prev.engineSource === entry.engineSource &&
                  prev.threadKind === entry.threadKind
                );
              });
            if (!unchanged) {
              await yieldIfInteractiveInputPending();
              if (!isLatestThreadListRequest()) {
                return;
              }
              dispatch({
                type: "setThreads",
                workspaceId: workspace.id,
                threads: visibleNextSummaries,
                unionMembership: true,
              });
              latestThreadsByWorkspaceRef.current = {
                ...latestThreadsByWorkspaceRef.current,
                [workspace.id]: visibleNextSummaries,
              };
            }
          })();
        }
        const hasAttemptedPiRefresh =
          piRefreshAttemptedRef.current[workspace.id] === true;
        // Same as DSH: first-paint never probes PI disk. Index is the read layer.
        const shouldRefreshPiSessions =
          isLatestThreadListRequest() &&
          includeEngineDiskLists &&
          (hasPiSignal || !!cachedPi || !hasAttemptedPiRefresh);
        if (shouldRefreshPiSessions) {
          void (async () => {
            piRefreshAttemptedRef.current[workspace.id] = true;
            const piResult = await withTimeout(
              listPiSessionsService(workspace.path, 50),
              PI_SESSION_FETCH_TIMEOUT_MS,
            );
            if (!isLatestThreadListRequest()) {
              return;
            }
            if (piResult === null) {
              onDebug?.({
                id: `${Date.now()}-client-pi-session-timeout`,
                timestamp: Date.now(),
                source: "client",
                label: "thread/list pi timeout",
                payload: {
                  workspaceId: workspace.id,
                  timeoutMs: PI_SESSION_FETCH_TIMEOUT_MS,
                },
              });
              return;
            }
            const normalizedPiSessions = normalizePiSessionSummaries(piResult);
            piSessionCacheRef.current[workspace.id] = {
              fetchedAt: Date.now(),
              sessions: normalizedPiSessions,
            };
            const currentSnapshot =
              latestThreadsByWorkspaceRef.current[workspace.id] ?? [];
            const baselineSummaries =
              currentSnapshot.length > 0 ? currentSnapshot : allSummaries;
            const sharedSessionsForPiHide = normalizeSharedSessionSummaries(
              (await withTimeout(
                listSharedSessionsService(workspace.id).catch(() => []),
                NATIVE_SESSION_LIST_FETCH_TIMEOUT_MS,
              )) ?? [],
            );
            if (!isLatestThreadListRequest()) {
              return;
            }
            const freshHiddenSharedBindingIds = expandHiddenSharedBindingIds([
              ...sharedSessionsForPiHide.flatMap(
                (session) => session.nativeThreadIds,
              ),
              ...hiddenSharedBindingIds,
              ...getCollabWorkerNativeHideIds(),
            ]);
            const nextSummaries = mergePiSessionSummaries(
              baselineSummaries,
              normalizedPiSessions.filter(
                (session) =>
                  !threadIdInHiddenSharedBindingSet(
                    `pi:${session.sessionId}`,
                    freshHiddenSharedBindingIds,
                  ),
              ),
              workspace.id,
              mappedTitles,
              getCustomName,
              freshHiddenSharedBindingIds,
            );
            const visibleNextSummaries = applySessionArchiveState(
              stripHiddenSharedBindingSummaries(
                nextSummaries,
                freshHiddenSharedBindingIds,
              ),
              await archivedSessionMapPromise,
            );
            if (!isLatestThreadListRequest()) {
              return;
            }
            dispatch({
              type: "setThreads",
              workspaceId: workspace.id,
              threads: visibleNextSummaries,
              unionMembership: true,
            });
            latestThreadsByWorkspaceRef.current = {
              ...latestThreadsByWorkspaceRef.current,
              [workspace.id]: visibleNextSummaries,
            };
          })();
        }
        const hasAttemptedQoderRefresh =
          qoderRefreshAttemptedRef.current[workspace.id] === true;
        const shouldRefreshQoderSessions =
          isLatestThreadListRequest() &&
          includeEngineDiskLists &&
          (hasQoderSignal || !!cachedQoder || !hasAttemptedQoderRefresh);
        if (shouldRefreshQoderSessions) {
          void (async () => {
            qoderRefreshAttemptedRef.current[workspace.id] = true;
            const qoderResults = await withTimeout(
              Promise.all([
                listQoderSessionsService(
                  workspace.path,
                  50,
                  QODER_GLOBAL_PROVIDER_PROFILE_ID,
                ),
                listQoderSessionsService(
                  workspace.path,
                  50,
                  QODER_CN_PROVIDER_PROFILE_ID,
                ),
              ]),
              QODER_SESSION_FETCH_TIMEOUT_MS,
            );
            if (!isLatestThreadListRequest()) {
              return;
            }
            if (qoderResults === null) {
              onDebug?.({
                id: `${Date.now()}-client-qoder-session-timeout`,
                timestamp: Date.now(),
                source: "client",
                label: "thread/list qoder timeout",
                payload: {
                  workspaceId: workspace.id,
                  timeoutMs: QODER_SESSION_FETCH_TIMEOUT_MS,
                },
              });
              return;
            }
            const normalizedQoderSessions = [
              ...normalizeQoderSessionSummaries(
                qoderResults[0],
                QODER_GLOBAL_PROVIDER_PROFILE_ID,
              ),
              ...normalizeQoderSessionSummaries(
                qoderResults[1],
                QODER_CN_PROVIDER_PROFILE_ID,
              ),
            ];
            qoderSessionCacheRef.current[workspace.id] = {
              fetchedAt: Date.now(),
              sessions: normalizedQoderSessions,
            };
            const currentSnapshot =
              latestThreadsByWorkspaceRef.current[workspace.id] ?? [];
            const baselineSummaries =
              currentSnapshot.length > 0 ? currentSnapshot : allSummaries;
            const sharedSessionsForQoderHide = normalizeSharedSessionSummaries(
              (await withTimeout(
                listSharedSessionsService(workspace.id).catch(() => []),
                NATIVE_SESSION_LIST_FETCH_TIMEOUT_MS,
              )) ?? [],
            );
            if (!isLatestThreadListRequest()) {
              return;
            }
            const freshHiddenSharedBindingIds = expandHiddenSharedBindingIds([
              ...sharedSessionsForQoderHide.flatMap(
                (session) => session.nativeThreadIds,
              ),
              ...hiddenSharedBindingIds,
              ...getCollabWorkerNativeHideIds(),
            ]);
            const nextSummaries = mergeQoderSessionSummaries(
              baselineSummaries,
              normalizedQoderSessions.filter((session) => {
                const threadId = canonicalQoderThreadId(
                  session.sessionId,
                  session.providerProfileId,
                );
                return (
                  !!threadId &&
                  !threadIdInHiddenSharedBindingSet(
                    threadId,
                    freshHiddenSharedBindingIds,
                  )
                );
              }),
              workspace.id,
              mappedTitles,
              getCustomName,
              freshHiddenSharedBindingIds,
            );
            const visibleNextSummaries = applySessionArchiveState(
              stripHiddenSharedBindingSummaries(
                nextSummaries,
                freshHiddenSharedBindingIds,
              ),
              await archivedSessionMapPromise,
            );
            if (!isLatestThreadListRequest()) {
              return;
            }
            dispatch({
              type: "setThreads",
              workspaceId: workspace.id,
              threads: visibleNextSummaries,
              unionMembership: true,
            });
            latestThreadsByWorkspaceRef.current = {
              ...latestThreadsByWorkspaceRef.current,
              [workspace.id]: visibleNextSummaries,
            };
          })();
        }
      } catch (error) {
        const fallbackThreads = filterRetainableContinuitySummaries(
          getLastGoodThreadSummaries(workspace.id),
        );
        if (isLatestThreadListRequest() && fallbackThreads.length > 0) {
          const fallbackMessage =
            error instanceof Error ? error.message : String(error);
          const archivedSessionMap = await archivedSessionMapPromise.catch(
            () => null,
          );
          const degradedThreads = markThreadSummariesDegraded(
            applySessionArchiveState(fallbackThreads, archivedSessionMap),
            fallbackMessage,
            "last-good-fallback",
          );
          dispatch({
            type: "setThreads",
            workspaceId: workspace.id,
            threads: degradedThreads,
            unionMembership: true,
          });
          appliedThreadListUpdate = true;
          const diagnostic = buildPartialHistoryDiagnostic(
            `thread list error fallback: ${fallbackMessage}`,
          );
          onDebug?.({
            id: `${Date.now()}-client-thread-list-error-fallback`,
            timestamp: Date.now(),
            source: "client",
            label: "thread/list error fallback",
            payload: buildThreadDebugCorrelation(
              {
                workspaceId: workspace.id,
                action: "thread-list-error-fallback",
                engine: "multi",
                diagnosticCategory: diagnostic.category,
                recoveryState: "degraded",
              },
              {
                fallbackCount: degradedThreads.length,
                diagnosticMessage: diagnostic.rawMessage,
              },
            ),
          });
        }
        onDebug?.({
          id: `${Date.now()}-client-thread-list-error`,
          timestamp: Date.now(),
          source: "error",
          label: "thread/list error",
          payload: buildThreadDebugCorrelation(
            {
              workspaceId: workspace.id,
              action: "thread-list-error",
              engine: "multi",
              recoveryState: "recovering",
            },
            {
              error: error instanceof Error ? error.message : String(error),
            },
          ),
        });
      } finally {
        // Clear loading if this request still owns the seq (even when isStale
        // made isLatestThreadListRequest false — cancelled hydrate must not
        // leave the spinner stuck).
        const ownsRequest =
          threadListRequestSeqRef.current[workspace.id] === requestSeq;
        if (ownsRequest) {
          dispatch({
            type: "setThreadListLoading",
            workspaceId: workspace.id,
            isLoading: false,
          });
        }
      }
      return {
        applied: appliedThreadListUpdate,
        visibleCount: visibleThreadCount,
        authoritativeEmpty,
      };
    },
    [
      beginAutomaticRuntimeRecovery,
      canListWorkspaceSessions,
      dispatch,
      getCustomName,
      getAutomaticRuntimeRecoveryPartialSource,
      getLastGoodThreadSummaries,
      getLastGoodThreadSummariesForEngine,
      loadActiveProjectCatalogSessions,
      loadArchivedSessionMap,
      loadedThreadsRef,
      onDebug,
      onThreadTitleMappingsLoaded,
      rememberLastGoodThreadSummariesByEngine,
      removeThreadFromCachedSummaries,
      sessionAttributionMode,
      activeThreadIdByWorkspace,
      threadActivityRef,
      threadsByWorkspace,
    ],
  );

  const loadOlderThreadsForWorkspace = useLoadOlderThreadsForWorkspace({
    activeThreadIdByWorkspace,
    applySessionArchiveState,
    canListWorkspaceSessions,
    dispatch,
    getCustomName,
    latestThreadsByWorkspaceRef,
    listWorkspaceSessionsService,
    loadArchivedSessionMap,
    onDebug,
    onThreadTitleMappingsLoaded,
    sessionAttributionMode,
    threadListCursorByWorkspace,
    threadsByWorkspace,
    workspacePathsByIdRef,
  });

  const archiveThread = useMemo(
    () => createArchiveThreadAction({ onDebug }),
    [onDebug],
  );

  const archiveClaudeThread = useMemo(
    () => createArchiveClaudeThreadAction({ onDebug, workspacePathsByIdRef }),
    [onDebug, workspacePathsByIdRef],
  );

  const deleteThreadForWorkspace = useMemo(() => {
    const deleteThread = createDeleteThreadForWorkspaceAction({
      threadsByWorkspace,
    });
    return async (workspaceId: string, threadId: string) => {
      await deleteThread(workspaceId, threadId);
      removeThreadFromCachedSummaries(workspaceId, threadId);
    };
  }, [
    removeThreadFromCachedSummaries,
    threadsByWorkspace,
  ]);

  return {
    startThreadForWorkspace,
    finalizeCodexPendingThread,
    startSharedSessionForWorkspace,
    forkThreadForWorkspace,
    forkSessionFromMessageForWorkspace,
    forkClaudeSessionFromMessageForWorkspace,
    resumeThreadForWorkspace,
    refreshThread,
    resetWorkspaceThreads,
    listThreadsForWorkspace,
    loadOlderThreadsForWorkspace,
    archiveThread,
    archiveClaudeThread,
    deleteThreadForWorkspace,
    renameThreadTitleMapping,
    setThreadHistoryLoading,
    setThreadHistoryLoadingProgress,
    historyLoadingByThreadId,
    historyLoadingProgressByThreadId,
  };
}
