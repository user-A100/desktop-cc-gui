import type { ThreadSummary } from "../../../types";
import type { SessionIndexRow } from "../../../services/tauri";
import {
  sessionIndexRowsToThreadSummaries,
  stripEmptyClaudeIndexFallbackSummaries,
} from "./sessionIndexThreadSummaries";
import { unionIndexWithNewerLastGood } from "./useThreadActions.lastGoodSnapshots";
import { mergePreservedSharedThreadsForIndexFirstPaint } from "./sharedNativeVisibility";
import { stripHiddenSharedBindingSummaries } from "./useThreadActions.helpers";

const DEFERRED_UNREADY_NATIVE_ENGINES = new Set(["grok", "pi", "qoder"]);

/**
 * Native `listThreadsForWorkspace` projection extract.
 * Session Index is the sidebar read layer.
 * Hide unreadiness keeps last-good / already-shown natives, but MUST NOT
 * full-show newly scanned grok/pi/qoder rows until Shared hide is ready.
 */
export function selectNativeSessionIndexRows<T>(rows: readonly T[]): T[] {
  return [...rows];
}

export function shouldRememberHideUnreadiness(visibilityReady: boolean): boolean {
  return !visibilityReady;
}

export function projectNativeIndexRowsToSummaries(
  rows: readonly SessionIndexRow[],
  options: {
    workspaceId: string;
    mappedTitles: Record<string, string>;
    getCustomName: (workspaceId: string, threadId: string) => string | undefined;
    hiddenSharedBindingIds?: Set<string>;
  },
): ThreadSummary[] {
  return sessionIndexRowsToThreadSummaries(
    selectNativeSessionIndexRows(rows),
    options,
  );
}

export function shouldDeferNativeIndexRowUntilHideReady(
  summary: Pick<ThreadSummary, "id" | "threadKind" | "engineSource">,
  options: { hideReady: boolean; keepIds: ReadonlySet<string> },
): boolean {
  if (options.hideReady) {
    return false;
  }
  if (summary.threadKind === "shared" || summary.id.startsWith("shared:")) {
    return false;
  }
  const engine = summary.engineSource ?? "";
  if (!DEFERRED_UNREADY_NATIVE_ENGINES.has(engine)) {
    return false;
  }
  return !options.keepIds.has(summary.id);
}

export function buildNativeIndexEarlyPaintSummaries(params: {
  rows: readonly SessionIndexRow[];
  workspaceId: string;
  getCustomName: (workspaceId: string, threadId: string) => string | undefined;
  hideSet: Set<string>;
  currentThreads: ThreadSummary[] | undefined;
  lastGood: ThreadSummary[];
  hideReady?: boolean;
}): ThreadSummary[] {
  const painted = stripEmptyClaudeIndexFallbackSummaries(
    stripHiddenSharedBindingSummaries(
      unionIndexWithNewerLastGood(
        mergePreservedSharedThreadsForIndexFirstPaint(
          projectNativeIndexRowsToSummaries(params.rows, {
            workspaceId: params.workspaceId,
            mappedTitles: {},
            getCustomName: params.getCustomName,
            hiddenSharedBindingIds: params.hideSet,
          }),
          params.currentThreads,
          params.lastGood,
        ),
        [...(params.currentThreads ?? []), ...params.lastGood],
      ),
      params.hideSet,
    ),
  );
  if (params.hideReady !== false) {
    return painted;
  }
  const keepIds = new Set<string>([
    ...(params.currentThreads ?? []).map((thread) => thread.id),
    ...params.lastGood.map((thread) => thread.id),
  ]);
  return painted.filter(
    (summary) =>
      !shouldDeferNativeIndexRowUntilHideReady(summary, {
        hideReady: false,
        keepIds,
      }),
  );
}
