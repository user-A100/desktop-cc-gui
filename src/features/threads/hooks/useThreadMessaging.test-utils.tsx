import { renderHook } from "@testing-library/react";
import { vi } from "vitest";
import type { ConversationItem, WorkspaceInfo } from "../../../types";
import { clearGlobalRuntimeNotices } from "../../../services/globalRuntimeNotices";
import {
  compactThreadContext,
  engineInterrupt,
  engineInterruptTurn,
  engineSendMessage,
  getWorkspaceFiles,
  interruptTurn,
  listGeminiSessions,
  listMcpServerStatus,
  loadClaudeSession,
  resolveEnabledBuiltInAgent,
  sendUserMessage,
} from "../../../services/tauri";
import { getClientStoreSync } from "../../../services/clientStorage";
import {
  sendSharedSessionTurn,
  sendSharedSessionTurnRouted,
} from "../../shared-session/runtime/sendSharedSessionTurn";
import {
  sharedSessionV2AwaitTurnTerminal,
  sharedSessionV2InterruptTurn,
} from "../../shared-session/services/sharedSessions";
import type { CodexAcceptedTurnRecord } from "../utils/codexConversationLiveness";
import { useThreadMessaging } from "./useThreadMessaging";
import type { ThreadState } from "./useThreadsReducer";

vi.mock("../../../services/toasts", () => ({
  pushErrorToast: vi.fn(),
}));

vi.mock("../../../services/tauri", () => ({
  compactThreadContext: vi.fn(),
  sendUserMessage: vi.fn(),
  projectMemoryCaptureAuto: vi.fn(async () => null),
  projectMemoryCaptureTurnInput: vi.fn(async () => null),
  startReview: vi.fn(),
  interruptTurn: vi.fn(),
  listMcpServerStatus: vi.fn(),
  getOpenCodeMcpStatus: vi.fn(),
  getOpenCodeLspDiagnostics: vi.fn(),
  getOpenCodeLspSymbols: vi.fn(),
  getOpenCodeLspDocumentSymbols: vi.fn(),
  importOpenCodeSession: vi.fn(),
  exportOpenCodeSession: vi.fn(),
  getOpenCodeStats: vi.fn(),
  getWorkspaceFiles: vi.fn(),
  shareOpenCodeSession: vi.fn(),
  listExternalSpecTree: vi.fn(),
  listGitBranches: vi.fn(),
  getGitLog: vi.fn(),
  listGeminiSessions: vi.fn(),
  listKimiSessions: vi.fn(),
  listDshSessions: vi.fn(),
  listPiSessions: vi.fn(),
    listQoderSessions: vi.fn(),
  invalidateSessionIndexForWorkspace: vi.fn(),
  listGrokSessions: vi.fn(),
  loadClaudeSession: vi.fn(),
  engineSendMessage: vi.fn(),
  engineInterruptTurn: vi.fn(),
  engineInterrupt: vi.fn(),
  resolveEnabledBuiltInAgent: vi.fn(),
}));

vi.mock("../../../services/clientStorage", () => ({
  getClientStoreSync: vi.fn(),
  writeClientStoreValue: vi.fn(),
}));

vi.mock("../../shared-session/runtime/sendSharedSessionTurn", () => {
  const sendSharedSessionTurn = vi.fn();
  const sendSharedSessionTurnRouted = vi.fn();
  return {
    sendSharedSessionTurn,
    sendSharedSessionTurnRouted,
  };
});

vi.mock("../../shared-session/services/sharedSessions", () => ({
  sharedSessionV2AwaitTurnTerminal: vi.fn(),
  sharedSessionV2InterruptTurn: vi.fn(),
}));

export const workspace: WorkspaceInfo = {
  id: "ws-1",
  name: "ccgui",
  path: "/tmp/ccgui-workspace",
  connected: true,
  settings: { sidebarCollapsed: false },
};

export function resetThreadMessagingTestMocks() {
  vi.clearAllMocks();
  clearGlobalRuntimeNotices();
  vi.mocked(compactThreadContext).mockResolvedValue({ status: "completed" });
  vi.mocked(getClientStoreSync).mockReturnValue(undefined);
  vi.mocked(engineSendMessage).mockResolvedValue({
    result: { turn: { id: "turn-1" } },
  });
  vi.mocked(sendUserMessage).mockResolvedValue({
    result: { turn: { id: "turn-2" } },
  });
  vi.mocked(resolveEnabledBuiltInAgent).mockResolvedValue({
    id: "agency-agents:engineering/engineering-ai-engineer",
    providerId: "agency-agents",
    sourceRevision: "revision",
    promptHash: "hash",
    prompt: "Resolved built-in prompt",
  });
  vi.mocked(getWorkspaceFiles).mockResolvedValue({
    files: [
      "openspec/changes/add-spec-hub/proposal.md",
      "openspec/changes/add-spec-hub/tasks.md",
    ],
    directories: ["openspec", "openspec/changes", "openspec/specs"],
    gitignored_files: [],
    gitignored_directories: [],
  });
  vi.mocked(listGeminiSessions).mockResolvedValue([]);
  vi.mocked(loadClaudeSession).mockResolvedValue({ messages: [] });
  vi.mocked(listMcpServerStatus).mockResolvedValue({ result: { data: [] } });
  vi.mocked(engineInterrupt).mockResolvedValue();
  vi.mocked(engineInterruptTurn).mockResolvedValue();
  vi.mocked(interruptTurn).mockResolvedValue({});
  vi.mocked(sharedSessionV2InterruptTurn).mockResolvedValue({
    status: "interrupted",
    attemptId: "attempt-1",
    engine: "claude",
    bindingKey: "claude:provider-a",
    nativeThreadId: "native-1",
    runtimeTurnId: "turn-1",
  });
  vi.mocked(sharedSessionV2AwaitTurnTerminal).mockResolvedValue({
    status: "committed",
    duplicate: false,
    sequence: 1,
    bindingKey: "codex:provider-a",
    terminal: {
      type: "run.settled",
      outcome: "completed",
      recoveryReason: null,
    },
  });
  vi.mocked(sendSharedSessionTurn).mockResolvedValue({
    result: { turn: { id: "shared-turn-1" } },
  });
  vi.mocked(sendSharedSessionTurnRouted).mockResolvedValue({
    result: { turn: { id: "shared-turn-1" } },
  });
}

export function makeThreadMessagingHook(
  activeEngine: "claude" | "codex" | "gemini" | "grok" | "kimi" | "opencode" | "pi" | "qoder",
  overrides: {
    workspace?: WorkspaceInfo;
    activeThreadId?: string | null;
    ensuredThreadId?: string | null;
    activeTurnIdByThread?: Record<string, string | null>;
    threadStatusById?: ThreadState["threadStatusById"];
    codexAcceptedTurnByThread?: Record<string, CodexAcceptedTurnRecord>;
    threadEngineById?: Record<
      string,
      "claude" | "codex" | "gemini" | "grok" | "kimi" | "opencode" | "pi" | "qoder" | undefined
    >;
    providerProfileByThread?: Record<string, string | null | undefined>;
    itemsByThread?: Record<string, ConversationItem[]>;
    startThreadForWorkspace?: ReturnType<typeof vi.fn>;
    refreshThread?: ReturnType<typeof vi.fn>;
    forkThreadForWorkspace?: ReturnType<typeof vi.fn>;
    dispatch?: ReturnType<typeof vi.fn>;
    runWithCreateSessionLoading?: ReturnType<typeof vi.fn>;
    model?: string | null;
    resolveComposerSelection?: () => {
      id?: string | null;
      model: string | null;
      source?: string | null;
      providerProfileId?: string | null;
      effort: string | null;
      collaborationMode: Record<string, unknown> | null;
    };
    claudeThinkingVisible?: boolean;
    onSharedDurableTurnCommitted?: ReturnType<typeof vi.fn>;
    onInputMemoryCaptured?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const activeThreadId =
    "activeThreadId" in overrides ? overrides.activeThreadId ?? null : "thread-1";
  const ensuredThreadId =
    "ensuredThreadId" in overrides ? overrides.ensuredThreadId ?? null : activeThreadId;
  const dispatch = overrides.dispatch ?? vi.fn();
  const markProcessing = vi.fn();
  const markReviewing = vi.fn();
  const setActiveTurnId = vi.fn();
  const recordThreadActivity = vi.fn();
  const safeMessageActivity = vi.fn();
  const pushThreadErrorMessage = vi.fn();
  const onDebug = vi.fn();
  const pendingInterruptsRef = { current: new Map<string, Map<string, true>>() };
  // chat-stream-render-isolation-2026-06 task 8: workspace-scope ref
  // shape migrated from Set<threadId> to Map<workspaceId, Map<threadId, true>>.
  const interruptedThreadsRef = {
    current: new Map<string, Map<string, true>>(),
  };
  const codexCompactionInFlightByThreadRef = {
    current: {} as Record<string, boolean>,
  };

  const startThreadForWorkspace =
    overrides.startThreadForWorkspace ?? vi.fn(async () => ensuredThreadId);
  const refreshThread = overrides.refreshThread ?? vi.fn(async () => null);
  const forkThreadForWorkspace = overrides.forkThreadForWorkspace ?? vi.fn(async () => null);

  const hook = renderHook(() =>
    useThreadMessaging({
      activeWorkspace: overrides.workspace ?? workspace,
      activeThreadId,
      accessMode: "current",
      model: overrides.model ?? null,
      effort: null,
      collaborationMode: null,
      steerEnabled: false,
      customPrompts: [],
      activeEngine,
      resolveComposerSelection: overrides.resolveComposerSelection,
      claudeThinkingVisible: overrides.claudeThinkingVisible,
      threadStatusById: overrides.threadStatusById ?? {},
      itemsByThread: overrides.itemsByThread ?? {},
      activeTurnIdByThread: overrides.activeTurnIdByThread ?? {},
      codexAcceptedTurnByThread: overrides.codexAcceptedTurnByThread ?? {},
      tokenUsageByThread: {},
      rateLimitsByWorkspace: {},
      codexCompactionInFlightByThreadRef,
      pendingInterruptsRef,
      interruptedThreadsRef,
      dispatch,
      getCustomName: () => undefined,
      getThreadEngine: (_workspaceId, threadId) =>
        overrides.threadEngineById?.[threadId] ?? undefined,
      getThreadKind: (_workspaceId, threadId) =>
        threadId.startsWith("shared:") ? "shared" : "native",
      getThreadProviderProfileId: (_workspaceId, threadId) =>
        overrides.providerProfileByThread?.[threadId] ?? null,
      markProcessing,
      markReviewing,
      setActiveTurnId,
      recordThreadActivity,
      safeMessageActivity,
      pushThreadErrorMessage,
      ensureThreadForActiveWorkspace: async () => ensuredThreadId,
      ensureThreadForWorkspace: async () => ensuredThreadId,
      refreshThread,
      forkThreadForWorkspace,
      updateThreadParent: vi.fn(),
      startThreadForWorkspace,
      onDebug,
      runWithCreateSessionLoading: overrides.runWithCreateSessionLoading,
      onSharedDurableTurnCommitted:
        overrides.onSharedDurableTurnCommitted,
      onInputMemoryCaptured: overrides.onInputMemoryCaptured,
    }),
  );

  return {
    ...hook,
    dispatch,
    markProcessing,
    markReviewing,
    setActiveTurnId,
    recordThreadActivity,
    safeMessageActivity,
    pushThreadErrorMessage,
    onDebug,
    codexCompactionInFlightByThreadRef,
    pendingInterruptsRef,
    interruptedThreadsRef,
  };
}
