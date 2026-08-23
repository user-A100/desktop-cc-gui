import type { Dispatch, MutableRefObject } from "react";
import type { WorkspaceScopedMap } from "./workspaceScopedMap";
import type {
  CollaborationModeResolvedRequest,
  DebugEntry,
} from "../../../types";
import type { ThreadAction } from "./useThreadsReducer";
import type { DomainEventRuntimeController } from "../domain-events";
import type { TurnExecutionSnapshot } from "../../shared-session/target/types";

export type ThreadEventHandlersOptions = {
  activeThreadId: string | null;
  dispatch: Dispatch<ThreadAction>;
  getCustomName: (workspaceId: string, threadId: string) => string | undefined;
  resolveCanonicalThreadId?: (threadId: string) => string;
  resolveCollaborationUiMode?: (
    threadId: string,
  ) => "plan" | "code" | null;
  isAutoTitlePending: (workspaceId: string, threadId: string) => boolean;
  isThreadHidden: (workspaceId: string, threadId: string) => boolean;
  markProcessing: (threadId: string, isProcessing: boolean) => void;
  markReviewing: (threadId: string, isReviewing: boolean) => void;
  setActiveTurnId: (threadId: string, turnId: string | null) => void;
  codexCompactionInFlightByThreadRef: MutableRefObject<Record<string, boolean>>;
  safeMessageActivity: () => void;
  recordThreadActivity: (
    workspaceId: string,
    threadId: string,
    timestamp?: number,
  ) => void;
  pushThreadErrorMessage: (
    workspaceId: string,
    threadId: string,
    message: string,
    executionTargetSnapshot?: TurnExecutionSnapshot,
  ) => void;
  onDebug?: (entry: DebugEntry) => void;
  onWorkspaceConnected: (workspaceId: string) => void;
  applyCollabThreadLinks: (
    threadId: string,
    item: Record<string, unknown>,
    workspaceId?: string,
  ) => void;
  approvalAllowlistRef: MutableRefObject<Record<string, string[][]>>;
  pendingInterruptsRef: MutableRefObject<WorkspaceScopedMap<true>>;
  interruptedThreadsRef: MutableRefObject<WorkspaceScopedMap<true>>;
  renameCustomNameKey: (
    workspaceId: string,
    oldThreadId: string,
    newThreadId: string,
  ) => void;
  renameAutoTitlePendingKey: (
    workspaceId: string,
    oldThreadId: string,
    newThreadId: string,
  ) => void;
  renameThreadTitleMapping: (
    workspaceId: string,
    oldThreadId: string,
    newThreadId: string,
  ) => Promise<void>;
  resolveClaudeContinuationThreadId?: (
    workspaceId: string,
    threadId: string,
    turnId?: string | null,
  ) => string | null;
  resolvePendingThreadForSession?: (
    workspaceId: string,
    engine: "claude" | "gemini" | "grok" | "kimi" | "opencode" | "pi" | "dsh" | "qoder",
  ) => string | null;
  resolvePendingThreadForTurn?: (
    workspaceId: string,
    engine: "claude" | "gemini" | "grok" | "kimi" | "opencode" | "pi" | "dsh" | "qoder",
    turnId: string | null | undefined,
  ) => string | null;
  getActiveTurnIdForThread?: (threadId: string) => string | null;
  getThreadProviderProfileId?: (
    workspaceId: string,
    threadId: string,
  ) => string | null | undefined;
  hasEstablishedThreadItems?: (threadId: string) => boolean;
  renamePendingMemoryCaptureKey: (
    oldThreadId: string,
    newThreadId: string,
  ) => void;
  onAgentMessageCompletedExternal?: (payload: {
    workspaceId: string;
    threadId: string;
    turnId?: string | null;
    itemId: string;
    text: string;
  }) => void;
  onTurnCompletedExternal?: (payload: {
    workspaceId: string;
    threadId: string;
    turnId: string;
  }) => void;
  onTurnTerminalExternal?: (payload: {
    workspaceId: string;
    threadId: string;
    turnId: string;
    rawTurnId?: string | null;
    status: "completed" | "error" | "stalled";
  }) => void;
  onThreadTransientCleanupReady?: (
    cleanup: (workspaceId: string | null | undefined, threadId: string) => number,
  ) => () => void;
  onDurableRealtimeTurnSettlementReady?: (
    settle: (threadId: string, runtimeTurnId: string) => void,
  ) => () => void;
  onCollaborationModeResolved?: (
    event: CollaborationModeResolvedRequest,
  ) => void;
  onExitPlanModeToolCompleted?: (payload: {
    workspaceId: string;
    threadId: string;
    itemId: string;
  }) => void;
  domainEventController?: DomainEventRuntimeController | null;
};
