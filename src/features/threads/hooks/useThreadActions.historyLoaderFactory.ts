import {
  loadCodexSession as loadCodexSessionService,
  loadClaudeSession as loadClaudeSessionService,
  loadGeminiSession as loadGeminiSessionService,
  loadGrokSession as loadGrokSessionService,
  loadKimiSession as loadKimiSessionService,
  loadPiSession as loadPiSessionService,
  loadQoderSession as loadQoderSessionService,
  loadDshSession as loadDshSessionService,
  resumeThread as resumeThreadService,
} from "../../../services/tauri";
import { createClaudeHistoryLoader } from "../loaders/claudeHistoryLoader";
import { createCodexHistoryLoader } from "../loaders/codexHistoryLoader";
import { createGeminiHistoryLoader } from "../loaders/geminiHistoryLoader";
import { createGrokHistoryLoader } from "../loaders/grokHistoryLoader";
import { createKimiHistoryLoader } from "../loaders/kimiHistoryLoader";
import { createPiHistoryLoader } from "../loaders/piHistoryLoader";
import { createQoderHistoryLoader } from "../loaders/qoderHistoryLoader";
import { createDshHistoryLoader } from "../loaders/dshHistoryLoader";
import { createOpenCodeHistoryLoader } from "../loaders/opencodeHistoryLoader";
import { createSharedHistoryLoader } from "../loaders/sharedHistoryLoader";
import {
  loadSharedProjection as loadSharedProjectionService,
  loadSharedSession as loadSharedSessionService,
} from "../../shared-session/services/sharedSessions";
import type { NormalizedHistorySnapshot } from "../contracts/conversationCurtainContracts";
import type { HistoryLoadingProgressListener } from "../utils/historyLoadingProgress";

export function createThreadHistoryLoaderForThread({
  targetThreadId,
  workspaceId,
  workspacePath,
  providerProfileId,
  preferLocalCodexHistory,
  onHistoryProgress,
  projectionTimeoutMs,
  onSharedPhaseAReady,
  onSharedProjectionMerged,
}: {
  targetThreadId: string;
  workspaceId: string;
  workspacePath: string | null;
  providerProfileId?: string | null;
  preferLocalCodexHistory: boolean;
  onHistoryProgress?: HistoryLoadingProgressListener;
  /** Shared projection soft-timeout (ms); see sharedHistoryLoader. */
  projectionTimeoutMs?: number;
  /**
   * Shared only: V0 session snapshot is ready. Caller hydrates and clears
   * the blocking history-loading curtain without waiting for projection.
   */
  onSharedPhaseAReady?: (snapshot: NormalizedHistorySnapshot) => void;
  /**
   * Shared only: projection finished after Phase-A V0 returned (soft-timeout path).
   * Caller applies with resume-generation / live-turn guards.
   */
  onSharedProjectionMerged?: (snapshot: NormalizedHistorySnapshot) => void;
}) {
  if (targetThreadId.startsWith("shared:")) {
    return createSharedHistoryLoader({
      workspaceId,
      loadSharedSession: loadSharedSessionService,
      loadSharedProjection: loadSharedProjectionService,
      onProgress: onHistoryProgress,
      projectionTimeoutMs,
      onPhaseAReady: onSharedPhaseAReady,
      onProjectionMerged: onSharedProjectionMerged,
    });
  }
  if (targetThreadId.startsWith("claude:")) {
    return createClaudeHistoryLoader({
      workspaceId,
      workspacePath,
      loadClaudeSession: loadClaudeSessionService,
      onProgress: onHistoryProgress,
    });
  }
  if (targetThreadId.startsWith("gemini:")) {
    return createGeminiHistoryLoader({
      workspaceId,
      workspacePath,
      loadGeminiSession: loadGeminiSessionService,
    });
  }
  if (targetThreadId.startsWith("grok:")) {
    return createGrokHistoryLoader({
      workspaceId,
      workspacePath,
      loadGrokSession: loadGrokSessionService,
      onProgress: onHistoryProgress,
    });
  }
  if (targetThreadId.startsWith("kimi:")) {
    return createKimiHistoryLoader({
      workspaceId,
      workspacePath,
      loadKimiSession: loadKimiSessionService,
      onProgress: onHistoryProgress,
    });
  }
  if (targetThreadId.startsWith("pi:")) {
    return createPiHistoryLoader({
      workspaceId,
      workspacePath,
      loadPiSession: loadPiSessionService,
      onProgress: onHistoryProgress,
    });
  }
  if (targetThreadId.startsWith("qoder:")) {
    return createQoderHistoryLoader({
      workspaceId,
      workspacePath,
      providerProfileId,
      loadQoderSession: loadQoderSessionService,
      onProgress: onHistoryProgress,
    });
  }
  if (targetThreadId.startsWith("dsh:")) {
    return createDshHistoryLoader({
      workspaceId,
      workspacePath,
      loadDshSession: loadDshSessionService,
      onProgress: onHistoryProgress,
    });
  }
  if (targetThreadId.startsWith("opencode:")) {
    return createOpenCodeHistoryLoader({
      workspaceId,
      resumeThread: resumeThreadService,
    });
  }
  return createCodexHistoryLoader({
    workspaceId,
    resumeThread: resumeThreadService,
    loadCodexSession: loadCodexSessionService,
    preferLocalHistory: preferLocalCodexHistory,
  });
}
