import type {
  ConversationItem,
  ThreadSummary,
  WorkspaceInfo,
} from "../../../types";
import {
  getClientStoreSync,
  writeClientStoreValue,
} from "../../../services/clientStorage";
import type { ThreadMoveFolderTarget } from "../hooks/useSidebarMenus";
import {
  getFirstStringField,
  parseToolArgs,
} from "../../../utils/toolSemantics";
import type { WorkspaceSessionFolder } from "../../../services/tauri";
import {
  extractCollabAgentIds,
  isCollabSpawnTool,
  isGrokSpawnSubagentTool,
  isSubagentTool,
  resolveSubagentSessionThreadId,
} from "../../subagent-ui";
import {
  expandHiddenSharedBindingIds,
  lookupSharedOwnerByNativeParent,
} from "../../shared-session/runtime/sharedSessionSummaries";
import { isGhostClientSessionIndexDeleteError } from "../../threads/utils/threadDelete";

export type WorkspaceGroupSection = {
  id: string | null;
  name: string;
  workspaces: WorkspaceInfo[];
};

export type WorkspaceThreadRows = {
  unpinnedRows: Array<{ thread: ThreadSummary; depth: number }>;
  totalRoots: number;
};

type ToolConversationItem = Extract<ConversationItem, { kind: "tool" }>;

export type ThreadFolderMovePickerState = {
  workspaceId: string;
  threadId: string;
  targets: ThreadMoveFolderTarget[];
  currentFolderId: string | null;
};

const SESSION_FOLDER_COLLAPSED_STATE_KEY = "workspaceSessionFolders.collapsedByWorkspaceId";
export const EMPTY_SESSION_FOLDERS: WorkspaceSessionFolder[] = [];
export const EMPTY_SESSION_FOLDER_OVERRIDES: Record<string, string | null | undefined> = {};

export function readPersistedCollapsedSessionFolderIds(): Record<string, string[]> {
  const stored = getClientStoreSync<Record<string, unknown>>(
    "layout",
    SESSION_FOLDER_COLLAPSED_STATE_KEY,
  );
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return {};
  }
  const normalized: Record<string, string[]> = {};
  Object.entries(stored).forEach(([workspaceId, rawIds]) => {
    if (!Array.isArray(rawIds)) {
      return;
    }
    const folderIds = rawIds
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
    if (folderIds.length > 0) {
      normalized[workspaceId] = Array.from(new Set(folderIds));
    }
  });
  return normalized;
}

export function writePersistedCollapsedSessionFolderIds(value: Record<string, string[]>): void {
  writeClientStoreValue("layout", SESSION_FOLDER_COLLAPSED_STATE_KEY, value);
}

export function updateCollapsedSessionFolderIdsForWorkspace(
  current: Record<string, string[]>,
  workspaceId: string,
  folderIds: string[],
): Record<string, string[]> {
  const normalizedIds = Array.from(new Set(folderIds.map((id) => id.trim()).filter(Boolean)));
  if (normalizedIds.length === 0) {
    const { [workspaceId]: _removed, ...rest } = current;
    return rest;
  }
  return {
    ...current,
    [workspaceId]: normalizedIds,
  };
}

export function isPendingEngineThreadId(threadId: string): boolean {
  const normalizedThreadId = threadId.trim();
  return (
    normalizedThreadId.startsWith("codex-pending-") ||
    normalizedThreadId.startsWith("claude-pending-") ||
    normalizedThreadId.startsWith("gemini-pending-") ||
    normalizedThreadId.startsWith("kimi-pending-") ||
    normalizedThreadId.startsWith("grok-pending-") ||
    normalizedThreadId.startsWith("opencode-pending-") ||
    normalizedThreadId.startsWith("dsh-pending-") ||
    normalizedThreadId.startsWith("pi-pending-") ||
    normalizedThreadId.startsWith("qoder-pending-")
  );
}

// 身份判定唯一实现已上提：shared-session/utils/sharedSessionIdentity.ts
// （fix-shared-session-identity-id-first）。此处仅 re-export 保 callsite 兼容。
export { isSharedSessionThreadId } from "../../shared-session/utils/sharedSessionIdentity";

export function isSessionCatalogNotReadyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return isGhostClientSessionIndexDeleteError(message);
}

export function resolveEnginePrefix(
  threadId: string,
): "claude" | "gemini" | "kimi" | "grok" | "opencode" | "pi" | "dsh" | "qoder" | "codex" {
  if (threadId.startsWith("claude:") || threadId.startsWith("claude-pending-")) {
    return "claude";
  }
  if (threadId.startsWith("gemini:") || threadId.startsWith("gemini-pending-")) {
    return "gemini";
  }
  if (threadId.startsWith("kimi:") || threadId.startsWith("kimi-pending-")) {
    return "kimi";
  }
  if (threadId.startsWith("pi:") || threadId.startsWith("pi-pending-")) {
    return "pi";
  }
  if (threadId.startsWith("grok:") || threadId.startsWith("grok-pending-")) {
    return "grok";
  }
  if (threadId.startsWith("opencode:") || threadId.startsWith("opencode-pending-")) {
    return "opencode";
  }
  if (threadId.startsWith("dsh:") || threadId.startsWith("dsh-pending-")) {
    return "dsh";
  }
  if (threadId.startsWith("qoder:") || threadId.startsWith("qoder-pending-")) {
    return "qoder";
  }
  if (threadId.startsWith("codex:") || threadId.startsWith("codex-pending-")) {
    return "codex";
  }
  return "codex";
}

export function resolveFolderIntentReplacementThreadId(
  pendingThreadId: string,
  threads: ThreadSummary[],
): string | null {
  if (!isPendingEngineThreadId(pendingThreadId)) {
    return pendingThreadId;
  }
  const explicitReplacement = threads.find((thread) =>
    thread.nativeThreadIds?.includes(pendingThreadId),
  );
  if (explicitReplacement && !isPendingEngineThreadId(explicitReplacement.id)) {
    return explicitReplacement.id;
  }
  const pendingEngine = resolveEnginePrefix(pendingThreadId);
  const sameEngineRealThreads = threads.filter((thread) => {
    const engineSource = thread.engineSource ?? resolveEnginePrefix(thread.id);
    return (
      engineSource === pendingEngine &&
      thread.id.startsWith(`${pendingEngine}:`) &&
      !thread.id.includes("-pending-")
    );
  });
  if (sameEngineRealThreads.length !== 1) {
    return null;
  }
  return sameEngineRealThreads[0]?.id ?? null;
}

export function isClaudeThreadId(threadId: string | null | undefined) {
  return Boolean(threadId?.startsWith("claude:") || threadId?.startsWith("claude-pending-"));
}

export function isPendingSubagentThreadId(threadId: string) {
  return (
    threadId.startsWith("claude-pending-subagent:") ||
    threadId.includes("-pending-subagent:")
  );
}

function resolveThreadParentId(
  thread: ThreadSummary,
  threadParentById: Record<string, string>,
) {
  return thread.parentThreadId ?? threadParentById[thread.id] ?? null;
}

export function collectThreadSubtreeIds(
  threads: ThreadSummary[],
  threadParentById: Record<string, string>,
  rootThreadId: string,
) {
  const childrenByParent = new Map<string, string[]>();
  threads.forEach((thread) => {
    const parentId = resolveThreadParentId(thread, threadParentById);
    if (!parentId || parentId === thread.id) {
      return;
    }
    const children = childrenByParent.get(parentId) ?? [];
    children.push(thread.id);
    childrenByParent.set(parentId, children);
  });

  const subtreeIds: string[] = [];
  const visited = new Set<string>();
  const visit = (threadId: string) => {
    if (visited.has(threadId)) {
      return;
    }
    visited.add(threadId);
    subtreeIds.push(threadId);
    (childrenByParent.get(threadId) ?? []).forEach(visit);
  };
  visit(rootThreadId);
  return subtreeIds;
}

function isCompletedToolStatus(status: string | undefined, output: string | undefined) {
  const normalized = status?.trim().toLowerCase() ?? "";
  return Boolean(output) || normalized === "completed" || normalized === "success";
}

function resolveParentEngineSource(
  parent: ThreadSummary,
  activeThreadId: string,
): ThreadSummary["engineSource"] {
  if (parent.engineSource) {
    return parent.engineSource;
  }
  if (activeThreadId.startsWith("claude:")) return "claude";
  if (activeThreadId.startsWith("grok:")) return "grok";
  if (activeThreadId.startsWith("kimi:")) return "kimi";
  if (activeThreadId.startsWith("gemini:")) return "gemini";
  if (activeThreadId.startsWith("opencode:")) return "opencode";
  if (activeThreadId.startsWith("dsh:")) return "dsh";
  if (activeThreadId.startsWith("shared:")) return "codex";
  return "codex";
}

function buildPendingSubagentName(item: ToolConversationItem): string {
  const args = parseToolArgs(item.detail);
  const description =
    getFirstStringField(args, ["description", "prompt", "query", "task", "prompt_template"]) ||
    (typeof item.output === "string" ? item.output.split(/\r?\n/, 1)[0]?.trim() : "") ||
    (typeof item.title === "string" ? item.title.replace(/^Collab:\s*/i, "").trim() : "") ||
    "Subagent";
  const subagentType =
    getFirstStringField(args, ["subagent_type", "subagentType", "agent", "type", "name"]) ||
    (isCollabSpawnTool(item) ? "Agent" : "Subagent");
  return `${subagentType} ${description}`.trim().slice(0, 120);
}

/**
 * 从对话 items 中筛出 live subagent 投影关心的 tool 条目（跨引擎）。
 * Sidebar 用它把 `getProjectedThreads` 的依赖从「每个 token 换引用的 activeItems」
 * 收窄为这份小得多、且流式文本 delta 期间引用稳定的子集。
 */
export function filterClaudeLiveSubagentSourceItems(
  items: ConversationItem[],
): ConversationItem[] {
  return items.filter(
    (item) => item.kind === "tool" && isSubagentTool(item),
  );
}

/** @deprecated 别名：历史命名保留，逻辑已跨引擎 */
export const filterLiveSubagentSourceItems = filterClaudeLiveSubagentSourceItems;

/**
 * 在会话列表中为当前父会话注入 live 子代理行（pending + 已有真实子会话的 parent 链接投影）。
 * 覆盖 Claude / Codex collab / Grok / Kimi / Shared。
 */
export function buildClaudeLiveSubagentRows(
  threads: ThreadSummary[],
  workspaceId: string,
  activeWorkspaceId: string | null,
  activeThreadId: string | null,
  activeItems: ConversationItem[],
): ThreadSummary[] {
  if (workspaceId !== activeWorkspaceId || !activeThreadId) {
    return threads;
  }
  const parent = threads.find((thread) => thread.id === activeThreadId);
  if (!parent) {
    return threads;
  }

  const threadIds = new Set(threads.map((thread) => thread.id));
  const engineSource = resolveParentEngineSource(parent, activeThreadId);
  const parentSessionId = activeThreadId.startsWith("claude:")
    ? activeThreadId.slice("claude:".length)
    : "";
  let unmatchedRealChildCount = threads.filter(
    (thread) =>
      thread.parentThreadId === activeThreadId ||
      (parentSessionId.length > 0 &&
        thread.id.startsWith(`claude:subagent:${parentSessionId}:`)),
  ).length;
  const pendingRows: ThreadSummary[] = [];
  const linkedChildren: ThreadSummary[] = [];

  const pushPending = (pendingId: string, name: string) => {
    if (threadIds.has(pendingId) || pendingRows.some((row) => row.id === pendingId)) {
      return;
    }
    pendingRows.push({
      id: pendingId,
      name,
      updatedAt: parent.updatedAt,
      engineSource,
      threadKind: parent.threadKind ?? "native",
      parentThreadId: activeThreadId,
      isDegraded: true,
      degradedReason: "Subagent is running; transcript is not available yet.",
    });
  };

  const linkOrPendingChild = (rawChildId: string, name: string) => {
    const resolvedChildId =
      resolveSubagentSessionThreadId({
        parentThreadId: activeThreadId,
        agentId: rawChildId,
        explicitThreadId: rawChildId.includes(":") ? rawChildId : null,
      }) ?? rawChildId;
    if (threadIds.has(resolvedChildId)) {
      const existing = threads.find((thread) => thread.id === resolvedChildId);
      if (
        existing &&
        existing.parentThreadId !== activeThreadId &&
        !linkedChildren.some((row) => row.id === resolvedChildId)
      ) {
        linkedChildren.push({
          ...existing,
          parentThreadId: activeThreadId,
        });
      }
      return;
    }
    pushPending(
      `${engineSource}-pending-subagent:${activeThreadId}:${rawChildId}`,
      name,
    );
  };

  activeItems.forEach((item) => {
    if (item.kind !== "tool" || !isSubagentTool(item)) {
      return;
    }

    // Codex collab spawn：为每个 receiver 建 pending / 挂 parent
    if (isCollabSpawnTool(item)) {
      const agentIds = extractCollabAgentIds(item);
      if (agentIds.length === 0) {
        pushPending(
          `${engineSource}-pending-subagent:${activeThreadId}:${item.id}`,
          buildPendingSubagentName(item),
        );
        return;
      }
      agentIds.forEach((agentId) => {
        linkOrPendingChild(agentId, buildPendingSubagentName(item));
      });
      return;
    }

    // Grok spawn_subagent：output 含 subagent_id → 挂 grok:{id}
    if (isGrokSpawnSubagentTool(item)) {
      const args = parseToolArgs(item.detail);
      const output = typeof item.output === "string" ? item.output : "";
      const subagentId =
        getFirstStringField(args, ["subagent_id", "subagentId", "agent_id", "agentId"]) ||
        /subagent_id\s*[:=]\s*['"]?([a-f0-9-]+)/i.exec(output)?.[1] ||
        "";
      if (subagentId) {
        linkOrPendingChild(subagentId, buildPendingSubagentName(item));
      } else {
        pushPending(
          `${engineSource}-pending-subagent:${activeThreadId}:${item.id}`,
          buildPendingSubagentName(item),
        );
      }
      return;
    }

    const args = parseToolArgs(item.detail);
    const taskId = getFirstStringField(args, ["task_id", "taskId"]);
    const stableAgentId = getFirstStringField(args, ["agent_id", "agentId", "subagent_id"]);
    const resolvedChildId = resolveSubagentSessionThreadId({
      parentThreadId: activeThreadId,
      agentId: stableAgentId,
    });

    if (resolvedChildId && threadIds.has(resolvedChildId)) {
      linkOrPendingChild(resolvedChildId, buildPendingSubagentName(item));
      return;
    }

    const output = typeof item.output === "string" ? item.output : "";
    if (
      isClaudeThreadId(activeThreadId) &&
      !stableAgentId &&
      isCompletedToolStatus(item.status, output) &&
      unmatchedRealChildCount > 0
    ) {
      unmatchedRealChildCount -= 1;
      return;
    }

    const pendingKey = taskId || stableAgentId || item.id;
    const pendingId = isClaudeThreadId(activeThreadId)
      ? `claude-pending-subagent:${activeThreadId}:${pendingKey}`
      : `${engineSource}-pending-subagent:${activeThreadId}:${pendingKey}`;
    pushPending(pendingId, buildPendingSubagentName(item));
  });

  // Shared 父会话：把仍挂在 hidden native owner 下的子线程改挂到 shared:
  // 与 list remap 共用 lookup（raw / engine: 变体）。
  if (parent.threadKind === "shared" || activeThreadId.startsWith("shared:")) {
    const nativeToShared = new Map<string, string>();
    expandHiddenSharedBindingIds(parent.nativeThreadIds ?? []).forEach((nativeId) => {
      if (!nativeToShared.has(nativeId)) {
        nativeToShared.set(nativeId, activeThreadId);
      }
    });
    if (nativeToShared.size > 0) {
      threads.forEach((thread) => {
        const currentParent = thread.parentThreadId?.trim() || "";
        if (!currentParent || currentParent === activeThreadId) {
          return;
        }
        if (lookupSharedOwnerByNativeParent(currentParent, nativeToShared) !== activeThreadId) {
          return;
        }
        if (linkedChildren.some((row) => row.id === thread.id)) {
          return;
        }
        linkedChildren.push({
          ...thread,
          parentThreadId: activeThreadId,
        });
      });
    }
  }

  if (pendingRows.length === 0 && linkedChildren.length === 0) {
    return threads;
  }

  // 用 linked 覆盖同 id 条目，并追加 pending
  const linkedById = new Map(linkedChildren.map((row) => [row.id, row]));
  const merged = threads.map((thread) => linkedById.get(thread.id) ?? thread);
  return [...merged, ...pendingRows];
}

/** @deprecated 别名：历史命名保留，逻辑已跨引擎 */
export const buildLiveSubagentRows = buildClaudeLiveSubagentRows;
