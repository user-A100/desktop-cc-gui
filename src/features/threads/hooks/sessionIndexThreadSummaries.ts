import type { ThreadSummary } from "../../../types";
import type { SessionIndexRow } from "../../../services/tauri";
import { previewThreadName } from "../../../utils/threadItems";
import { sanitizeNativeSessionTitle } from "../utils/sessionDisplayProjection";
import {
  isCodexBackgroundHelperPreview,
  isCommitMessageHelperPreview,
} from "../utils/codexBackgroundHelpers";
import { isMossxProgramControlTitle } from "../../../utils/contextProtocol";
import { shouldExcludeOrdinaryNativeRow } from "./sharedNativeVisibility";
import { isWeakSessionDisplayTitle } from "../utils/sessionDisplayProjection";
import {
  compareThreadSummariesByCreatedAtDesc,
  pickStableCreatedAt,
} from "../utils/threadSummarySort";
import {
  canonicalQoderThreadId,
  parseQoderSessionIdentity,
} from "../utils/qoderSessionIdentity";

const GENERIC_EMPTY_SESSION_TITLE =
  /^(?:(?:claude|codex|gemini|grok|kimi|pi|qoder|opencode|dsh) session(?:\s+[a-f0-9-]{4,40})?|deepseek harness session)$/i;

const PLACEHOLDER_DRAFT_ENGINES = new Set([
  "claude",
  "codex",
  "gemini",
  "grok",
  "kimi",
  "pi",
  "qoder",
  "opencode",
  "dsh",
]);

/** Index fallback for empty native transcripts. Live list never emits these titles. */
export function isEmptyNativeIndexFallbackTitle(
  value: string | null | undefined,
): boolean {
  return GENERIC_EMPTY_SESSION_TITLE.test(String(value ?? "").trim());
}

export function shouldHidePlaceholderNativeDraftFromSidebar(params: {
  engine: string | null | undefined;
  threadId: string;
  displayName: string;
  hasCustomName?: boolean;
  isActive?: boolean;
  isChildSession?: boolean;
}): boolean {
  if (params.hasCustomName || params.isActive || params.isChildSession) {
    return false;
  }
  const engine = String(params.engine ?? "")
    .trim()
    .toLowerCase();
  const pendingEngine = engine || inferEngineFromPendingThreadId(params.threadId);
  if (isLocalPendingDraftThreadId(pendingEngine, params.threadId)) {
    return true;
  }
  if (PLACEHOLDER_DRAFT_ENGINES.has(engine) && isEmptyNativeIndexFallbackTitle(params.displayName)) {
    return true;
  }
  return isWeakSessionDisplayTitle(params.displayName);
}

export function isEmptyClaudeIndexFallbackTitle(
  value: string | null | undefined,
): boolean {
  return isEmptyNativeIndexFallbackTitle(value);
}

function isEmptyNativeIndexFallbackSummary(summary: {
  engineSource?: ThreadSummary["engineSource"];
  name: string;
}): boolean {
  if (isEmptyNativeIndexFallbackTitle(summary.name)) {
    return true;
  }
  if (isMossxProgramControlTitle(summary.name)) {
    return true;
  }
  return (
    summary.engineSource === "codex" &&
    isCodexBackgroundHelperPreview(summary.name)
  );
}

const ENGINE_PREFIX: Record<string, string> = {
  claude: "claude:",
  codex: "",
  gemini: "gemini:",
  grok: "grok:",
  kimi: "kimi:",
  pi: "pi:",
  qoder: "qoder:",
  opencode: "opencode:",
  dsh: "dsh:",
};

function normalizeEngine(
  engine: string | null | undefined,
): ThreadSummary["engineSource"] | null {
  const value = String(engine ?? "")
    .trim()
    .toLowerCase();
  if (
    value === "claude" ||
    value === "codex" ||
    value === "gemini" ||
    value === "grok" ||
    value === "kimi" ||
    value === "pi" ||
    value === "qoder" ||
    value === "opencode" ||
    value === "dsh"
  ) {
    return value;
  }
  return null;
}

export function sessionIndexRowToThreadId(row: SessionIndexRow): string | null {
  const engine = normalizeEngine(row.engine);
  const sessionId = String(row.sessionId ?? "").trim();
  if (!engine || !sessionId) {
    return null;
  }
  if (engine === "qoder") {
    return canonicalQoderThreadId(sessionId, row.providerProfileId);
  }
  if (sessionId.includes(":")) {
    return sessionId;
  }
  const prefix = ENGINE_PREFIX[engine] ?? `${engine}:`;
  return `${prefix}${sessionId}`;
}

export function sessionIndexRowsToThreadSummaries(
  rows: SessionIndexRow[],
  options: {
    workspaceId: string;
    mappedTitles: Record<string, string>;
    getCustomName: (workspaceId: string, threadId: string) => string | undefined;
    hiddenSharedBindingIds?: Set<string>;
  },
): ThreadSummary[] {
  const hidden = options.hiddenSharedBindingIds ?? new Set<string>();
  const out: ThreadSummary[] = [];
  for (const row of rows) {
    const engine = normalizeEngine(row.engine);
    const id = sessionIndexRowToThreadId(row);
    if (!engine || !id) {
      continue;
    }
    if (
      shouldExcludeOrdinaryNativeRow(id, hidden) ||
      shouldExcludeOrdinaryNativeRow(row.sessionId, hidden)
    ) {
      continue;
    }
    if (
      isCommitMessageHelperPreview(String(row.title ?? "")) ||
      isCommitMessageHelperPreview(String(row.nativeTitle ?? "")) ||
      (engine === "codex" &&
        (isCodexBackgroundHelperPreview(String(row.title ?? "")) ||
          isCodexBackgroundHelperPreview(String(row.nativeTitle ?? ""))))
    ) {
      continue;
    }
    if (
      isMossxProgramControlTitle(row.title) ||
      isMossxProgramControlTitle(row.nativeTitle)
    ) {
      continue;
    }
    const nativeTitle = sanitizeNativeSessionTitle(
      String(row.nativeTitle ?? "").trim(),
    );
    const title = String(row.title ?? "").trim();
    const fallback =
      engine === "claude"
        ? "Claude Session"
        : engine === "codex"
          ? "Codex Session"
          : engine === "kimi"
            ? "Kimi Session"
            : engine === "gemini"
              ? "Gemini Session"
              : engine === "grok"
                ? "Grok Session"
                : engine === "pi"
                  ? "PI Session"
                  : engine === "qoder"
                    ? "Qoder Session"
                    : engine === "dsh"
                    ? "DeepSeek Harness Session"
                    : "Session";
    const mappedTitle = options.mappedTitles[id];
    const customName =
      options.getCustomName(options.workspaceId, id) || mappedTitle;
    const name =
      customName ||
      nativeTitle ||
      (title ? previewThreadName(title, fallback) : fallback);
    if (
      shouldHidePlaceholderNativeDraftFromSidebar({
        engine,
        threadId: id,
        displayName: name,
        hasCustomName: Boolean(customName),
      })
    ) {
      continue;
    }
    const updatedAt =
      typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt)
        ? Math.max(0, row.updatedAt)
        : 0;
    const createdAt = pickStableCreatedAt(row.createdAt, updatedAt);
    const sizeBytes =
      typeof row.sizeBytes === "number" && Number.isFinite(row.sizeBytes)
        ? Math.max(0, row.sizeBytes)
        : undefined;
    const parentRaw = String(row.parentSessionId ?? "").trim();
    const parentThreadId = parentRaw
      ? engine === "qoder"
        ? canonicalQoderThreadId(parentRaw, row.providerProfileId)
        : parentRaw.includes(":")
          ? parentRaw
          : `${ENGINE_PREFIX[engine] ?? `${engine}:`}${parentRaw}`
      : null;
    const qoderIdentity =
      engine === "qoder"
        ? parseQoderSessionIdentity(row.sessionId, row.providerProfileId)
        : null;
    out.push({
      id,
      name,
      updatedAt,
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      ...(row.physicalPath
        ? { physicalPath: String(row.physicalPath) }
        : {}),
      engineSource: engine,
      threadKind: "native",
      ...(parentThreadId ? { parentThreadId } : {}),
      ...(qoderIdentity?.providerProfileId || row.providerProfileId
        ? {
            providerProfileId:
              qoderIdentity?.providerProfileId ?? String(row.providerProfileId),
          }
        : {}),
      ...(row.providerProfileName
        ? { providerProfileName: String(row.providerProfileName) }
        : {}),
    });
  }
  return out;
}

/**
 * Seed index rows into an existing merge map without overwriting newer live rows.
 */
export function mergeSessionIndexRowsIntoSummaries(
  existing: ThreadSummary[],
  indexRows: SessionIndexRow[],
  options: {
    workspaceId: string;
    mappedTitles: Record<string, string>;
    getCustomName: (workspaceId: string, threadId: string) => string | undefined;
    hiddenSharedBindingIds?: Set<string>;
  },
): ThreadSummary[] {
  const byId = new Map(existing.map((row) => [row.id, row]));
  const indexSummaries = sessionIndexRowsToThreadSummaries(indexRows, options);
  for (const summary of indexSummaries) {
    const prev = byId.get(summary.id);
    if (prev && summary.updatedAt < prev.updatedAt) {
      const createdAt = pickStableCreatedAt(prev.createdAt, summary.createdAt);
      if (createdAt != null && createdAt !== prev.createdAt) {
        byId.set(prev.id, { ...prev, createdAt });
      }
      continue;
    }
    // Prefer live/catalog identity fields when present.
    byId.set(
      summary.id,
      prev
        ? {
            ...summary,
            name: prev.name || summary.name,
            folderId: prev.folderId ?? summary.folderId,
            autoSession: prev.autoSession ?? summary.autoSession,
            providerProfileId:
              prev.providerProfileId ?? summary.providerProfileId,
            providerProfileName:
              prev.providerProfileName ?? summary.providerProfileName,
            parentThreadId: prev.parentThreadId ?? summary.parentThreadId,
            dshAgentPreset: prev.dshAgentPreset ?? summary.dshAgentPreset,
            createdAt: pickStableCreatedAt(
              prev.createdAt,
              summary.createdAt,
              prev.updatedAt,
            ),
          }
        : summary,
    );
  }
  return Array.from(byId.values()).sort(compareThreadSummariesByCreatedAtDesc);
}

/** last-good / early-paint 不得把 Index 已丢掉的空 native Session 救回来。 */
export function stripEmptyClaudeIndexFallbackSummaries(
  summaries: ThreadSummary[],
): ThreadSummary[] {
  if (summaries.length === 0) {
    return summaries;
  }
  let changed = false;
  const next = summaries.filter((summary) => {
    if (summary.threadKind === "shared" || summary.id.startsWith("shared:")) {
      return true;
    }
    const engine = summary.engineSource;
    // Catalog nicknames like `Agent 12` are weak but real Codex titles.
    // Do not reuse the Index/sidebar leftover-Agent-N predicate here.
    const hidePendingDraft = shouldHidePlaceholderNativeDraftFromSidebar({
      engine,
      threadId: summary.id,
      displayName: summary.name,
    }) && !/^agent\s+\d+$/i.test(summary.name.trim());
    const hideLegacyClaudeCodex =
      (engine === "claude" || engine === "codex") &&
      isEmptyNativeIndexFallbackSummary(summary);
    if (!hidePendingDraft && !hideLegacyClaudeCodex) {
      return true;
    }
    changed = true;
    return false;
  });
  return changed ? next : summaries;
}

export function filterSessionIndexRowsByEngine(
  rows: SessionIndexRow[],
  engine: string,
): SessionIndexRow[] {
  const wanted = engine.trim().toLowerCase();
  if (!wanted) {
    return [];
  }
  return rows.filter(
    (row) => String(row.engine ?? "").trim().toLowerCase() === wanted,
  );
}

function summaryEngineKey(summary: ThreadSummary): string {
  const id = String(summary.id ?? "").trim();
  if (summary.threadKind === "shared" || id.startsWith("shared:")) {
    return "shared";
  }
  const engine = String(summary.engineSource ?? "")
    .trim()
    .toLowerCase();
  if (engine) {
    return engine;
  }
  const prefix = id.split(":")[0]?.toLowerCase() ?? "";
  return prefix || "codex";
}

/**
 * Client "new session" drafts: `{engine}-pending-{millis}-{nonce}`.
 * Index projection prefixes some engines (`grok:grok-pending-...`).
 * Shared / subagent placeholders are not local drafts.
 */
const LOCAL_PENDING_DRAFT_PATTERN =
  /^([a-z][a-z0-9]*)-pending-(\d{10,16})-([a-z0-9]{4,12})$/i;

function inferEngineFromPendingThreadId(threadId: string): string {
  const raw = threadId.trim();
  const bare = raw.includes(":")
    ? raw.slice(raw.indexOf(":") + 1).trim()
    : raw;
  const match = LOCAL_PENDING_DRAFT_PATTERN.exec(bare);
  return match?.[1]?.toLowerCase() ?? "";
}

export function isLocalPendingDraftSessionId(sessionId: string): boolean {
  return LOCAL_PENDING_DRAFT_PATTERN.test(sessionId.trim());
}

export function isLocalPendingDraftThreadId(
  engine: string | null | undefined,
  threadId: string,
): boolean {
  const wanted = String(engine ?? "")
    .trim()
    .toLowerCase();
  const raw = threadId.trim();
  if (!wanted || !raw || wanted === "shared") {
    return false;
  }
  const bare = raw.includes(":")
    ? raw.slice(raw.indexOf(":") + 1).trim()
    : raw;
  const match = LOCAL_PENDING_DRAFT_PATTERN.exec(bare);
  if (!match) {
    return false;
  }
  return match[1].toLowerCase() === wanted;
}

/**
 * Index-only first-paint can return a partial engine set. Keep last-good /
 * snapshot rows for engines the Index page did not include so the list still
 * shows every native type the workspace already knew about.
 * Stale local pending drafts must not come back after Index tombstone.
 */
export function mergeSummariesForMissingEngines(
  incoming: ThreadSummary[],
  continuity: ThreadSummary[],
): ThreadSummary[] {
  if (continuity.length === 0) {
    return incoming;
  }
  const present = new Set(incoming.map(summaryEngineKey));
  const incomingIds = new Set(incoming.map((row) => row.id));
  const extras = continuity.filter((row) => {
    if (!row.id || incomingIds.has(row.id)) {
      return false;
    }
    if (isLocalPendingDraftThreadId(summaryEngineKey(row), row.id)) {
      return false;
    }
    return !present.has(summaryEngineKey(row));
  });
  if (extras.length === 0) {
    return incoming;
  }
  return [...incoming, ...extras].sort(compareThreadSummariesByCreatedAtDesc);
}
