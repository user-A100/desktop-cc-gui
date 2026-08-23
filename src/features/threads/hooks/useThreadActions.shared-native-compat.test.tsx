// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceInfo } from "../../../types";
import {
  connectWorkspace,
  getOpenCodeSessionList,
  listClaudeSessions,
  listGeminiSessions,
  listGrokSessions,
  listKimiSessions,
  listDshSessions,
  listPiSessions,
  listWorkspaceSessions,
  listThreadTitles,
  listThreads,
  readWorkspaceFile,
  renameThreadTitleKey,
  setThreadTitle,
  trashWorkspaceItem,
  writeWorkspaceFile,
} from "../../../services/tauri";
import {
  getThreadTimestamp,
  previewThreadName,
} from "../../../utils/threadItems";
import { listSharedSessions } from "../../shared-session/services/sharedSessions";
import { useThreadActions } from "./useThreadActions";

vi.mock("../../../services/tauri", () => ({
  archiveThread: vi.fn(),
  connectWorkspace: vi.fn(),
  deleteCodexSession: vi.fn(),
  deleteClaudeSession: vi.fn(),
  deleteGeminiSession: vi.fn(),
  deleteOpenCodeSession: vi.fn(),
  forkClaudeSession: vi.fn(),
  forkClaudeSessionFromMessage: vi.fn(),
  forkThread: vi.fn(),
  rewindCodexThread: vi.fn(),
  getOpenCodeSessionList: vi.fn(),
  listClaudeSessions: vi.fn(),
  listGeminiSessions: vi.fn(),
  listKimiSessions: vi.fn(),
  listDshSessions: vi.fn(),
  listPiSessions: vi.fn(),
  listGrokSessions: vi.fn(),
  listQoderSessions: vi.fn(async () => []),
  listSessionIndexForWorkspace: vi.fn(async () => ({
    data: [],
    source: "session-index",
    synced: false,
    engines: [],
  })),
  listWorkspaceSessions: vi.fn(),
  listThreadTitles: vi.fn(),
  listThreads: vi.fn(),
  loadClaudeSession: vi.fn(),
  loadCodexSession: vi.fn(),
  loadGeminiSession: vi.fn(),
  readWorkspaceFile: vi.fn(),
  rememberSessionIndexWorkspacePath: vi.fn(),
  renameThreadTitleKey: vi.fn(),
  resumeThread: vi.fn(),
  setThreadTitle: vi.fn(),
  startThread: vi.fn(),
  trashWorkspaceItem: vi.fn(),
  writeWorkspaceFile: vi.fn(),
}));

vi.mock("../../../utils/threadItems", () => ({
  buildItemsFromThread: vi.fn(),
  getThreadTimestamp: vi.fn(),
  isReviewingFromThread: vi.fn(),
  mergeThreadItems: vi.fn(),
  previewThreadName: vi.fn(),
}));

vi.mock("../utils/threadStorage", () => ({
  makeCustomNameKey: (workspaceId: string, threadId: string) =>
    `${workspaceId}:${threadId}`,
  saveThreadActivity: vi.fn(),
}));

vi.mock("../../shared-session/services/sharedSessions", () => ({
  deleteSharedSession: vi.fn(),
  listSharedSessions: vi.fn(),
  loadSharedSession: vi.fn(),
  startSharedSession: vi.fn(),
}));

const workspace: WorkspaceInfo = {
  id: "ws-1",
  name: "ccgui",
  path: "/tmp/codex",
  connected: true,
  settings: { sidebarCollapsed: false },
};

function renderActions() {
  const dispatch = vi.fn();
  const loadedThreadsRef = { current: {} as Record<string, boolean> };
  const replaceOnResumeRef = { current: {} as Record<string, boolean> };
  const threadActivityRef = {
    current: {} as Record<string, Record<string, number>>,
  };

  const args: Parameters<typeof useThreadActions>[0] = {
    dispatch,
    itemsByThread: {},
    userInputRequests: [],
    threadsByWorkspace: {},
    activeThreadIdByWorkspace: {},
    threadListCursorByWorkspace: {},
    threadStatusById: {},
    getCustomName: () => undefined,
    threadActivityRef,
    loadedThreadsRef,
    replaceOnResumeRef,
    applyCollabThreadLinksFromThread: vi.fn(),
    updateThreadParent: vi.fn(),
    onThreadTitleMappingsLoaded: vi.fn(),
    onRenameThreadTitleMapping: vi.fn(),
  };

  const utils = renderHook(() => useThreadActions(args));
  return { dispatch, ...utils };
}

describe("useThreadActions shared/native compatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listThreadTitles).mockResolvedValue({});
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data: [],
        nextCursor: null,
      },
    });
    vi.mocked(listClaudeSessions).mockResolvedValue([]);
    vi.mocked(listGeminiSessions).mockResolvedValue([]);
    vi.mocked(listPiSessions).mockResolvedValue([]);
    vi.mocked(listDshSessions).mockResolvedValue([]);
    vi.mocked(listWorkspaceSessions).mockResolvedValue({
      data: [],
      nextCursor: null,
      partialSource: null,
    });
    vi.mocked(getOpenCodeSessionList).mockResolvedValue([]);
    vi.mocked(listSharedSessions).mockResolvedValue([]);
    vi.mocked(renameThreadTitleKey).mockResolvedValue(undefined);
    vi.mocked(setThreadTitle).mockResolvedValue("title");
    vi.mocked(connectWorkspace).mockResolvedValue(undefined);
    vi.mocked(readWorkspaceFile).mockResolvedValue({
      content: "",
      truncated: false,
    });
    vi.mocked(trashWorkspaceItem).mockResolvedValue(undefined);
    vi.mocked(writeWorkspaceFile).mockResolvedValue(undefined);
    vi.mocked(previewThreadName).mockImplementation((text: string, fallback: string) => {
      const trimmed = text.trim();
      return trimmed || fallback;
    });
    vi.mocked(getThreadTimestamp).mockImplementation((thread) => {
      const record = thread as Record<string, unknown>;
      const value = record.updated_at ?? record.updatedAt;
      return typeof value === "number" ? value : 0;
    });
  });

  it("keeps gemini visible while hiding supported shared engines listed as bindings", async () => {
    vi.mocked(getOpenCodeSessionList).mockResolvedValue([
      {
        sessionId: "ses_opc_bound_1",
        title: "OpenCode Bound",
        updatedLabel: "1m ago",
        updatedAt: 1_730_000_310_000,
      },
      {
        sessionId: "ses_opc_visible_1",
        title: "OpenCode Visible",
        updatedLabel: "1m ago",
        updatedAt: 1_730_000_311_000,
      },
    ]);
    vi.mocked(listGeminiSessions).mockResolvedValue([
      {
        sessionId: "ses_gemini_visible_1",
        firstMessage: "Gemini Visible",
        updatedAt: 1_730_000_320_000,
      },
    ]);
    vi.mocked(listSharedSessions).mockResolvedValue([
      {
        id: "shared-session-legacy-1",
        threadId: "shared:shared-session-legacy-1",
        title: "Shared Legacy",
        updatedAt: 1_730_000_330_000,
        selectedEngine: "claude",
        nativeThreadIds: [
          // Gemini 不是 Shared 引擎：normalize 会剥离，不得误藏用户 Gemini 会话。
          "gemini:ses_gemini_visible_1",
          // OpenCode 是 Shared 引擎：必须隐藏 Hidden Binding。
          "opencode:ses_opc_bound_1",
          "claude:session-1",
        ],
      },
    ]);

    const { result, dispatch } = renderActions();

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace, {
        includeOpenCodeSessions: true,
        includeEngineDiskLists: true,
      });
    });

    await waitFor(() => {
      const setThreadsActions = vi.mocked(dispatch).mock.calls
        .map(([action]) => action)
        .filter((action) => action?.type === "setThreads");
      expect(setThreadsActions.length).toBeGreaterThan(0);
      expect(
        setThreadsActions.some((action) => {
          const threadIds = Array.isArray(action.threads)
            ? action.threads.map((thread: { id: string }) => thread.id)
            : [];
          return (
            threadIds.includes("shared:shared-session-legacy-1") &&
            threadIds.includes("gemini:ses_gemini_visible_1") &&
            threadIds.includes("opencode:ses_opc_visible_1") &&
            !threadIds.includes("opencode:ses_opc_bound_1")
          );
        }),
      ).toBe(true);
    });
  });

  it("hides claude native bindings owned by shared sessions from native thread list", async () => {
    vi.mocked(listClaudeSessions).mockResolvedValue([
      {
        sessionId: "session-hidden",
        firstMessage: "Hidden Claude Binding",
        updatedAt: 1_730_000_340_000,
      },
      {
        sessionId: "session-visible",
        firstMessage: "Visible Claude Session",
        updatedAt: 1_730_000_350_000,
      },
    ]);
    vi.mocked(listSharedSessions).mockResolvedValue([
      {
        id: "shared-session-claude-1",
        threadId: "shared:shared-session-claude-1",
        title: "Shared Claude",
        updatedAt: 1_730_000_360_000,
        selectedEngine: "claude",
        nativeThreadIds: ["claude:session-hidden"],
      },
    ]);

    const { result, dispatch } = renderActions();

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace, {
        includeEngineDiskLists: true,
      });
    });

    await waitFor(() => {
      const setThreadsActions = vi.mocked(dispatch).mock.calls
        .map(([action]) => action)
        .filter((action) => action?.type === "setThreads");
      expect(setThreadsActions.length).toBeGreaterThan(0);
      expect(
        setThreadsActions.some((action) => {
          const threadIds = Array.isArray(action.threads)
            ? action.threads.map((thread: { id: string }) => thread.id)
            : [];
          return (
            threadIds.includes("shared:shared-session-claude-1") &&
            threadIds.includes("claude:session-visible") &&
            !threadIds.includes("claude:session-hidden")
          );
        }),
      ).toBe(true);
    });
  });

  it("hides Codex V2 bindings returned by the Shared canonical store", async () => {
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data: [
          {
            id: "codex-hidden",
            preview: "Hidden Codex Binding",
            updatedAt: 1_730_000_370_000,
            cwd: "/tmp/codex",
          },
          {
            id: "codex-visible",
            preview: "Visible Codex Session",
            updatedAt: 1_730_000_380_000,
            cwd: "/tmp/codex",
          },
        ],
        nextCursor: null,
      },
    });
    vi.mocked(listSharedSessions).mockResolvedValue([
      {
        id: "shared-session-codex-1",
        threadId: "shared:shared-session-codex-1",
        title: "Shared Codex",
        updatedAt: 1_730_000_390_000,
        selectedEngine: "codex",
        nativeThreadIds: ["codex-hidden"],
      },
    ]);

    const { result, dispatch } = renderActions();

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });

    await waitFor(() => {
      const setThreadsActions = vi.mocked(dispatch).mock.calls
        .map(([action]) => action)
        .filter((action) => action?.type === "setThreads");
      expect(
        setThreadsActions.some((action) => {
          const threadIds = Array.isArray(action.threads)
            ? action.threads.map((thread: { id: string }) => thread.id)
            : [];
          return (
            threadIds.includes("shared:shared-session-codex-1") &&
            threadIds.includes("codex-visible") &&
            !threadIds.includes("codex-hidden")
          );
        }),
      ).toBe(true);
    });
  });

  it("hides grok kimi and opencode shared bindings from native list surfaces", async () => {
    vi.mocked(listGrokSessions).mockResolvedValue([
      {
        sessionId: "grok-hidden-1",
        firstMessage: "MOSSX_CONTEXT_PACKAGE:pkg:checksum",
        updatedAt: 1_730_000_400_000,
      },
      {
        sessionId: "grok-visible-1",
        firstMessage: "Visible Grok Session",
        updatedAt: 1_730_000_410_000,
      },
    ]);
    vi.mocked(listKimiSessions).mockResolvedValue([
      {
        sessionId: "kimi-hidden-1",
        firstMessage: "Hidden Kimi Binding",
        updatedAt: 1_730_000_420_000,
      },
      {
        sessionId: "kimi-visible-1",
        firstMessage: "Visible Kimi Session",
        updatedAt: 1_730_000_430_000,
      },
    ]);
    vi.mocked(getOpenCodeSessionList).mockResolvedValue([
      {
        sessionId: "ses_opc_hidden_1",
        title: "Hidden OpenCode Binding",
        updatedLabel: "1m ago",
        updatedAt: 1_730_000_440_000,
      },
      {
        sessionId: "ses_opc_visible_1",
        title: "Visible OpenCode Session",
        updatedLabel: "1m ago",
        updatedAt: 1_730_000_450_000,
      },
    ]);
    vi.mocked(listSharedSessions).mockResolvedValue([
      {
        id: "shared-session-multi-1",
        threadId: "shared:shared-session-multi-1",
        title: "Shared Multi",
        updatedAt: 1_730_000_460_000,
        selectedEngine: "grok",
        nativeThreadIds: [
          "grok:grok-hidden-1",
          "kimi:kimi-hidden-1",
          "opencode:ses_opc_hidden_1",
        ],
      },
    ]);

    const { result, dispatch } = renderActions();

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace, {
        includeOpenCodeSessions: true,
        includeEngineDiskLists: true,
      });
    });

    // Grok/Kimi 走 async refresh 二次 setThreads；等到最终快照包含可见/隐藏判定。
    await waitFor(() => {
      const setThreadsActions = vi.mocked(dispatch).mock.calls
        .map(([action]) => action)
        .filter((action) => action?.type === "setThreads");
      expect(setThreadsActions.length).toBeGreaterThan(0);
      const latest = setThreadsActions[setThreadsActions.length - 1];
      const threadIds = Array.isArray(latest?.threads)
        ? latest.threads.map((thread: { id: string }) => thread.id)
        : [];
      // 合并多次 setThreads 的并集，因 Grok/Kimi refresh 是独立 dispatch。
      const allSeen = new Set<string>();
      for (const action of setThreadsActions) {
        if (!Array.isArray(action.threads)) continue;
        for (const thread of action.threads as { id: string }[]) {
          allSeen.add(thread.id);
        }
      }
      expect(allSeen.has("shared:shared-session-multi-1")).toBe(true);
      expect(allSeen.has("opencode:ses_opc_visible_1")).toBe(true);
      expect(allSeen.has("grok:grok-visible-1")).toBe(true);
      expect(allSeen.has("kimi:kimi-visible-1")).toBe(true);
      expect(allSeen.has("grok:grok-hidden-1")).toBe(false);
      expect(allSeen.has("kimi:kimi-hidden-1")).toBe(false);
      expect(allSeen.has("opencode:ses_opc_hidden_1")).toBe(false);
      // 最终快照也不得把 hidden binding 带回。
      expect(threadIds).not.toContain("grok:grok-hidden-1");
      expect(threadIds).not.toContain("kimi:kimi-hidden-1");
      expect(threadIds).not.toContain("opencode:ses_opc_hidden_1");
    });
  });

  it("rebuilds hide set on async grok refresh so post-create binding materialize still hides", async () => {
    // 复现：创建 Shared 时 binding 为空 → list 开头 hide set=∅ → 异步 listGrok
    // 期间 binding materialize → 必须用 fresh hide set，否则 native 泄漏。
    let sharedListCalls = 0;
    vi.mocked(listSharedSessions).mockImplementation(async () => {
      sharedListCalls += 1;
      if (sharedListCalls === 1) {
        return [
          {
            id: "shared-session-race-1",
            threadId: "shared:shared-session-race-1",
            title: "Shared Session",
            updatedAt: 1_730_000_500_000,
            selectedEngine: "grok",
            nativeThreadIds: [],
          },
        ];
      }
      return [
        {
          id: "shared-session-race-1",
          threadId: "shared:shared-session-race-1",
          title: "分析一下给我结论",
          updatedAt: 1_730_000_510_000,
          selectedEngine: "grok",
          nativeThreadIds: ["grok:grok-bound-race-1"],
        },
      ];
    });

    let resolveGrokSessions: (value: unknown) => void = () => {};
    const grokSessionsGate = new Promise((resolve) => {
      resolveGrokSessions = resolve;
    });
    vi.mocked(listGrokSessions).mockImplementation(async () => {
      await grokSessionsGate;
      return [
        {
          sessionId: "grok-bound-race-1",
          firstMessage: "分析一下给我结论",
          updatedAt: 1_730_000_520_000,
        },
        {
          sessionId: "grok-user-visible-1",
          firstMessage: "User Grok Session",
          updatedAt: 1_730_000_530_000,
        },
      ];
    });

    const { result, dispatch } = renderActions();

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace, {
        includeEngineDiskLists: true,
      });
    });

    // 主路径 setThreads 先落地（binding 仍空，尚无 grok 行）
    await waitFor(() => {
      const setThreadsActions = vi.mocked(dispatch).mock.calls
        .map(([action]) => action)
        .filter((action) => action?.type === "setThreads");
      expect(setThreadsActions.length).toBeGreaterThan(0);
      expect(
        setThreadsActions.some((action) => {
          const ids = Array.isArray(action.threads)
            ? action.threads.map((t: { id: string }) => t.id)
            : [];
          return ids.includes("shared:shared-session-race-1");
        }),
      ).toBe(true);
    });

    // 模拟首轮 send 后 binding materialize，再放行异步 Grok list
    await act(async () => {
      resolveGrokSessions(undefined);
    });

    await waitFor(() => {
      const setThreadsActions = vi.mocked(dispatch).mock.calls
        .map(([action]) => action)
        .filter((action) => action?.type === "setThreads");
      const latest = setThreadsActions[setThreadsActions.length - 1];
      const threadIds = Array.isArray(latest?.threads)
        ? latest.threads.map((thread: { id: string }) => thread.id)
        : [];
      expect(threadIds).toContain("shared:shared-session-race-1");
      expect(threadIds).toContain("grok:grok-user-visible-1");
      expect(threadIds).not.toContain("grok:grok-bound-race-1");
    });
  });

  it("main list strip purges previously leaked shared-owned grok row", async () => {
    // 模拟上一帧已泄漏的 native 仍在 store；主路径 final hide 闸门必须清掉。
    vi.mocked(listSharedSessions).mockResolvedValue([
      {
        id: "shared-session-purge-1",
        threadId: "shared:shared-session-purge-1",
        title: "Shared Session",
        updatedAt: 1_730_000_600_000,
        selectedEngine: "grok",
        nativeThreadIds: ["grok:grok-already-leaked"],
      },
    ]);
    // 避免异步 Grok 路径干扰本断言（主路径 strip 独立可测）
    vi.mocked(listGrokSessions).mockResolvedValue([]);

    const dispatch = vi.fn();
    const loadedThreadsRef = { current: {} as Record<string, boolean> };
    const replaceOnResumeRef = { current: {} as Record<string, boolean> };
    const threadActivityRef = {
      current: {} as Record<string, Record<string, number>>,
    };
    const args: Parameters<typeof useThreadActions>[0] = {
      dispatch,
      itemsByThread: {},
      userInputRequests: [],
      threadsByWorkspace: {
        "ws-1": [
          {
            id: "shared:shared-session-purge-1",
            name: "Shared Session",
            updatedAt: 1_730_000_600_000,
            engineSource: "grok",
            threadKind: "shared",
            nativeThreadIds: ["grok:grok-already-leaked"],
          },
          {
            id: "grok:grok-already-leaked",
            name: "分析一下给我结论",
            updatedAt: 1_730_000_610_000,
            engineSource: "grok",
            threadKind: "native",
          },
        ],
      },
      activeThreadIdByWorkspace: {},
      threadListCursorByWorkspace: {},
      threadStatusById: {},
      getCustomName: () => undefined,
      threadActivityRef,
      loadedThreadsRef,
      replaceOnResumeRef,
      applyCollabThreadLinksFromThread: vi.fn(),
      updateThreadParent: vi.fn(),
      onThreadTitleMappingsLoaded: vi.fn(),
      onRenameThreadTitleMapping: vi.fn(),
    };

    const { result } = renderHook(() => useThreadActions(args));

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });

    await waitFor(() => {
      const setThreadsActions = vi.mocked(dispatch).mock.calls
        .map(([action]) => action)
        .filter((action) => action?.type === "setThreads");
      expect(setThreadsActions.length).toBeGreaterThan(0);
      // 任意一次落地都不得再带 hidden binding；最终快照亦然。
      for (const action of setThreadsActions) {
        const ids = Array.isArray(action.threads)
          ? action.threads.map((thread: { id: string }) => thread.id)
          : [];
        expect(ids).not.toContain("grok:grok-already-leaked");
      }
      const latest = setThreadsActions[setThreadsActions.length - 1];
      const latestIds = Array.isArray(latest?.threads)
        ? latest.threads.map((thread: { id: string }) => thread.id)
        : [];
      expect(latestIds).toContain("shared:shared-session-purge-1");
    });
  });
});
