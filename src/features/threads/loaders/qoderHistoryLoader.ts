import type { HistoryLoader } from "../contracts/conversationCurtainContracts";
import { normalizeHistorySnapshot } from "../contracts/conversationCurtainContracts";
import type { HistoryLoadingProgressListener } from "../utils/historyLoadingProgress";
import { runNativeHistoryFetchAndParse } from "../utils/runNativeHistoryOpenStages";
import { parseQoderHistoryMessages } from "./qoderHistoryParser";
import { parseQoderSessionIdentity } from "../utils/qoderSessionIdentity";

type QoderHistoryLoaderOptions = {
  workspaceId: string;
  workspacePath: string | null;
  providerProfileId?: string | null;
  loadQoderSession: (
    workspacePath: string,
    sessionId: string,
    providerProfileId?: string | null,
  ) => Promise<unknown>;
  onProgress?: HistoryLoadingProgressListener;
};

export function createQoderHistoryLoader({
  workspaceId,
  workspacePath,
  providerProfileId,
  loadQoderSession,
  onProgress,
}: QoderHistoryLoaderOptions): HistoryLoader {
  return {
    engine: "qoder",
    async load(threadId: string) {
      const identity = parseQoderSessionIdentity(threadId, providerProfileId);
      if (!identity) {
        throw new Error("Qoder session identity is invalid or conflicts with its distribution");
      }
      const sessionId = identity.rawSessionId;
      if (!workspacePath) {
        return normalizeHistorySnapshot({
          engine: "qoder",
          workspaceId,
          threadId,
          meta: {
            workspaceId,
            threadId,
            engine: "qoder",
            activeTurnId: null,
            isThinking: false,
            heartbeatPulse: null,
            historyRestoredAtMs: Date.now(),
          },
        });
      }

      const staged = await runNativeHistoryFetchAndParse({
        report: (progress) => {
          onProgress?.(progress);
        },
        shouldContinue: () => true,
        load: () =>
          loadQoderSession(
            workspacePath,
            sessionId,
            identity.providerProfileId,
          ),
        extractMessages: (payload) =>
          ((payload ?? {}) as { messages?: unknown }).messages ?? payload,
        parse: parseQoderHistoryMessages,
      });
      const items = staged?.items ?? [];

      return normalizeHistorySnapshot({
        engine: "qoder",
        workspaceId,
        threadId,
        items,
        plan: null,
        userInputQueue: [],
        meta: {
          workspaceId,
          threadId,
          engine: "qoder",
          activeTurnId: null,
          isThinking: false,
          heartbeatPulse: null,
          historyRestoredAtMs: Date.now(),
          historyHasMore: false,
          historyNextCursor: null,
        },
      });
    },
  };
}
