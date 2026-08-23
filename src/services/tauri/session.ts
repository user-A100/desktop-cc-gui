import { invoke } from "@tauri-apps/api/core";
import type { ClaudeDeferredImageLocator, ClaudeHydratedImage } from "../../types";
import { createAsyncResultCache } from "../asyncResultCache";
import type { AutoSessionMetadata } from "./sessionManagement";
import { invalidateOpenCodeSessionListCache } from "./openCode";
import { traceStartupCommand, type StartupWorkspaceScope } from "../../features/startup-orchestration/utils/startupTrace";

function workspaceScope(workspaceId: string): StartupWorkspaceScope {
  return { workspaceId };
}

function traceStartupInvoke<T>(
  commandLabel: string,
  scope: StartupWorkspaceScope | "global",
  run: () => Promise<T>,
) {
  return traceStartupCommand(commandLabel, scope, run);
}

type RpcObject = Record<string, unknown>;

export interface ThreadListResultPayload extends RpcObject {
  data?: unknown[];
  nextCursor?: string | null;
  next_cursor?: string | null;
  partialSource?: string;
  partial_source?: string;
}

export interface ThreadListPayload extends RpcObject {
  result?: ThreadListResultPayload;
  data?: unknown[];
  nextCursor?: string | null;
  next_cursor?: string | null;
}

export interface ClaudeSessionSummaryPayload {
  sessionId: string;
  firstMessage: string;
  nativeTitle?: string | null;
  createdAt?: number;
  updatedAt: number;
  fileSizeBytes?: number;
  parentSessionId?: string | null;
  subagentType?: string | null;
}

export async function startThread(
  workspaceId: string,
  options?: {
    autoSession?: AutoSessionMetadata | null;
    providerProfileId?: string | null;
  },
) {
  return invoke<Record<string, unknown> | null | undefined>("start_thread", {
    workspaceId,
    autoSession: options?.autoSession ?? null,
    providerProfileId: options?.providerProfileId ?? null,
  });
}

export async function forkThread(
  workspaceId: string,
  threadId: string,
  messageId?: string | null,
  options?: {
    providerProfileId?: string | null;
    targetUserTurnIndex?: number | null;
    targetUserMessageText?: string | null;
    targetUserMessageOccurrence?: number | null;
    localUserMessageCount?: number | null;
  },
) {
  const targetUserTurnIndex =
    typeof options?.targetUserTurnIndex === "number" &&
    Number.isFinite(options.targetUserTurnIndex)
      ? Math.max(0, Math.floor(options.targetUserTurnIndex))
      : null;
  const targetUserMessageOccurrence =
    typeof options?.targetUserMessageOccurrence === "number" &&
    Number.isFinite(options.targetUserMessageOccurrence)
      ? Math.max(1, Math.floor(options.targetUserMessageOccurrence))
      : null;
  const localUserMessageCount =
    typeof options?.localUserMessageCount === "number" &&
    Number.isFinite(options.localUserMessageCount)
      ? Math.max(1, Math.floor(options.localUserMessageCount))
      : null;
  const targetUserMessageText = options?.targetUserMessageText?.trim() || null;
  return invoke<Record<string, unknown> | null | undefined>("fork_thread", {
    workspaceId,
    threadId,
    messageId: messageId ?? null,
    providerProfileId: options?.providerProfileId ?? null,
    targetUserTurnIndex,
    targetUserMessageText,
    targetUserMessageOccurrence,
    localUserMessageCount,
  });
}

export async function rewindCodexThread(
  workspaceId: string,
  threadId: string,
  targetUserTurnIndex: number,
  messageId?: string | null,
  rewindHint?: {
    targetUserMessageText?: string | null;
    targetUserMessageOccurrence?: number | null;
    localUserMessageCount?: number | null;
  },
) {
  const normalizedTargetUserTurnIndex = Number.isFinite(targetUserTurnIndex) ? Math.trunc(targetUserTurnIndex) : Number.NaN;
  if (!(normalizedTargetUserTurnIndex >= 1)) {
    throw new Error("targetUserTurnIndex must be >= 1 for codex rewind");
  }
  const normalizedMessageId = typeof messageId === "string" ? messageId.trim() : "";
  const targetUserMessageText = typeof rewindHint?.targetUserMessageText === "string" ? rewindHint.targetUserMessageText.trim() : "";
  const targetUserMessageOccurrence =
    typeof rewindHint?.targetUserMessageOccurrence === "number" && Number.isFinite(rewindHint.targetUserMessageOccurrence) ? Math.trunc(rewindHint.targetUserMessageOccurrence) : null;
  const localUserMessageCount = typeof rewindHint?.localUserMessageCount === "number" && Number.isFinite(rewindHint.localUserMessageCount) ? Math.trunc(rewindHint.localUserMessageCount) : null;

  return invoke<Record<string, unknown> | null | undefined>("rewind_codex_thread", {
    workspaceId,
    threadId,
    messageId: normalizedMessageId || null,
    targetUserTurnIndex: normalizedTargetUserTurnIndex,
    ...(targetUserMessageText ? { targetUserMessageText } : {}),
    ...(targetUserMessageOccurrence && targetUserMessageOccurrence > 0 ? { targetUserMessageOccurrence } : {}),
    ...(localUserMessageCount && localUserMessageCount > 0 ? { localUserMessageCount } : {}),
  });
}

export async function listThreads(workspaceId: string, cursor?: string | null, limit?: number | null) {
  return traceStartupInvoke("list_threads", workspaceScope(workspaceId), () =>
    invoke<ThreadListPayload | null | undefined>("list_threads", {
      workspaceId,
      cursor,
      limit,
    }),
  );
}

export async function listMcpServerStatus(workspaceId: string, cursor?: string | null, limit?: number | null) {
  return invoke<unknown>("list_mcp_server_status", {
    workspaceId,
    cursor,
    limit,
  });
}

export type GlobalMcpServerEntry = {
  name: string;
  enabled: boolean;
  transport?: string | null;
  command?: string | null;
  url?: string | null;
  argsCount: number;
  source: "claude_json" | "ccgui_config";
};

export async function listGlobalMcpServers() {
  return invoke<GlobalMcpServerEntry[]>("list_global_mcp_servers");
}

export async function setGlobalMcpServerEnabled(
  name: string,
  source: GlobalMcpServerEntry["source"],
  enabled: boolean,
) {
  return invoke<void>("set_global_mcp_server_enabled", {
    name,
    source,
    enabled,
  });
}

export async function resumeThread(workspaceId: string, threadId: string) {
  return invoke<Record<string, unknown> | null>("resume_thread", {
    workspaceId,
    threadId,
  });
}

export async function archiveThread(workspaceId: string, threadId: string) {
  return invoke<Record<string, unknown> | null>("archive_thread", {
    workspaceId,
    threadId,
  });
}

export async function deleteCodexSession(workspaceId: string, sessionId: string) {
  return invoke<{
    deleted: boolean;
    deletedCount: number;
    method: "filesystem";
    archivedBeforeDelete?: boolean;
  }>("delete_codex_session", {
    workspaceId,
    sessionId,
  });
}
export async function deleteCodexSessions(workspaceId: string, sessionIds: string[]) {
  return invoke<{
    results: Array<{
      sessionId: string;
      deleted: boolean;
      deletedCount: number;
      method: "filesystem";
      archivedBeforeDelete?: boolean;
      error?: string | null;
    }>;
  }>("delete_codex_sessions", {
    workspaceId,
    sessionIds,
  });
}
export async function deleteOpenCodeSession(workspaceId: string, sessionId: string) {
  try {
    return await invoke<{ deleted: boolean; method: "cli" | "filesystem" }>(
      "opencode_delete_session",
      { workspaceId, sessionId },
    );
  } finally {
    invalidateOpenCodeSessionListCache(workspaceId);
  }
}

/** Soft TTL so focus-refresh / second full-catalog does not re-scan Claude disk. */
export const CLAUDE_SESSION_LIST_CACHE_TTL_MS = 60_000;

type ClaudeSessionListResult =
  | ClaudeSessionSummaryPayload[]
  | Record<string, unknown>
  | null
  | undefined;

const claudeSessionListCache = createAsyncResultCache<ClaudeSessionListResult>({
  ttlMs: CLAUDE_SESSION_LIST_CACHE_TTL_MS,
});

export function invalidateClaudeSessionListCache(workspacePath?: string): void {
  // Limit is part of key; path-scoped clears currently wipe the whole map
  // (small cache; exact prefix iteration is not worth the complexity yet).
  void workspacePath;
  claudeSessionListCache.clear();
}

/** @internal */
export function resetClaudeSessionListCacheForTests(): void {
  claudeSessionListCache.clear();
}

function claudeSessionListCacheKey(
  workspacePath: string,
  limit?: number | null,
): string {
  return `${workspacePath}::${limit ?? "all"}`;
}

/**
 * List Claude Code session history for a workspace path.
 * Reads JSONL files from ~/.claude/projects/{encoded-path}/.
 *
 * This is a native history/detail source. Workspace session membership should
 * come from listWorkspaceSessions so catalog source status can decide whether
 * an empty Claude result is authoritative.
 */
export async function listClaudeSessions(
  workspacePath: string,
  limit?: number | null,
): Promise<ClaudeSessionListResult> {
  const path = workspacePath.trim();
  if (!path) {
    return [];
  }
  const key = claudeSessionListCacheKey(path, limit);
  const cached = claudeSessionListCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  return claudeSessionListCache.getOrLoad(key, () =>
    traceStartupInvoke("list_claude_sessions", "global", () =>
      invoke<ClaudeSessionListResult>("list_claude_sessions", {
        workspacePath: path,
        limit: limit ?? null,
      }),
    ),
  );
}

/**
 * Load full message history for a specific Claude Code session.
 */
export async function loadClaudeSession(
  workspacePath: string,
  sessionId: string,
  options?: { limit?: number | null; before?: string | null },
): Promise<Record<string, unknown> | null> {
  return invoke<Record<string, unknown> | null>("load_claude_session", {
    workspacePath,
    sessionId,
    limit: options?.limit ?? null,
    before: options?.before ?? null,
  });
}

/**
 * Hydrate one deferred Claude Code history image. This must be called only after
 * explicit user action because it can return a large data URL.
 */
export async function hydrateClaudeDeferredImage(
  workspacePath: string,
  locator: ClaudeDeferredImageLocator,
): Promise<ClaudeHydratedImage> {
  return invoke<ClaudeHydratedImage>("hydrate_claude_deferred_image", {
    workspacePath,
    locator,
  });
}

/**
 * List Gemini CLI session history for a workspace path.
 */
export async function listGeminiSessions(workspacePath: string, limit?: number | null): Promise<Record<string, unknown> | unknown[] | null> {
  return traceStartupInvoke("list_gemini_sessions", "global", () =>
    invoke<Record<string, unknown> | unknown[] | null>("list_gemini_sessions", {
      workspacePath,
      limit: limit ?? null,
    }),
  );
}

/**
 * Load full message history for a specific Gemini CLI session.
 */
export async function loadGeminiSession(workspacePath: string, sessionId: string): Promise<Record<string, unknown> | null> {
  return invoke<Record<string, unknown> | null>("load_gemini_session", {
    workspacePath,
    sessionId,
  });
}

/**
 * Load full Codex local session history for a specific workspace/session.
 */
export async function loadCodexSession(workspaceId: string, sessionId: string): Promise<Record<string, unknown> | null> {
  return invoke<Record<string, unknown> | null>("load_codex_session", {
    workspaceId,
    sessionId,
  });
}

/**
 * Fork a Claude Code session into a new session id.
 */
export async function forkClaudeSession(workspacePath: string, sessionId: string): Promise<Record<string, unknown> | null> {
  return invoke<Record<string, unknown> | null>("fork_claude_session", {
    workspacePath,
    sessionId,
  });
}

/**
 * Fork a Claude Code session from a target user message.
 */
export async function forkClaudeSessionFromMessage(workspacePath: string, sessionId: string, messageId: string): Promise<Record<string, unknown> | null> {
  return invoke<Record<string, unknown> | null>("fork_claude_session_from_message", {
    workspacePath,
    sessionId,
    messageId,
  });
}

/**
 * Delete a Claude Code session (remove JSONL file from disk).
 */
export async function deleteClaudeSession(workspacePath: string, sessionId: string): Promise<void> {
  return invoke<void>("delete_claude_session", {
    workspacePath,
    sessionId,
  });
}

/**
 * Delete a Gemini CLI session (remove session JSON file from disk).
 */
export async function deleteGeminiSession(workspacePath: string, sessionId: string): Promise<void> {
  return invoke<void>("delete_gemini_session", {
    workspacePath,
    sessionId,
  });
}

/**
 * List Kimi CLI session history for a workspace path.
 */
export async function listKimiSessions(workspacePath: string, limit?: number | null): Promise<Record<string, unknown> | unknown[] | null> {
  return traceStartupInvoke("list_kimi_sessions", "global", () =>
    invoke<Record<string, unknown> | unknown[] | null>("list_kimi_sessions", {
      workspacePath,
      limit: limit ?? null,
    }),
  );
}

/**
 * Load full message history for a specific Kimi CLI session.
 */
export async function loadKimiSession(workspacePath: string, sessionId: string): Promise<Record<string, unknown> | null> {
  return invoke<Record<string, unknown> | null>("load_kimi_session", {
    workspacePath,
    sessionId,
  });
}

export async function listPiSessions(
  workspacePath: string,
  limit?: number | null,
): Promise<Record<string, unknown> | unknown[] | null> {
  return traceStartupInvoke("list_pi_sessions", "global", () =>
    invoke<Record<string, unknown> | unknown[] | null>("list_pi_sessions", {
      workspacePath,
      limit: limit ?? null,
    }),
  );
}

export async function loadPiSession(
  workspacePath: string,
  sessionId: string,
): Promise<Record<string, unknown> | null> {
  return invoke<Record<string, unknown> | null>("load_pi_session", {
    workspacePath,
    sessionId,
  });
}

export async function deletePiSession(
  workspacePath: string,
  sessionId: string,
): Promise<void> {
  return invoke<void>("delete_pi_session", {
    workspacePath,
    sessionId,
  });
}

export async function listQoderSessions(
  workspacePath: string,
  limit?: number | null,
  providerProfileId?: string | null,
): Promise<Record<string, unknown> | unknown[] | null> {
  return traceStartupInvoke("list_qoder_sessions", "global", () =>
    invoke<Record<string, unknown> | unknown[] | null>("list_qoder_sessions", {
      workspacePath,
      limit: limit ?? null,
      providerProfileId: providerProfileId ?? null,
    }),
  );
}

export async function loadQoderSession(
  workspacePath: string,
  sessionId: string,
  providerProfileId?: string | null,
): Promise<Record<string, unknown> | null> {
  return invoke<Record<string, unknown> | null>("load_qoder_session", {
    workspacePath,
    sessionId,
    providerProfileId: providerProfileId ?? null,
  });
}

export async function deleteQoderSession(
  workspacePath: string,
  sessionId: string,
  providerProfileId?: string | null,
): Promise<void> {
  return invoke<void>("delete_qoder_session", {
    workspacePath,
    sessionId,
    providerProfileId: providerProfileId ?? null,
  });
}

/**
 * Delete a Kimi CLI session (remove session file from disk).
 */
export async function deleteKimiSession(workspacePath: string, sessionId: string): Promise<void> {
  return invoke<void>("delete_kimi_session", {
    workspacePath,
    sessionId,
  });
}

/**
 * List Grok CLI session history for a workspace path.
 */
export async function listGrokSessions(workspacePath: string, limit?: number | null): Promise<Record<string, unknown> | unknown[] | null> {
  return traceStartupInvoke("list_grok_sessions", "global", () =>
    invoke<Record<string, unknown> | unknown[] | null>("list_grok_sessions", {
      workspacePath,
      limit: limit ?? null,
    }),
  );
}

/**
 * Load full message history for a specific Grok CLI session.
 */
export async function loadGrokSession(workspacePath: string, sessionId: string): Promise<Record<string, unknown> | null> {
  return invoke<Record<string, unknown> | null>("load_grok_session", {
    workspacePath,
    sessionId,
  });
}

/**
 * Delete a Grok CLI session (remove session file from disk).
 */
export async function deleteGrokSession(workspacePath: string, sessionId: string): Promise<void> {
  return invoke<void>("delete_grok_session", {
    workspacePath,
    sessionId,
  });
}

/**
 * List DSH host sessions for a workspace path.
 */
export async function listDshSessions(workspacePath: string, limit?: number | null): Promise<Record<string, unknown> | unknown[] | null> {
  return traceStartupInvoke("list_dsh_sessions", "global", () =>
    invoke<Record<string, unknown> | unknown[] | null>("list_dsh_sessions", {
      workspacePath,
      limit: limit ?? null,
    }),
  );
}

/**
 * Load DSH session history. Does not resume the agent.
 * `limit` is a folded-message budget (default 200 = one host page).
 * `before` continues from a previous `nextCursor`.
 */
export async function loadDshSession(
  workspacePath: string,
  sessionId: string,
  options?: { limit?: number | null; before?: string | null },
): Promise<Record<string, unknown> | null> {
  return invoke<Record<string, unknown> | null>("load_dsh_session", {
    workspacePath,
    sessionId,
    limit: options?.limit ?? null,
    before: options?.before ?? null,
  });
}

/**
 * Archive a DSH session via the host.
 */
export async function deleteDshSession(workspacePath: string, sessionId: string): Promise<void> {
  return invoke<void>("delete_dsh_session", {
    workspacePath,
    sessionId,
  });
}

/**
 * Fork a completed DSH session. Incomplete turns fail closed.
 */
export async function forkDshSession(
  workspacePath: string,
  sessionId: string,
): Promise<Record<string, unknown> | null> {
  return invoke<Record<string, unknown> | null>("fork_dsh_session", {
    workspacePath,
    sessionId,
  });
}
