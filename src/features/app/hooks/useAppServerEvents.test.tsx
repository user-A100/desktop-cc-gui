// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppServerEvent } from "../../../types";
import {
  subscribeAppServerEvents,
  subscribeRawAppServerEvents,
} from "../../../services/events";
import {
  clearSharedSessionBindingsForSharedThread,
  registerSharedSessionNativeBinding,
  resolveSharedSessionBindingByNativeThread,
} from "../../shared-session/runtime/sharedSessionBridge";
import {
  QODER_CN_PROVIDER_PROFILE_ID,
  QODER_GLOBAL_PROVIDER_PROFILE_ID,
} from "../../threads/constants/codexProviderProfiles";
import { setSharedV2SendOverride } from "../../shared-session/runtime/sharedV2SendFlag";
import {
  beginTurn,
  resetSharedTargetStoreForTests,
} from "../../shared-session/target/targetStore";
import { freezeTurnSnapshot } from "../../shared-session/target/types";
import { updateSharedSessionNativeBinding as updateSharedSessionNativeBindingService } from "../../shared-session/services/sharedSessions";
import { useAppServerEvents } from "./useAppServerEvents";

vi.mock("../../../services/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../services/events")>();
  return {
    ...actual,
    subscribeAppServerEvents: vi.fn(),
    subscribeRawAppServerEvents: vi.fn(),
  };
});

vi.mock("../../shared-session/services/sharedSessions", () => ({
  updateSharedSessionNativeBinding: vi.fn(() => Promise.resolve(null)),
}));

type Handlers = Parameters<typeof useAppServerEvents>[0];
type HookOptions = Parameters<typeof useAppServerEvents>[1];

function TestHarness({
  handlers,
  options,
}: {
  handlers: Handlers;
  options?: HookOptions;
}) {
  useAppServerEvents(handlers, options);
  return null;
}

let listener: ((event: AppServerEvent) => void) | null = null;
const unlisten = vi.fn();

beforeEach(() => {
  listener = null;
  unlisten.mockReset();
  resetSharedTargetStoreForTests();
  setSharedV2SendOverride(null);
  vi.mocked(subscribeAppServerEvents).mockImplementation((cb) => {
    listener = cb;
    return unlisten;
  });
  vi.mocked(subscribeRawAppServerEvents).mockImplementation((cb) => {
    listener = cb;
    return unlisten;
  });
});

afterEach(() => {
  setSharedV2SendOverride(null);
  vi.clearAllMocks();
});

async function mount(handlers: Handlers, options?: HookOptions) {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(<TestHarness handlers={handlers} options={options} />);
  });
  return { root };
}

describe("useAppServerEvents", () => {
  it("quarantines provider continuation bootstrap events from conversation handlers", async () => {
    const handlers: Handlers = {
      onAppServerEvent: vi.fn(),
      onTurnStarted: vi.fn(),
      onAgentMessageDelta: vi.fn(),
      onReasoningTextDelta: vi.fn(),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-1",
        message: {
          method: "turn/started",
          params: {
            threadId: "claude:target-1",
            turnId: "provider-continuation-operation-1",
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onAppServerEvent).not.toHaveBeenCalled();
    expect(handlers.onTurnStarted).not.toHaveBeenCalled();
    expect(handlers.onAgentMessageDelta).not.toHaveBeenCalled();
    expect(handlers.onReasoningTextDelta).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("falls back to the unique processing Codex thread for reasoning events without threadId", async () => {
    const handlers: Handlers = {
      onAppServerEvent: vi.fn(),
      onReasoningSummaryDelta: vi.fn(),
      onReasoningTextDelta: vi.fn(),
      onReasoningSummaryBoundary: vi.fn(),
      getSingleProcessingCodexThreadId: vi.fn(() => "codex:processing-thread"),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-1",
        message: {
          method: "response.reasoning_summary_text.delta",
          params: {
            item: { id: "reasoning-1" },
            delta: "checking sibling specs",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(handlers.onReasoningSummaryDelta).toHaveBeenCalledWith(
      "ws-1",
      "codex:processing-thread",
      "reasoning-1",
      "checking sibling specs",
    );

    await act(async () => {
      listener?.({
        workspace_id: "ws-1",
        message: {
          method: "response.reasoning_summary_part.added",
          params: {
            part: { item_id: "reasoning-2" },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(handlers.onReasoningSummaryBoundary).toHaveBeenCalledWith(
      "ws-1",
      "codex:processing-thread",
      "reasoning-2",
    );

    await act(async () => {
      listener?.({
        workspace_id: "ws-1",
        message: {
          method: "response.reasoning_text.delta",
          params: {
            item_id: "reasoning-3",
            text: "I am verifying sibling spec directories.",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(handlers.onReasoningTextDelta).toHaveBeenCalledWith(
      "ws-1",
      "codex:processing-thread",
      "reasoning-3",
      "I am verifying sibling spec directories.",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("does not route ownerless reasoning progress to the active Codex thread", async () => {
    const handlers: Handlers = {
      onReasoningTextDelta: vi.fn(),
      getActiveCodexThreadId: vi.fn(() => "codex:active-thread"),
      getSingleProcessingCodexThreadId: vi.fn(() => null),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-1",
        message: {
          method: "response.reasoning_text.delta",
          params: {
            item_id: "reasoning-ambiguous",
            text: "late ownerless progress",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.getSingleProcessingCodexThreadId).toHaveBeenCalledWith(
      "ws-1",
    );
    expect(handlers.getActiveCodexThreadId).not.toHaveBeenCalled();
    expect(handlers.onReasoningTextDelta).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("routes ownerless progress to the unique processing Codex thread instead of a completed active thread", async () => {
    const handlers: Handlers = {
      onReasoningTextDelta: vi.fn(),
      getActiveCodexThreadId: vi.fn(() => "codex:completed-active"),
      getSingleProcessingCodexThreadId: vi.fn(() => "codex:still-processing"),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-1",
        message: {
          method: "response.reasoning_text.delta",
          params: {
            item_id: "reasoning-late",
            text: "ownerless progress belongs to the only live candidate",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.getActiveCodexThreadId).not.toHaveBeenCalled();
    expect(handlers.onReasoningTextDelta).toHaveBeenCalledWith(
      "ws-1",
      "codex:still-processing",
      "reasoning-late",
      "ownerless progress belongs to the only live candidate",
    );
    expect(handlers.onReasoningTextDelta).not.toHaveBeenCalledWith(
      "ws-1",
      "codex:completed-active",
      expect.any(String),
      expect.any(String),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("does not start a turn from ownerless turn/started events", async () => {
    const handlers: Handlers = {
      onTurnStarted: vi.fn(),
      getActiveCodexThreadId: vi.fn(() => "codex:active-thread"),
      getSingleProcessingCodexThreadId: vi.fn(() => "codex:processing-thread"),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-1",
        message: {
          method: "turn/started",
          params: {
            turnId: "ownerless-turn",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.getActiveCodexThreadId).not.toHaveBeenCalled();
    expect(handlers.getSingleProcessingCodexThreadId).not.toHaveBeenCalled();
    expect(handlers.onTurnStarted).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("routes agent delta when threadId is nested in turn and payload uses text field", async () => {
    const handlers: Handlers = {
      onAgentMessageDelta: vi.fn(),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-1",
        message: {
          method: "item/agentMessage/delta",
          params: {
            turn: { threadId: "claude:session-1", id: "turn-1" },
            itemId: "item-1",
            text: "chunk-from-text-field",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onAgentMessageDelta).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      threadId: "claude:session-1",
      itemId: "item-1",
      delta: "chunk-from-text-field",
      turnId: "turn-1",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("routes item and tool-delta events when threadId is nested in turn", async () => {
    const handlers: Handlers = {
      onItemStarted: vi.fn(),
      onCommandOutputDelta: vi.fn(),
      onTerminalInteraction: vi.fn(),
      onFileChangeOutputDelta: vi.fn(),
      onReasoningSummaryDelta: vi.fn(),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-1",
        message: {
          method: "item/started",
          params: {
            turn: { threadId: "claude:session-1" },
            item: { id: "tool-1", type: "commandExecution", status: "started" },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      listener?.({
        workspace_id: "ws-1",
        message: {
          method: "item/commandExecution/outputDelta",
          params: {
            turn: { threadId: "claude:session-1", id: "turn-1", itemId: "tool-1" },
            delta: "partial output",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      listener?.({
        workspace_id: "ws-1",
        message: {
          method: "item/commandExecution/terminalInteraction",
          params: {
            turn: { threadId: "claude:session-1", id: "turn-1", itemId: "tool-1" },
            stdin: "y\n",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      listener?.({
        workspace_id: "ws-1",
        message: {
          method: "item/fileChange/outputDelta",
          params: {
            turn: { threadId: "claude:session-1", id: "turn-1", itemId: "file-1" },
            delta: "File changes",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      listener?.({
        workspace_id: "ws-1",
        message: {
          method: "item/reasoning/summaryTextDelta",
          params: {
            turn: { threadId: "claude:session-1", id: "turn-1", itemId: "reasoning-1" },
            delta: "thinking...",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onItemStarted).toHaveBeenCalledWith("ws-1", "claude:session-1", {
      id: "tool-1",
      type: "commandExecution",
      status: "started",
    });
    expect(handlers.onCommandOutputDelta).toHaveBeenCalledWith(
      "ws-1",
      "claude:session-1",
      "tool-1",
      "partial output",
      "turn-1",
    );
    expect(handlers.onTerminalInteraction).toHaveBeenCalledWith(
      "ws-1",
      "claude:session-1",
      "tool-1",
      "y\n",
      "turn-1",
    );
    expect(handlers.onFileChangeOutputDelta).toHaveBeenCalledWith(
      "ws-1",
      "claude:session-1",
      "file-1",
      "File changes",
      "turn-1",
    );
    expect(handlers.onReasoningSummaryDelta).toHaveBeenCalledWith(
      "ws-1",
      "claude:session-1",
      "reasoning-1",
      "thinking...",
      null,
      "turn-1",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("passes turnId through legacy agent message delta events", async () => {
    const handlers: Handlers = {
      onAgentMessageDelta: vi.fn(),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-codex",
        message: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-codex-legacy-delta",
            turnId: "turn-codex-legacy-delta",
            itemId: "assistant-delta-1",
            delta: "legacy delta",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onAgentMessageDelta).toHaveBeenCalledWith({
      workspaceId: "ws-codex",
      threadId: "thread-codex-legacy-delta",
      itemId: "assistant-delta-1",
      delta: "legacy delta",
      turnId: "turn-codex-legacy-delta",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("passes turnId through normalized fallback realtime events", async () => {
    const handlers: Handlers = {
      onAgentMessageDelta: vi.fn(),
      onFileChangeOutputDelta: vi.fn(),
    };
    const { root } = await mount(handlers, {
      useNormalizedRealtimeAdapters: true,
    });

    await act(async () => {
      listener?.({
        workspace_id: "ws-claude-normalized",
        message: {
          method: "item/agentMessage/delta",
          params: {
            turn: { threadId: "claude:session-normalized", id: "turn-normalized" },
            itemId: "assistant-normalized-1",
            delta: "normalized delta",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      listener?.({
        workspace_id: "ws-claude-normalized",
        message: {
          method: "item/fileChange/outputDelta",
          params: {
            turn: {
              threadId: "claude:session-normalized",
              id: "turn-normalized",
              itemId: "file-normalized-1",
            },
            delta: "File changes",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onAgentMessageDelta).toHaveBeenCalledWith({
      workspaceId: "ws-claude-normalized",
      threadId: "claude:session-normalized",
      itemId: "assistant-normalized-1",
      delta: "normalized delta",
      turnId: "turn-normalized",
    });
    expect(handlers.onFileChangeOutputDelta).toHaveBeenCalledWith(
      "ws-claude-normalized",
      "claude:session-normalized",
      "file-normalized-1",
      "File changes",
      "turn-normalized",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("hydrates turnId into legacy raw item events", async () => {
    const handlers: Handlers = {
      onItemUpdated: vi.fn(),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-codex",
        message: {
          method: "item/updated",
          params: {
            threadId: "thread-codex-legacy-item",
            turnId: "turn-codex-legacy-item",
            item: {
              id: "cmd-legacy-item",
              type: "commandExecution",
              status: "running",
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onItemUpdated).toHaveBeenCalledWith(
      "ws-codex",
      "thread-codex-legacy-item",
      expect.objectContaining({
        id: "cmd-legacy-item",
        type: "commandExecution",
        turnId: "turn-codex-legacy-item",
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("preserves shared-session engine source on legacy raw item events", async () => {
    const handlers: Handlers = {
      onItemUpdated: vi.fn(),
    };
    registerSharedSessionNativeBinding({
      workspaceId: "ws-shared-claude-legacy-item",
      sharedThreadId: "shared:thread-claude-legacy-item",
      nativeThreadId: "claude:legacy-native-item",
      engine: "claude",
    });
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-shared-claude-legacy-item",
        message: {
          method: "item/updated",
          params: {
            threadId: "claude:legacy-native-item",
            turnId: "turn-shared-claude-legacy-item",
            item: {
              id: "tool-shared-claude",
              type: "commandExecution",
              status: "running",
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onItemUpdated).toHaveBeenCalledWith(
      "ws-shared-claude-legacy-item",
      "shared:thread-claude-legacy-item",
      expect.objectContaining({
        id: "tool-shared-claude",
        type: "commandExecution",
        turnId: "turn-shared-claude-legacy-item",
        engineSource: "claude",
      }),
    );

    clearSharedSessionBindingsForSharedThread(
      "ws-shared-claude-legacy-item",
      "shared:thread-claude-legacy-item",
    );
    await act(async () => {
      root.unmount();
    });
  });

  it("routes item/agentMessage/textDelta alias in legacy event path", async () => {
    const handlers: Handlers = {
      onAgentMessageDelta: vi.fn(),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-1",
        message: {
          method: "item/agentMessage/textDelta",
          params: {
            threadId: "claude:session-2",
            itemId: "item-2",
            delta: "alias-delta",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onAgentMessageDelta).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      threadId: "claude:session-2",
      itemId: "item-2",
      delta: "alias-delta",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("ignores delta events missing required fields", async () => {
    const handlers: Handlers = {
      onAgentMessageDelta: vi.fn(),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-1",
        message: {
          method: "item/agentMessage/delta",
          params: { threadId: "", itemId: "item-1", delta: "Hello" },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      listener?.({
        workspace_id: "ws-1",
        message: {
          method: "item/agentMessage/delta",
          params: { threadId: "thread-1", itemId: "", delta: "Hello" },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      listener?.({
        workspace_id: "ws-1",
        message: {
          method: "item/agentMessage/delta",
          params: { threadId: "thread-1", itemId: "item-1", delta: "" },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onAgentMessageDelta).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("passes engine hint when thread session id is updated", async () => {
    const handlers: Handlers = {
      onThreadSessionIdUpdated: vi.fn(),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-opencode",
        message: {
          method: "thread/started",
          params: {
            threadId: "opencode-pending-1",
            sessionId: "ses_1",
            turnId: "turn-1",
            engine: "opencode",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onThreadSessionIdUpdated).toHaveBeenCalledWith(
      "ws-opencode",
      "opencode-pending-1",
      "ses_1",
      "opencode",
      "turn-1",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps codex shared-session native binding unchanged on thread/started", async () => {
    const handlers: Handlers = {
      onTurnCompleted: vi.fn(),
    };
    registerSharedSessionNativeBinding({
      workspaceId: "ws-shared-codex",
      sharedThreadId: "shared:thread-codex",
      nativeThreadId: "codex-native-thread-1",
      engine: "codex",
    });
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-shared-codex",
        message: {
          method: "thread/started",
          params: {
            threadId: "codex-native-thread-1",
            sessionId: "codex-native-thread-1",
            engine: "codex",
          },
        },
      });
      listener?.({
        workspace_id: "ws-shared-codex",
        message: {
          method: "turn/completed",
          params: {
            threadId: "codex-native-thread-1",
            turnId: "turn-codex-1",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(updateSharedSessionNativeBindingService).not.toHaveBeenCalled();
    expect(handlers.onTurnCompleted).toHaveBeenCalledWith(
      "ws-shared-codex",
      "shared:thread-codex",
      "turn-codex-1",
    );

    clearSharedSessionBindingsForSharedThread("ws-shared-codex", "shared:thread-codex");
    await act(async () => {
      root.unmount();
    });
  });

  it("passes shared-session engine hint on stalled turns", async () => {
    const handlers: Handlers = {
      onTurnStalled: vi.fn(),
    };
    registerSharedSessionNativeBinding({
      workspaceId: "ws-shared-claude-stalled",
      sharedThreadId: "shared:thread-claude-stalled",
      nativeThreadId: "claude:stalled-native-1",
      engine: "claude",
    });
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-shared-claude-stalled",
        message: {
          method: "turn/stalled",
          params: {
            threadId: "claude:stalled-native-1",
            turnId: "turn-shared-claude-stalled",
            message: "resume stalled",
            reasonCode: "resume_pending_timeout",
            stage: "stalled",
            source: "turn/stalled",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onTurnStalled).toHaveBeenCalledWith(
      "ws-shared-claude-stalled",
      "shared:thread-claude-stalled",
      "turn-shared-claude-stalled",
      expect.objectContaining({
        message: "resume stalled",
        reasonCode: "resume_pending_timeout",
        engine: "claude",
      }),
    );

    clearSharedSessionBindingsForSharedThread(
      "ws-shared-claude-stalled",
      "shared:thread-claude-stalled",
    );
    await act(async () => {
      root.unmount();
    });
  });

  it("rebinds the V2 frontend bridge without writing legacy binding meta", async () => {
    const handlers: Handlers = {
      onThreadStarted: vi.fn(),
      onTurnCompleted: vi.fn(),
    };
    registerSharedSessionNativeBinding({
      workspaceId: "ws-shared-codex-pending",
      sharedThreadId: "shared:thread-codex-pending",
      nativeThreadId: "codex-pending-shared-1",
      engine: "codex",
    });
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-shared-codex-pending",
        message: {
          method: "thread/started",
          params: {
            threadId: "550e8400-e29b-41d4-a716-446655440000",
            sessionId: "550e8400-e29b-41d4-a716-446655440000",
            engine: "codex",
          },
        },
      });
      listener?.({
        workspace_id: "ws-shared-codex-pending",
        message: {
          method: "turn/completed",
          params: {
            threadId: "550e8400-e29b-41d4-a716-446655440000",
            turnId: "turn-codex-pending-1",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onThreadStarted).not.toHaveBeenCalled();
    expect(updateSharedSessionNativeBindingService).not.toHaveBeenCalled();
    expect(
      resolveSharedSessionBindingByNativeThread(
        "ws-shared-codex-pending",
        "550e8400-e29b-41d4-a716-446655440000",
      ),
    ).toMatchObject({
      sharedThreadId: "shared:thread-codex-pending",
      engine: "codex",
    });
    expect(handlers.onTurnCompleted).toHaveBeenCalledWith(
      "ws-shared-codex-pending",
      "shared:thread-codex-pending",
      "turn-codex-pending-1",
    );

    clearSharedSessionBindingsForSharedThread(
      "ws-shared-codex-pending",
      "shared:thread-codex-pending",
    );
    await act(async () => {
      root.unmount();
    });
  });

  it("keeps V0 legacy binding persistence behind the explicit rollback flag", async () => {
    setSharedV2SendOverride(false);
    const handlers: Handlers = {
      onTurnCompleted: vi.fn(),
    };
    registerSharedSessionNativeBinding({
      workspaceId: "ws-shared-claude",
      sharedThreadId: "shared:thread-claude",
      nativeThreadId: "claude-pending-shared-1",
      engine: "claude",
    });
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-shared-claude",
        message: {
          method: "thread/started",
          params: {
            threadId: "claude-pending-shared-1",
            sessionId: "ses_123",
            engine: "claude",
          },
        },
      });
      listener?.({
        workspace_id: "ws-shared-claude",
        message: {
          method: "turn/completed",
          params: {
            threadId: "claude:ses_123",
            turnId: "turn-claude-1",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(updateSharedSessionNativeBindingService).toHaveBeenCalledWith(
      "ws-shared-claude",
      "shared:thread-claude",
      "claude",
      "claude-pending-shared-1",
      "claude:ses_123",
      null,
    );
    expect(handlers.onTurnCompleted).toHaveBeenCalledWith(
      "ws-shared-claude",
      "shared:thread-claude",
      "turn-claude-1",
    );

    clearSharedSessionBindingsForSharedThread("ws-shared-claude", "shared:thread-claude");
    await act(async () => {
      root.unmount();
    });
  });

  it("does not open a native Grok row when two Shared Grok bindings are pending", async () => {
    const handlers: Handlers = {
      onThreadStarted: vi.fn(),
      onThreadSessionIdUpdated: vi.fn(),
    };
    registerSharedSessionNativeBinding({
      workspaceId: "ws-dual-grok",
      sharedThreadId: "shared:thread-grok-a",
      nativeThreadId: "grok-pending-shared-a",
      engine: "grok",
    });
    registerSharedSessionNativeBinding({
      workspaceId: "ws-dual-grok",
      sharedThreadId: "shared:thread-grok-b",
      nativeThreadId: "grok-pending-shared-b",
      engine: "grok",
    });
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-dual-grok",
        message: {
          method: "thread/started",
          params: {
            threadId: "grok:live-raw",
            sessionId: "live-raw",
            engine: "grok",
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onThreadStarted).not.toHaveBeenCalled();
    expect(handlers.onThreadSessionIdUpdated).not.toHaveBeenCalled();

    clearSharedSessionBindingsForSharedThread("ws-dual-grok", "shared:thread-grok-a");
    clearSharedSessionBindingsForSharedThread("ws-dual-grok", "shared:thread-grok-b");
    await act(async () => {
      root.unmount();
    });
  });

  it("finalizes Qoder Global and CN pending bindings without native sidebar rows", async () => {
    const handlers: Handlers = {
      onThreadStarted: vi.fn(),
      onThreadSessionIdUpdated: vi.fn(),
    };
    registerSharedSessionNativeBinding({
      workspaceId: "ws-dual-qoder",
      sharedThreadId: "shared:thread-qoder-global",
      nativeThreadId: "qoder-pending-shared-global",
      engine: "qoder",
      providerProfileId: QODER_GLOBAL_PROVIDER_PROFILE_ID,
    });
    registerSharedSessionNativeBinding({
      workspaceId: "ws-dual-qoder",
      sharedThreadId: "shared:thread-qoder-cn",
      nativeThreadId: "qoder-pending-shared-cn",
      engine: "qoder",
      providerProfileId: QODER_CN_PROVIDER_PROFILE_ID,
    });
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-dual-qoder",
        message: {
          method: "thread/started",
          params: {
            threadId: "qoder-pending-shared-global",
            sessionId: "same-raw",
            engine: "qoder",
            providerProfileId: QODER_GLOBAL_PROVIDER_PROFILE_ID,
          },
        },
      });
      listener?.({
        workspace_id: "ws-dual-qoder",
        message: {
          method: "thread/started",
          params: {
            threadId: "qoder-pending-shared-cn",
            sessionId: "same-raw",
            engine: "qoder",
            providerProfileId: QODER_CN_PROVIDER_PROFILE_ID,
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onThreadStarted).not.toHaveBeenCalled();
    expect(
      resolveSharedSessionBindingByNativeThread(
        "ws-dual-qoder",
        `qoder:${QODER_GLOBAL_PROVIDER_PROFILE_ID}:same-raw`,
      ),
    ).toMatchObject({
      sharedThreadId: "shared:thread-qoder-global",
      providerProfileId: QODER_GLOBAL_PROVIDER_PROFILE_ID,
    });
    expect(
      resolveSharedSessionBindingByNativeThread(
        "ws-dual-qoder",
        `qoder:${QODER_CN_PROVIDER_PROFILE_ID}:same-raw`,
      ),
    ).toMatchObject({
      sharedThreadId: "shared:thread-qoder-cn",
      providerProfileId: QODER_CN_PROVIDER_PROFILE_ID,
    });

    clearSharedSessionBindingsForSharedThread(
      "ws-dual-qoder",
      "shared:thread-qoder-global",
    );
    clearSharedSessionBindingsForSharedThread(
      "ws-dual-qoder",
      "shared:thread-qoder-cn",
    );
    await act(async () => {
      root.unmount();
    });
  });

  it("emits fallback assistant completion from turn/completed result text when no delta arrived", async () => {
    const handlers: Handlers = {
      onAgentMessageCompleted: vi.fn(),
      onTurnCompleted: vi.fn(),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-1",
        message: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            result: { text: "final response from result" },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onAgentMessageCompleted).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      threadId: "thread-1",
      itemId: "turn-1",
      text: "final response from result",
      turnId: "turn-1",
    });
    expect(handlers.onTurnCompleted).toHaveBeenCalledWith("ws-1", "thread-1", "turn-1");

    await act(async () => {
      root.unmount();
    });
  });

  it("passes turnId through legacy agent message completion snapshots", async () => {
    const handlers: Handlers = {
      onAgentMessageCompleted: vi.fn(),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-1",
        message: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "agentMessage",
              id: "assistant-1",
              text: "final response from snapshot",
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onAgentMessageCompleted).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      threadId: "thread-1",
      itemId: "assistant-1",
      text: "final response from snapshot",
      turnId: "turn-1",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("does not emit fallback assistant completion when delta already arrived", async () => {
    const handlers: Handlers = {
      onAgentMessageDelta: vi.fn(),
      onAgentMessageCompleted: vi.fn(),
      onTurnCompleted: vi.fn(),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-1",
        message: {
          method: "item/agentMessage/delta",
          params: { threadId: "thread-1", itemId: "item-1", delta: "streaming..." },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      listener?.({
        workspace_id: "ws-1",
        message: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            result: { text: "final response from result" },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onAgentMessageCompleted).not.toHaveBeenCalled();
    expect(handlers.onTurnCompleted).toHaveBeenCalledWith("ws-1", "thread-1", "turn-1");

    await act(async () => {
      root.unmount();
    });
  });

  it("does not synthesize a Kimi completion after a pending delta is promoted to its canonical session", async () => {
    const handlers: Handlers = {
      onAgentMessageDelta: vi.fn(),
      onAgentMessageCompleted: vi.fn(),
      onThreadSessionIdUpdated: vi.fn(),
      onTurnCompleted: vi.fn(),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-kimi",
        message: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "kimi-pending-1",
            itemId: "kimi-item-1",
            delta: "你好！有什么可以帮你的吗？",
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      listener?.({
        workspace_id: "ws-kimi",
        message: {
          method: "thread/started",
          params: {
            threadId: "kimi-pending-1",
            sessionId: "session-real-1",
            turnId: "kimi-turn-1",
            engine: "kimi",
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      listener?.({
        workspace_id: "ws-kimi",
        message: {
          method: "turn/completed",
          params: {
            threadId: "kimi:session-real-1",
            turnId: "kimi-turn-1",
            result: { text: "你好！有什么可以帮你的吗？" },
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onThreadSessionIdUpdated).toHaveBeenCalledWith(
      "ws-kimi",
      "kimi-pending-1",
      "session-real-1",
      "kimi",
      "kimi-turn-1",
    );
    expect(handlers.onAgentMessageDelta).toHaveBeenCalledTimes(1);
    expect(handlers.onAgentMessageDelta).toHaveBeenCalledWith({
      workspaceId: "ws-kimi",
      threadId: "kimi-pending-1",
      itemId: "kimi-item-1",
      delta: "你好！有什么可以帮你的吗？",
    });
    expect(handlers.onAgentMessageCompleted).not.toHaveBeenCalled();
    expect(handlers.onTurnCompleted).toHaveBeenCalledWith(
      "ws-kimi",
      "kimi:session-real-1",
      "kimi-turn-1",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("does not synthesize a Grok completion after a pending delta is promoted to its canonical session", async () => {
    const handlers: Handlers = {
      onAgentMessageDelta: vi.fn(),
      onAgentMessageCompleted: vi.fn(),
      onThreadSessionIdUpdated: vi.fn(),
      onTurnCompleted: vi.fn(),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-grok",
        message: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "grok-pending-1",
            itemId: "grok-item-1",
            delta: "你好！有什么可以帮你的吗？",
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      listener?.({
        workspace_id: "ws-grok",
        message: {
          method: "thread/started",
          params: {
            threadId: "grok-pending-1",
            sessionId: "session-real-1",
            turnId: "grok-turn-1",
            engine: "grok",
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      listener?.({
        workspace_id: "ws-grok",
        message: {
          method: "turn/completed",
          params: {
            threadId: "grok:session-real-1",
            turnId: "grok-turn-1",
            result: { text: "你好！有什么可以帮你的吗？" },
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onThreadSessionIdUpdated).toHaveBeenCalledWith(
      "ws-grok",
      "grok-pending-1",
      "session-real-1",
      "grok",
      "grok-turn-1",
    );
    expect(handlers.onAgentMessageDelta).toHaveBeenCalledTimes(1);
    expect(handlers.onAgentMessageDelta).toHaveBeenCalledWith({
      workspaceId: "ws-grok",
      threadId: "grok-pending-1",
      itemId: "grok-item-1",
      delta: "你好！有什么可以帮你的吗？",
    });
    expect(handlers.onAgentMessageCompleted).not.toHaveBeenCalled();
    expect(handlers.onTurnCompleted).toHaveBeenCalledWith(
      "ws-grok",
      "grok:session-real-1",
      "grok-turn-1",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("does not emit duplicated completion when item/completed already delivered agent text", async () => {
    const handlers: Handlers = {
      onAgentMessageCompleted: vi.fn(),
      onTurnCompleted: vi.fn(),
      onItemCompleted: vi.fn(),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-1",
        message: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            item: { type: "agentMessage", id: "item-1", text: "final response" },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      listener?.({
        workspace_id: "ws-1",
        message: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            result: { text: "final response" },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onAgentMessageCompleted).toHaveBeenCalledTimes(1);
    expect(handlers.onTurnCompleted).toHaveBeenCalledWith("ws-1", "thread-1", "turn-1");

    await act(async () => {
      root.unmount();
    });
  });

  it("does not emit fallback completion when agentMessage snapshot already arrived via item/updated", async () => {
    const handlers: Handlers = {
      onAgentMessageCompleted: vi.fn(),
      onTurnCompleted: vi.fn(),
      onItemUpdated: vi.fn(),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-1",
        message: {
          method: "item/updated",
          params: {
            threadId: "codex:thread-1",
            item: { type: "agentMessage", id: "item-1", text: "final response" },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      listener?.({
        workspace_id: "ws-1",
        message: {
          method: "turn/completed",
          params: {
            threadId: "codex:thread-1",
            turnId: "turn-1",
            result: { text: "final response" },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onItemUpdated).toHaveBeenCalledTimes(1);
    expect(handlers.onAgentMessageCompleted).not.toHaveBeenCalled();
    expect(handlers.onTurnCompleted).toHaveBeenCalledWith(
      "ws-1",
      "codex:thread-1",
      "turn-1",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps turn/completed fallback when agentMessage snapshot text is empty", async () => {
    const handlers: Handlers = {
      onAgentMessageCompleted: vi.fn(),
      onTurnCompleted: vi.fn(),
      onItemUpdated: vi.fn(),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-1",
        message: {
          method: "item/updated",
          params: {
            threadId: "codex:thread-1",
            item: { type: "agentMessage", id: "item-empty", text: "" },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      listener?.({
        workspace_id: "ws-1",
        message: {
          method: "turn/completed",
          params: {
            threadId: "codex:thread-1",
            turnId: "turn-2",
            result: { text: "final response from result" },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onItemUpdated).toHaveBeenCalledTimes(1);
    expect(handlers.onAgentMessageCompleted).toHaveBeenCalledTimes(1);
    expect(handlers.onAgentMessageCompleted).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      threadId: "codex:thread-1",
      itemId: "turn-2",
      text: "final response from result",
      turnId: "turn-2",
    });
    expect(handlers.onTurnCompleted).toHaveBeenCalledWith(
      "ws-1",
      "codex:thread-1",
      "turn-2",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("still fuses project memory when shared terminal projection succeeds after delta", async () => {
    const handlers: Handlers = {
      onAgentMessageDelta: vi.fn(),
      onAgentMessageCompleted: vi.fn(),
      onNormalizedRealtimeEvent: vi.fn(),
      onTurnCompleted: vi.fn(),
    };
    const executionTargetSnapshot = {
      engine: "claude" as const,
      providerProfileId: "provider-shared-memory",
      modelCatalogEntryId: "catalog-shared-memory",
      model: "claude-model",
      reasoning: null,
      providerProfileNameSnapshot: "Provider Shared Memory",
      providerProfileSource: "managed" as const,
      runtimeCapabilityFingerprint: null,
    };
    const { root } = await mount(handlers, {
      useNormalizedRealtimeAdapters: true,
    });

    await act(async () => {
      listener?.({
        workspace_id: "ws-shared-memory-fusion",
        message: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "shared:thread-memory",
            nativeThreadId: "native-memory",
            turnId: "runtime-memory-turn",
            itemId: "assistant-memory",
            delta: "shared assistant reply",
            sharedOwner: {
              sharedSessionId: "thread-memory",
              sharedThreadId: "shared:thread-memory",
              nativeThreadId: "native-memory",
              runtimeTurnId: "runtime-memory-turn",
              attemptId: "attempt-memory",
              bindingKey: "claude:provider-shared-memory",
              engine: "claude",
              executionTargetSnapshot,
            },
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      listener?.({
        workspace_id: "ws-shared-memory-fusion",
        message: {
          method: "turn/completed",
          params: {
            threadId: "shared:thread-memory",
            turnId: "runtime-memory-turn",
            result: { text: "shared assistant reply" },
            sharedOwner: {
              sharedSessionId: "thread-memory",
              sharedThreadId: "shared:thread-memory",
              nativeThreadId: "native-memory",
              runtimeTurnId: "runtime-memory-turn",
              attemptId: "attempt-memory",
              bindingKey: "claude:provider-shared-memory",
              engine: "claude",
              executionTargetSnapshot,
            },
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onNormalizedRealtimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "shared:thread-memory",
        operation: "completeAgentMessage",
      }),
    );
    expect(handlers.onAgentMessageCompleted).toHaveBeenCalledWith({
      workspaceId: "ws-shared-memory-fusion",
      threadId: "shared:thread-memory",
      itemId: expect.any(String),
      text: "shared assistant reply",
      turnId: "runtime-memory-turn",
    });
    expect(handlers.onTurnCompleted).toHaveBeenCalledWith(
      "ws-shared-memory-fusion",
      "shared:thread-memory",
      "runtime-memory-turn",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("settles shared terminal final onto the existing Codex assistant item", async () => {
    const handlers: Handlers = {
      onAgentMessageCompleted: vi.fn(),
      onTurnCompleted: vi.fn(),
      onItemUpdated: vi.fn(),
    };
    registerSharedSessionNativeBinding({
      workspaceId: "ws-shared-codex-turn",
      sharedThreadId: "shared:thread-codex-turn",
      nativeThreadId: "codex-native-thread-turn",
      engine: "codex",
    });
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-shared-codex-turn",
        message: {
          method: "item/updated",
          params: {
            threadId: "codex-native-thread-turn",
            item: { type: "agentMessage", id: "item-1", text: "shared final response" },
          },
        },
      });
      listener?.({
        workspace_id: "ws-shared-codex-turn",
        message: {
          method: "turn/completed",
          params: {
            threadId: "codex-native-thread-turn",
            turnId: "turn-shared-1",
            result: { text: "shared final response" },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onItemUpdated).toHaveBeenCalledWith(
      "ws-shared-codex-turn",
      "shared:thread-codex-turn",
      expect.objectContaining({
        type: "agentMessage",
        id: "item-1",
        text: "shared final response",
      }),
    );
    expect(handlers.onAgentMessageCompleted).toHaveBeenCalledTimes(1);
    expect(handlers.onAgentMessageCompleted).toHaveBeenCalledWith({
      workspaceId: "ws-shared-codex-turn",
      threadId: "shared:thread-codex-turn",
      itemId: "item-1",
      text: "shared final response",
      turnId: "turn-shared-1",
    });
    expect(handlers.onTurnCompleted).toHaveBeenCalledWith(
      "ws-shared-codex-turn",
      "shared:thread-codex-turn",
      "turn-shared-1",
    );

    clearSharedSessionBindingsForSharedThread(
      "ws-shared-codex-turn",
      "shared:thread-codex-turn",
    );
    await act(async () => {
      root.unmount();
    });
  });

  it("routes first delta, reasoning, and terminal from Rust sharedOwner without a frontend binding", async () => {
    const handlers: Handlers = {
      onAgentMessageDelta: vi.fn(),
      onReasoningTextDelta: vi.fn(),
      onTurnCompleted: vi.fn(),
    };
    const { root } = await mount(handlers, {
      useNormalizedRealtimeAdapters: true,
    });
    const sharedOwner = {
      sharedSessionId: "owner-session",
      sharedThreadId: "shared:owner-session",
      nativeThreadId: "claude:native-owner",
      runtimeTurnId: "run-owner",
      attemptId: "attempt-owner",
      engine: "claude",
    };

    await act(async () => {
      listener?.({
        workspace_id: "ws-runtime-owner",
        message: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "shared:owner-session",
            nativeThreadId: "claude:native-owner",
            turnId: "run-owner",
            itemId: "assistant-owner",
            delta: "first",
            sharedOwner,
          },
        },
      });
      listener?.({
        workspace_id: "ws-runtime-owner",
        message: {
          method: "item/reasoning/textDelta",
          params: {
            threadId: "shared:owner-session",
            nativeThreadId: "claude:native-owner",
            turnId: "run-owner",
            itemId: "reasoning-owner",
            delta: "thinking",
            sharedOwner,
          },
        },
      });
      listener?.({
        workspace_id: "ws-runtime-owner",
        message: {
          method: "turn/completed",
          params: {
            threadId: "shared:owner-session",
            nativeThreadId: "claude:native-owner",
            turnId: "run-owner",
            result: { text: "first" },
            sharedOwner,
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onAgentMessageDelta).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-runtime-owner",
        threadId: "shared:owner-session",
        delta: "first",
      }),
    );
    expect(handlers.onReasoningTextDelta).toHaveBeenCalledWith(
      "ws-runtime-owner",
      "shared:owner-session",
      "reasoning-owner",
      "thinking",
      null,
      "run-owner",
    );
    expect(handlers.onTurnCompleted).toHaveBeenCalledWith(
      "ws-runtime-owner",
      "shared:owner-session",
      "run-owner",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("projects a hidden native delta through sharedOwner after conversation navigation", async () => {
    const handlers: Handlers = {
      onAgentMessageDelta: vi.fn(),
    };
    const { root } = await mount(handlers, {
      useNormalizedRealtimeAdapters: true,
    });

    await act(async () => {
      listener?.({
        workspace_id: "ws-native-owner-navigation",
        message: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "claude:hidden-native-navigation",
            nativeThreadId: "claude:hidden-native-navigation",
            turnId: "run-native-navigation",
            itemId: "assistant-native-navigation",
            delta: "still routed to Shared",
            sharedOwner: {
              sharedSessionId: "native-owner-navigation",
              sharedThreadId: "shared:native-owner-navigation",
              nativeThreadId: "claude:hidden-native-navigation",
              runtimeTurnId: "run-native-navigation",
              attemptId: "attempt-native-navigation",
              engine: "claude",
            },
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onAgentMessageDelta).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-native-owner-navigation",
        threadId: "shared:native-owner-navigation",
        itemId: "assistant-native-navigation",
        delta: "still routed to Shared",
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("does not restart generic Native lifecycle for a Shared V2 projected turn", async () => {
    const handlers: Handlers = {
      onTurnStarted: vi.fn(),
      onSharedRuntimeTurnStarted: vi.fn(),
      onAgentMessageDelta: vi.fn(),
    };
    const { root } = await mount(handlers);
    const sharedOwner = {
      sharedSessionId: "owner-session-start",
      sharedThreadId: "shared:owner-session-start",
      nativeThreadId: "claude:native-owner-start",
      runtimeTurnId: "run-owner-start",
      attemptId: "attempt-owner-start",
      engine: "claude",
      executionTargetSnapshot: {
        engine: "claude",
        providerProfileId: "provider-owner-start",
        modelCatalogEntryId: "catalog-owner-start",
        model: "claude-owner-start",
        reasoning: null,
        providerProfileNameSnapshot: "Provider Owner Start",
        providerProfileSource: "managed",
        runtimeCapabilityFingerprint: null,
      },
    };

    await act(async () => {
      listener?.({
        workspace_id: "ws-runtime-owner-start",
        message: {
          method: "turn/started",
          params: {
            threadId: "shared:owner-session-start",
            nativeThreadId: "claude:native-owner-start",
            turnId: "run-owner-start",
            sharedOwner,
          },
        },
      });
      listener?.({
        workspace_id: "ws-runtime-owner-start",
        message: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "shared:owner-session-start",
            nativeThreadId: "claude:native-owner-start",
            turnId: "run-owner-start",
            itemId: "assistant-owner-start",
            delta: "content remains projected",
            sharedOwner,
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onTurnStarted).not.toHaveBeenCalled();
    expect(handlers.onSharedRuntimeTurnStarted).toHaveBeenCalledWith(
      "shared:owner-session-start",
      "run-owner-start",
    );
    expect(handlers.onAgentMessageDelta).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-runtime-owner-start",
        threadId: "shared:owner-session-start",
        delta: "content remains projected",
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("forces a durable Shared owner through normalized routing when the global flag is off", async () => {
    const handlers: Handlers = {
      onNormalizedRealtimeEvent: vi.fn(),
      onAgentMessageDelta: vi.fn(),
    };
    const { root } = await mount(handlers);
    const executionTargetSnapshot = {
      engine: "codex",
      providerProfileId: "provider-live",
      modelCatalogEntryId: "catalog-live",
      model: "runtime-live",
      reasoning: { effort: "high" },
      providerProfileNameSnapshot: "Provider Live",
      providerProfileSource: "managed",
      runtimeCapabilityFingerprint: null,
    };

    await act(async () => {
      listener?.({
        workspace_id: "ws-shared-live",
        message: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "shared:thread-live",
            nativeThreadId: "native-live",
            turnId: "runtime-live",
            itemId: "assistant-live",
            delta: "live",
            sharedOwner: {
              sharedSessionId: "thread-live",
              sharedThreadId: "shared:thread-live",
              nativeThreadId: "native-live",
              runtimeTurnId: "runtime-live",
              attemptId: "attempt-live",
              bindingKey: "codex:provider-live",
              engine: "codex",
              executionTargetSnapshot,
            },
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onNormalizedRealtimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "shared:thread-live",
        operation: "appendAgentMessageDelta",
        item: expect.objectContaining({
          text: "live",
          executionTargetSnapshot,
        }),
      }),
    );
    expect(handlers.onAgentMessageDelta).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("settles a complete Claude final over a streamed prefix in Shared Session", async () => {
    const handlers: Handlers = {
      onAgentMessageCompleted: vi.fn(),
      onItemUpdated: vi.fn(),
      onTurnCompleted: vi.fn(),
    };
    registerSharedSessionNativeBinding({
      workspaceId: "ws-shared-claude-prefix",
      sharedThreadId: "shared:thread-claude-prefix",
      nativeThreadId: "claude-native-thread-prefix",
      engine: "claude",
    });
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-shared-claude-prefix",
        message: {
          method: "item/updated",
          params: {
            threadId: "claude-native-thread-prefix",
            item: { type: "agentMessage", id: "claude-item-1", text: "Cl" },
          },
        },
      });
      listener?.({
        workspace_id: "ws-shared-claude-prefix",
        message: {
          method: "turn/completed",
          params: {
            threadId: "claude-native-thread-prefix",
            turnId: "turn-shared-claude-1",
            result: {
              text: "Claude，Anthropic 出品。当前会话使用完整 terminal final。",
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onItemUpdated).toHaveBeenCalledWith(
      "ws-shared-claude-prefix",
      "shared:thread-claude-prefix",
      expect.objectContaining({
        id: "claude-item-1",
        text: "Cl",
      }),
    );
    expect(handlers.onAgentMessageCompleted).toHaveBeenCalledTimes(1);
    expect(handlers.onAgentMessageCompleted).toHaveBeenCalledWith({
      workspaceId: "ws-shared-claude-prefix",
      threadId: "shared:thread-claude-prefix",
      itemId: "claude-item-1",
      text: "Claude，Anthropic 出品。当前会话使用完整 terminal final。",
      turnId: "turn-shared-claude-1",
    });
    expect(handlers.onTurnCompleted).toHaveBeenCalledWith(
      "ws-shared-claude-prefix",
      "shared:thread-claude-prefix",
      "turn-shared-claude-1",
    );

    clearSharedSessionBindingsForSharedThread(
      "ws-shared-claude-prefix",
      "shared:thread-claude-prefix",
    );
    await act(async () => {
      root.unmount();
    });
  });

  it("keeps shared-session turn/completed fallback when snapshot text is empty", async () => {
    const handlers: Handlers = {
      onAgentMessageCompleted: vi.fn(),
      onTurnCompleted: vi.fn(),
      onItemUpdated: vi.fn(),
    };
    registerSharedSessionNativeBinding({
      workspaceId: "ws-shared-codex-empty",
      sharedThreadId: "shared:thread-codex-empty",
      nativeThreadId: "codex-native-thread-empty",
      engine: "codex",
    });
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-shared-codex-empty",
        message: {
          method: "item/updated",
          params: {
            threadId: "codex-native-thread-empty",
            item: { type: "agentMessage", id: "item-empty", text: "" },
          },
        },
      });
      listener?.({
        workspace_id: "ws-shared-codex-empty",
        message: {
          method: "turn/completed",
          params: {
            threadId: "codex-native-thread-empty",
            turnId: "turn-shared-empty-1",
            result: { text: "shared fallback response" },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onItemUpdated).toHaveBeenCalledWith(
      "ws-shared-codex-empty",
      "shared:thread-codex-empty",
      expect.objectContaining({
        type: "agentMessage",
        id: "item-empty",
      }),
    );
    expect(handlers.onAgentMessageCompleted).toHaveBeenCalledTimes(1);
    expect(handlers.onAgentMessageCompleted).toHaveBeenCalledWith({
      workspaceId: "ws-shared-codex-empty",
      threadId: "shared:thread-codex-empty",
      itemId: "turn-shared-empty-1",
      text: "shared fallback response",
      turnId: "turn-shared-empty-1",
    });
    expect(handlers.onTurnCompleted).toHaveBeenCalledWith(
      "ws-shared-codex-empty",
      "shared:thread-codex-empty",
      "turn-shared-empty-1",
    );

    clearSharedSessionBindingsForSharedThread(
      "ws-shared-codex-empty",
      "shared:thread-codex-empty",
    );
    await act(async () => {
      root.unmount();
    });
  });

  it("keeps multiple agent completions in the same thread when item ids differ", async () => {
    const handlers: Handlers = {
      onAgentMessageCompleted: vi.fn(),
      onItemCompleted: vi.fn(),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-1",
        message: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            item: { type: "agentMessage", id: "item-1", text: "first short paragraph" },
          },
        },
      });
      listener?.({
        workspace_id: "ws-1",
        message: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            item: { type: "agentMessage", id: "item-2", text: "second short paragraph" },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onAgentMessageCompleted).toHaveBeenCalledTimes(2);
    expect(handlers.onAgentMessageCompleted).toHaveBeenNthCalledWith(1, {
      workspaceId: "ws-1",
      threadId: "thread-1",
      itemId: "item-1",
      text: "first short paragraph",
    });
    expect(handlers.onAgentMessageCompleted).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-1",
      threadId: "thread-1",
      itemId: "item-2",
      text: "second short paragraph",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("dedupes repeated item/completed snapshots for the same agent item id", async () => {
    const handlers: Handlers = {
      onAgentMessageCompleted: vi.fn(),
      onItemCompleted: vi.fn(),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-1",
        message: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            item: { type: "agentMessage", id: "item-dup-1", text: "same completion text" },
          },
        },
      });
      listener?.({
        workspace_id: "ws-1",
        message: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            item: { type: "agentMessage", id: "item-dup-1", text: "same completion text" },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onAgentMessageCompleted).toHaveBeenCalledTimes(1);
    expect(handlers.onAgentMessageCompleted).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      threadId: "thread-1",
      itemId: "item-dup-1",
      text: "same completion text",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("routes processing heartbeat events", async () => {
    const handlers: Handlers = {
      onProcessingHeartbeat: vi.fn(),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-1",
        message: {
          method: "processing/heartbeat",
          params: { threadId: "thread-1", pulse: 3 },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onProcessingHeartbeat).toHaveBeenCalledWith(
      "ws-1",
      "thread-1",
      3,
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("routes opencode text:delta through normalized realtime adapters when enabled", async () => {
    const handlers: Handlers = {
      onAgentMessageDelta: vi.fn(),
    };
    const { root } = await mount(handlers, {
      useNormalizedRealtimeAdapters: true,
    });

    await act(async () => {
      listener?.({
        workspace_id: "ws-opencode",
        message: {
          method: "text:delta",
          params: {
            threadId: "opencode:ses_99",
            itemId: "assistant-1",
            delta: "streaming text",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onAgentMessageDelta).toHaveBeenCalledWith({
      workspaceId: "ws-opencode",
      threadId: "opencode:ses_99",
      itemId: "assistant-1",
      delta: "streaming text",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("routes claude item/updated agentMessage snapshot in normalized realtime routing", async () => {
    const handlers: Handlers = {
      onAgentMessageDelta: vi.fn(),
      onItemUpdated: vi.fn(),
    };
    const { root } = await mount(handlers, {
      useNormalizedRealtimeAdapters: true,
    });

    await act(async () => {
      listener?.({
        workspace_id: "ws-claude",
        message: {
          method: "item/updated",
          params: {
            threadId: "claude:session-100",
            item: {
              id: "assistant-100",
              type: "agentMessage",
              text: "snapshot text",
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onAgentMessageDelta).toHaveBeenCalledTimes(1);
    expect(handlers.onAgentMessageDelta).toHaveBeenCalledWith({
      workspaceId: "ws-claude",
      threadId: "claude:session-100",
      itemId: "assistant-100",
      delta: "snapshot text",
    });
    expect(handlers.onItemUpdated).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("routes codex/raw native image generation events when thread id is present", async () => {
    const handlers: Handlers = {
      onItemStarted: vi.fn(),
    };
    const { root } = await mount(handlers, {
      useNormalizedRealtimeAdapters: true,
    });

    await act(async () => {
      listener?.({
        workspace_id: "ws-codex",
        message: {
          method: "codex/raw",
          params: {
            threadId: "thread-codex-image",
            type: "event_msg",
            payload: {
              type: "image_generation_end",
              call_id: "ig-raw-fallback-1",
              status: "generating",
              revised_prompt: "搬砖工人的卡通图",
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onItemStarted).toHaveBeenCalledWith(
      "ws-codex",
      "thread-codex-image",
      expect.objectContaining({
        id: "ig-raw-fallback-1",
        type: "image_generation_end",
        call_id: "ig-raw-fallback-1",
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("routes codex/raw imagegen function calls without broad text guessing", async () => {
    const handlers: Handlers = {
      onItemStarted: vi.fn(),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-codex",
        message: {
          method: "codex/raw",
          params: {
            threadId: "thread-codex-image-function",
            type: "response_item",
            payload: {
              type: "function_call",
              call_id: "ig-function-route-1",
              name: "imagegen",
              arguments: JSON.stringify({
                prompt: "一张山谷风景图",
              }),
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onItemStarted).toHaveBeenCalledWith(
      "ws-codex",
      "thread-codex-image-function",
      expect.objectContaining({
        id: "ig-function-route-1",
        type: "mcpToolCall",
        tool: "imagegen",
        status: "in_progress",
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("routes codex/raw image generation events to the unique processing Codex thread when thread identity is missing", async () => {
    const handlers: Handlers = {
      onItemStarted: vi.fn(),
      getSingleProcessingCodexThreadId: vi.fn(
        () => "thread-codex-image-processing",
      ),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-codex",
        message: {
          method: "codex/raw",
          params: {
            type: "event_msg",
            payload: {
              type: "image_generation_call",
              call_id: "ig-raw-active-1",
              status: "generating",
              revised_prompt: "一张狮虎搏杀的电影级海报",
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.getSingleProcessingCodexThreadId).toHaveBeenCalledWith(
      "ws-codex",
    );
    expect(handlers.onItemStarted).toHaveBeenCalledWith(
      "ws-codex",
      "thread-codex-image-processing",
      expect.objectContaining({
        id: "ig-raw-active-1",
        type: "image_generation_call",
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("ignores codex/raw image generation events without any thread identity fallback", async () => {
    const handlers: Handlers = {
      onItemStarted: vi.fn(),
      getSingleProcessingCodexThreadId: vi.fn(() => null),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-codex",
        message: {
          method: "codex/raw",
          params: {
            type: "event_msg",
            payload: {
              type: "image_generation_call",
              call_id: "ig-raw-no-thread-1",
              status: "generating",
              revised_prompt: "一张狮虎搏杀的电影级海报",
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.getSingleProcessingCodexThreadId).toHaveBeenCalledWith(
      "ws-codex",
    );
    expect(handlers.onItemStarted).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("routes claude growing assistant snapshots in normalized mode when delta and snapshot coexist", async () => {
    const handlers: Handlers = {
      onAgentMessageDelta: vi.fn(),
      onAgentMessageCompleted: vi.fn(),
      onItemUpdated: vi.fn(),
      onItemStarted: vi.fn(),
    };
    const { root } = await mount(handlers, {
      useNormalizedRealtimeAdapters: true,
    });

    await act(async () => {
      listener?.({
        workspace_id: "ws-claude",
        message: {
          method: "turn/started",
          params: {
            threadId: "claude:session-seq-1",
            turnId: "turn-1",
          },
        },
      });
      listener?.({
        workspace_id: "ws-claude",
        message: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "claude:session-seq-1",
            itemId: "assistant-seq-1",
            delta: "第一段",
          },
        },
      });
      listener?.({
        workspace_id: "ws-claude",
        message: {
          method: "item/started",
          params: {
            threadId: "claude:session-seq-1",
            item: {
              id: "assistant-seq-1",
              type: "agentMessage",
              text: "第一段",
            },
          },
        },
      });
      listener?.({
        workspace_id: "ws-claude",
        message: {
          method: "item/updated",
          params: {
            threadId: "claude:session-seq-1",
            item: {
              id: "assistant-seq-1",
              type: "agentMessage",
              text: "第一段第二段",
            },
          },
        },
      });
      listener?.({
        workspace_id: "ws-claude",
        message: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "claude:session-seq-1",
            itemId: "assistant-seq-1",
            delta: "第二段",
          },
        },
      });
      listener?.({
        workspace_id: "ws-claude",
        message: {
          method: "item/completed",
          params: {
            threadId: "claude:session-seq-1",
            item: {
              id: "assistant-seq-1",
              type: "agentMessage",
              text: "第一段第二段",
            },
          },
        },
      });
      listener?.({
        workspace_id: "ws-claude",
        message: {
          method: "turn/completed",
          params: {
            threadId: "claude:session-seq-1",
            turnId: "turn-1",
            result: {
              text: "第一段第二段",
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onAgentMessageDelta).toHaveBeenCalledTimes(3);
    expect(handlers.onAgentMessageDelta).toHaveBeenNthCalledWith(1, {
      workspaceId: "ws-claude",
      threadId: "claude:session-seq-1",
      itemId: "assistant-seq-1",
      delta: "第一段",
    });
    expect(handlers.onAgentMessageDelta).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-claude",
      threadId: "claude:session-seq-1",
      itemId: "assistant-seq-1",
      delta: "第一段第二段",
    });
    expect(handlers.onAgentMessageDelta).toHaveBeenNthCalledWith(3, {
      workspaceId: "ws-claude",
      threadId: "claude:session-seq-1",
      itemId: "assistant-seq-1",
      delta: "第二段",
    });
    expect(handlers.onItemStarted).not.toHaveBeenCalled();
    expect(handlers.onItemUpdated).not.toHaveBeenCalled();
    expect(handlers.onAgentMessageCompleted).toHaveBeenCalledTimes(1);
    expect(handlers.onAgentMessageCompleted).toHaveBeenCalledWith({
      workspaceId: "ws-claude",
      threadId: "claude:session-seq-1",
      itemId: "assistant-seq-1",
      text: "第一段第二段",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps claude agent completion when only snapshot and completed arrive in normalized mode", async () => {
    const handlers: Handlers = {
      onAgentMessageDelta: vi.fn(),
      onAgentMessageCompleted: vi.fn(),
      onItemUpdated: vi.fn(),
    };
    const { root } = await mount(handlers, {
      useNormalizedRealtimeAdapters: true,
    });

    await act(async () => {
      listener?.({
        workspace_id: "ws-claude",
        message: {
          method: "item/updated",
          params: {
            threadId: "claude:session-snapshot-only-1",
            item: {
              id: "assistant-snapshot-only-1",
              type: "agentMessage",
              text: "snapshot-only-text",
            },
          },
        },
      });
      listener?.({
        workspace_id: "ws-claude",
        message: {
          method: "item/completed",
          params: {
            threadId: "claude:session-snapshot-only-1",
            item: {
              id: "assistant-snapshot-only-1",
              type: "agentMessage",
              text: "snapshot-only-text",
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onAgentMessageDelta).toHaveBeenCalledTimes(1);
    expect(handlers.onAgentMessageDelta).toHaveBeenCalledWith({
      workspaceId: "ws-claude",
      threadId: "claude:session-snapshot-only-1",
      itemId: "assistant-snapshot-only-1",
      delta: "snapshot-only-text",
    });
    expect(handlers.onItemUpdated).not.toHaveBeenCalled();
    expect(handlers.onAgentMessageCompleted).toHaveBeenCalledTimes(1);
    expect(handlers.onAgentMessageCompleted).toHaveBeenCalledWith({
      workspaceId: "ws-claude",
      threadId: "claude:session-snapshot-only-1",
      itemId: "assistant-snapshot-only-1",
      text: "snapshot-only-text",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("routes claude text:delta through normalized adapters with thread-scoped fallback id when itemId is missing", async () => {
    const handlers: Handlers = {
      onAgentMessageDelta: vi.fn(),
    };
    const { root } = await mount(handlers, {
      useNormalizedRealtimeAdapters: true,
    });

    await act(async () => {
      listener?.({
        workspace_id: "ws-claude",
        message: {
          method: "text:delta",
          params: {
            threadId: "claude:session-77",
            turnId: "turn-77",
            delta: "streaming text",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onAgentMessageDelta).toHaveBeenCalledWith({
      workspaceId: "ws-claude",
      threadId: "claude:session-77",
      itemId: "claude:session-77:text-delta",
      delta: "streaming text",
      turnId: "turn-77",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("routes gemini text:delta through legacy fallback when normalized adapters are disabled", async () => {
    const handlers: Handlers = {
      onAgentMessageDelta: vi.fn(),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-gemini",
        message: {
          method: "text:delta",
          params: {
            threadId: "gemini:session-88",
            itemId: "assistant-88",
            delta: "短正文片段",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onAgentMessageDelta).toHaveBeenCalledWith({
      workspaceId: "ws-gemini",
      threadId: "gemini:session-88",
      itemId: "assistant-88",
      delta: "短正文片段",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("does not route opencode text:delta when normalized realtime adapters are disabled", async () => {
    const handlers: Handlers = {
      onAgentMessageDelta: vi.fn(),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-opencode",
        message: {
          method: "text:delta",
          params: {
            threadId: "opencode:ses_99",
            itemId: "assistant-1",
            delta: "streaming text",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onAgentMessageDelta).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("routes claude item/updated agentMessage snapshot in legacy routing", async () => {
    const handlers: Handlers = {
      onAgentMessageDelta: vi.fn(),
      onItemUpdated: vi.fn(),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-claude",
        message: {
          method: "item/updated",
          params: {
            threadId: "claude:session-101",
            item: {
              id: "assistant-101",
              type: "agentMessage",
              text: "snapshot text",
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onAgentMessageDelta).not.toHaveBeenCalled();
    expect(handlers.onItemUpdated).toHaveBeenCalledTimes(1);
    expect(handlers.onItemUpdated).toHaveBeenCalledWith(
      "ws-claude",
      "claude:session-101",
      expect.objectContaining({
        id: "assistant-101",
        type: "agentMessage",
        text: "snapshot text",
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("ignores codex item/updated agentMessage snapshot after streaming delta in legacy routing", async () => {
    const handlers: Handlers = {
      onAgentMessageDelta: vi.fn(),
      onItemUpdated: vi.fn(),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-codex",
        message: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-codex-legacy-1",
            itemId: "assistant-codex-legacy-1",
            delta: "codex stream",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      listener?.({
        workspace_id: "ws-codex",
        message: {
          method: "item/updated",
          params: {
            threadId: "thread-codex-legacy-1",
            item: {
              id: "assistant-codex-legacy-1",
              type: "agentMessage",
              text: "codex snapshot",
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onAgentMessageDelta).toHaveBeenCalledTimes(1);
    expect(handlers.onAgentMessageDelta).toHaveBeenCalledWith({
      workspaceId: "ws-codex",
      threadId: "thread-codex-legacy-1",
      itemId: "assistant-codex-legacy-1",
      delta: "codex stream",
    });
    expect(handlers.onItemUpdated).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps claude snapshot updates flowing through legacy mode when delta and snapshot coexist", async () => {
    const handlers: Handlers = {
      onAgentMessageDelta: vi.fn(),
      onAgentMessageCompleted: vi.fn(),
      onItemUpdated: vi.fn(),
      onItemStarted: vi.fn(),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-claude",
        message: {
          method: "turn/started",
          params: {
            threadId: "claude:session-seq-2",
            turnId: "turn-2",
          },
        },
      });
      listener?.({
        workspace_id: "ws-claude",
        message: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "claude:session-seq-2",
            itemId: "assistant-seq-2",
            delta: "第一段",
          },
        },
      });
      listener?.({
        workspace_id: "ws-claude",
        message: {
          method: "item/started",
          params: {
            threadId: "claude:session-seq-2",
            item: {
              id: "assistant-seq-2",
              type: "agentMessage",
              text: "第一段",
            },
          },
        },
      });
      listener?.({
        workspace_id: "ws-claude",
        message: {
          method: "item/updated",
          params: {
            threadId: "claude:session-seq-2",
            item: {
              id: "assistant-seq-2",
              type: "agentMessage",
              text: "第一段第二段",
            },
          },
        },
      });
      listener?.({
        workspace_id: "ws-claude",
        message: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "claude:session-seq-2",
            itemId: "assistant-seq-2",
            delta: "第二段",
          },
        },
      });
      listener?.({
        workspace_id: "ws-claude",
        message: {
          method: "item/completed",
          params: {
            threadId: "claude:session-seq-2",
            item: {
              id: "assistant-seq-2",
              type: "agentMessage",
              text: "第一段第二段",
            },
          },
        },
      });
      listener?.({
        workspace_id: "ws-claude",
        message: {
          method: "turn/completed",
          params: {
            threadId: "claude:session-seq-2",
            turnId: "turn-2",
            result: {
              text: "第一段第二段",
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onAgentMessageDelta).toHaveBeenCalledTimes(2);
    expect(handlers.onAgentMessageDelta).toHaveBeenNthCalledWith(1, {
      workspaceId: "ws-claude",
      threadId: "claude:session-seq-2",
      itemId: "assistant-seq-2",
      delta: "第一段",
    });
    expect(handlers.onAgentMessageDelta).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-claude",
      threadId: "claude:session-seq-2",
      itemId: "assistant-seq-2",
      delta: "第二段",
    });
    expect(handlers.onItemStarted).not.toHaveBeenCalled();
    expect(handlers.onItemUpdated).toHaveBeenCalledTimes(1);
    expect(handlers.onItemUpdated).toHaveBeenCalledWith(
      "ws-claude",
      "claude:session-seq-2",
      expect.objectContaining({
        id: "assistant-seq-2",
        type: "agentMessage",
        text: "第一段第二段",
      }),
    );
    expect(handlers.onAgentMessageCompleted).toHaveBeenCalledTimes(1);
    expect(handlers.onAgentMessageCompleted).toHaveBeenCalledWith({
      workspaceId: "ws-claude",
      threadId: "claude:session-seq-2",
      itemId: "assistant-seq-2",
      text: "第一段第二段",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps claude agent completion when only snapshot and completed arrive in legacy mode", async () => {
    const handlers: Handlers = {
      onAgentMessageDelta: vi.fn(),
      onAgentMessageCompleted: vi.fn(),
      onItemUpdated: vi.fn(),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-claude",
        message: {
          method: "item/updated",
          params: {
            threadId: "claude:session-snapshot-only-2",
            item: {
              id: "assistant-snapshot-only-2",
              type: "agentMessage",
              text: "snapshot-only-text",
            },
          },
        },
      });
      listener?.({
        workspace_id: "ws-claude",
        message: {
          method: "item/completed",
          params: {
            threadId: "claude:session-snapshot-only-2",
            item: {
              id: "assistant-snapshot-only-2",
              type: "agentMessage",
              text: "snapshot-only-text",
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onAgentMessageDelta).not.toHaveBeenCalled();
    expect(handlers.onItemUpdated).toHaveBeenCalledTimes(1);
    expect(handlers.onItemUpdated).toHaveBeenCalledWith(
      "ws-claude",
      "claude:session-snapshot-only-2",
      expect.objectContaining({
        id: "assistant-snapshot-only-2",
        type: "agentMessage",
        text: "snapshot-only-text",
      }),
    );
    expect(handlers.onAgentMessageCompleted).toHaveBeenCalledTimes(1);
    expect(handlers.onAgentMessageCompleted).toHaveBeenCalledWith({
      workspaceId: "ws-claude",
      threadId: "claude:session-snapshot-only-2",
      itemId: "assistant-snapshot-only-2",
      text: "snapshot-only-text",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("routes codex agentMessage snapshots through itemUpdated when no normalized handler is provided", async () => {
    const handlers: Handlers = {
      onItemUpdated: vi.fn(),
    };
    const { root } = await mount(handlers, {
      useNormalizedRealtimeAdapters: true,
    });

    await act(async () => {
      listener?.({
        workspace_id: "ws-codex",
        message: {
          method: "item/updated",
          params: {
            threadId: "thread-codex-1",
            item: {
              id: "assistant-codex-1",
              type: "agentMessage",
              text: "codex snapshot",
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onItemUpdated).toHaveBeenCalledTimes(1);
    expect(handlers.onItemUpdated).toHaveBeenCalledWith(
      "ws-codex",
      "thread-codex-1",
      expect.objectContaining({
        id: "assistant-codex-1",
        type: "agentMessage",
        text: "codex snapshot",
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("routes codex normalized realtime events directly when a normalized handler is provided", async () => {
    const handlers: Handlers = {
      onNormalizedRealtimeEvent: vi.fn(),
      onAgentMessageDelta: vi.fn(),
    };
    const { root } = await mount(handlers, {
      useNormalizedRealtimeAdapters: true,
    });

    await act(async () => {
      listener?.({
        workspace_id: "ws-codex-direct",
        message: {
          method: "item/updated",
          params: {
            threadId: "thread-codex-direct-1",
            item: {
              id: "assistant-codex-direct-1",
              type: "agentMessage",
              text: "codex snapshot direct",
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onNormalizedRealtimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        engine: "codex",
        workspaceId: "ws-codex-direct",
        threadId: "thread-codex-direct-1",
        operation: "itemUpdated",
        sourceMethod: "item/updated",
        item: expect.objectContaining({
          id: "assistant-codex-direct-1",
          kind: "message",
          role: "assistant",
          text: "codex snapshot direct",
        }),
      }),
    );
    expect(handlers.onAgentMessageDelta).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("attaches the frozen target to shared normalized assistant items", async () => {
    const workspaceId = "ws-shared-target";
    const sharedThreadId = "shared:thread-target";
    const nativeThreadId = "codex-native-thread-target";
    registerSharedSessionNativeBinding({
      workspaceId,
      sharedThreadId,
      nativeThreadId,
      engine: "codex",
      attemptId: "attempt-shared-target",
    });
    beginTurn(
      workspaceId,
      sharedThreadId,
      freezeTurnSnapshot({
        engine: "codex",
        providerProfileId: "provider-b",
        providerProfileNameSnapshot: "Provider B",
        providerProfileSource: "managed",
        model: "gpt-provider-b",
        reasoning: { effort: "medium" },
      }),
      "attempt-shared-target",
    );
    const handlers: Handlers = {
      onNormalizedRealtimeEvent: vi.fn(),
    };
    const { root } = await mount(handlers, {
      useNormalizedRealtimeAdapters: true,
    });

    await act(async () => {
      listener?.({
        workspace_id: workspaceId,
        message: {
          method: "item/updated",
          params: {
            threadId: nativeThreadId,
            item: {
              id: "assistant-shared-target",
              type: "agentMessage",
              text: "shared snapshot",
            },
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onNormalizedRealtimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: sharedThreadId,
        item: expect.objectContaining({
          id: "assistant-shared-target",
          executionTargetSnapshot: expect.objectContaining({
            engine: "codex",
            providerProfileNameSnapshot: "Provider B",
            model: "gpt-provider-b",
            reasoning: { effort: "medium" },
          }),
        }),
      }),
    );

    clearSharedSessionBindingsForSharedThread(workspaceId, sharedThreadId);
    await act(async () => {
      root.unmount();
    });
  });

  it("carries the exact Shared Runtime owner into approval and user-input control requests", async () => {
    const handlers: Handlers = {
      onApprovalRequest: vi.fn(),
      onRequestUserInput: vi.fn(),
    };
    const { root } = await mount(handlers);
    const sharedOwner = {
      sharedSessionId: "control-owner",
      sharedThreadId: "shared:control-owner",
      nativeThreadId: "codex-native-control",
      runtimeTurnId: "runtime-turn-control",
      attemptId: "attempt-control",
      providerRuntimeKey: "codex::ws-control::provider-a",
      bindingKey: "codex:provider-a",
      engine: "codex",
      executionTargetSnapshot: {
        engine: "codex",
        providerProfileId: "provider-a",
        modelCatalogEntryId: "catalog-a",
        model: "runtime-a",
        reasoning: { effort: "high" },
        providerProfileNameSnapshot: "Provider A",
        providerProfileSource: "managed",
      },
    };
    const expectedOwner = {
      attemptId: "attempt-control",
      providerRuntimeKey: "codex::ws-control::provider-a",
      sharedThreadId: "shared:control-owner",
      nativeThreadId: "codex-native-control",
      runtimeTurnId: "runtime-turn-control",
      engine: "codex",
      providerProfileId: "provider-a",
    };

    await act(async () => {
      listener?.({
        workspace_id: "ws-control",
        message: {
          id: 41,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "shared:control-owner",
            nativeThreadId: "codex-native-control",
            turnId: "runtime-turn-control",
            sharedOwner,
          },
        },
      });
      listener?.({
        workspace_id: "ws-control",
        message: {
          id: 42,
          method: "item/tool/requestUserInput",
          params: {
            threadId: "shared:control-owner",
            nativeThreadId: "codex-native-control",
            turnId: "runtime-turn-control",
            itemId: "ask-control",
            sharedOwner,
            questions: [
              {
                id: "confirm",
                header: "Confirm",
                question: "Continue?",
              },
            ],
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onApprovalRequest).toHaveBeenCalledWith({
      workspace_id: "ws-control",
      request_id: 41,
      method: "item/commandExecution/requestApproval",
      params: expect.any(Object),
      shared_runtime_owner: expectedOwner,
    });
    expect(handlers.onRequestUserInput).toHaveBeenCalledWith({
      workspace_id: "ws-control",
      request_id: 42,
      shared_runtime_owner: expectedOwner,
      params: expect.objectContaining({
        thread_id: "shared:control-owner",
        turn_id: "runtime-turn-control",
        item_id: "ask-control",
      }),
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("fails closed instead of inferring a Shared control owner from thread identity", async () => {
    const handlers: Handlers = {
      onApprovalRequest: vi.fn(),
      onRequestUserInput: vi.fn(),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-control",
        message: {
          id: 51,
          method: "approval/request",
          params: {
            threadId: "shared:missing-owner",
            turnId: "runtime-turn-missing",
          },
        },
      });
      listener?.({
        workspace_id: "ws-control",
        message: {
          id: 52,
          method: "item/tool/requestUserInput",
          params: {
            threadId: "shared:missing-owner",
            turnId: "runtime-turn-missing",
            itemId: "ask-missing",
            questions: [],
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onApprovalRequest).not.toHaveBeenCalled();
    expect(handlers.onRequestUserInput).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("attaches the frozen target when Rust already projected the raw owner to Shared", async () => {
    const workspaceId = "ws-shared-rust-owner";
    const sharedThreadId = "shared:thread-rust-owner";
    beginTurn(
      workspaceId,
      sharedThreadId,
      freezeTurnSnapshot({
        engine: "codex",
        providerProfileId: "poisoned-current-picker",
        providerProfileNameSnapshot: "Poisoned Current Picker",
        providerProfileSource: "managed",
        model: "poisoned-runtime-model",
      }),
      "attempt-kimi",
    );
    const handlers: Handlers = {
      onNormalizedRealtimeEvent: vi.fn(),
    };
    const { root } = await mount(handlers, {
      useNormalizedRealtimeAdapters: true,
    });

    await act(async () => {
      listener?.({
        workspace_id: workspaceId,
        message: {
          method: "item/updated",
          params: {
            threadId: sharedThreadId,
            nativeThreadId: "codex-native-kimi",
            sharedOwner: {
              sharedSessionId: "thread-rust-owner",
              sharedThreadId,
              nativeThreadId: "codex-native-kimi",
              runtimeTurnId: "run-kimi",
              attemptId: "attempt-kimi",
              bindingKey: "codex:provider-kimi",
              engine: "codex",
              executionTargetSnapshot: {
                engine: "codex",
                providerProfileId: "provider-kimi",
                modelCatalogEntryId: "catalog-kimi",
                model: "kimi-for-coding",
                reasoning: { effort: "high" },
                providerProfileNameSnapshot: "Kimi Coding",
                providerProfileSource: "managed",
                runtimeCapabilityFingerprint: "capability-kimi",
              },
            },
            item: {
              id: "assistant-shared-rust-owner",
              type: "agentMessage",
              text: "owned before dispatch RPC returned",
            },
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onNormalizedRealtimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: sharedThreadId,
        item: expect.objectContaining({
          executionTargetSnapshot: expect.objectContaining({
            engine: "codex",
            providerProfileId: "provider-kimi",
            providerProfileNameSnapshot: "Kimi Coding",
            modelCatalogEntryId: "catalog-kimi",
            model: "kimi-for-coding",
            reasoning: { effort: "high" },
            runtimeCapabilityFingerprint: "capability-kimi",
          }),
        }),
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("labels the first Shared delta from the embedded durable target without reading the picker", async () => {
    const handlers: Handlers = {
      onNormalizedRealtimeEvent: vi.fn(),
    };
    const { root } = await mount(handlers, {
      useNormalizedRealtimeAdapters: true,
    });

    await act(async () => {
      listener?.({
        workspace_id: "ws-first-owned-delta",
        message: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "shared:first-owned-delta",
            nativeThreadId: "claude-native-first-owned-delta",
            turnId: "run-first-owned-delta",
            itemId: "assistant-first-owned-delta",
            delta: "first",
            sharedOwner: {
              sharedSessionId: "first-owned-delta",
              sharedThreadId: "shared:first-owned-delta",
              nativeThreadId: "claude-native-first-owned-delta",
              runtimeTurnId: "run-first-owned-delta",
              logicalTurnId: "logical-first-owned-delta",
              attemptId: "attempt-first-owned-delta",
              bindingKey: "claude:provider-first",
              engine: "claude",
              executionTargetSnapshot: {
                engine: "claude",
                providerProfileId: "provider-first",
                modelCatalogEntryId: "catalog-first",
                model: "runtime-first",
                reasoning: { effort: "medium" },
                providerProfileNameSnapshot: "First Provider",
                providerProfileSource: "managed",
                runtimeCapabilityFingerprint: "capability-first",
              },
            },
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onNormalizedRealtimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "shared:first-owned-delta",
        delta: "first",
        item: expect.objectContaining({
          role: "assistant",
          text: "first",
          executionTargetSnapshot: {
            engine: "claude",
            providerProfileId: "provider-first",
            modelCatalogEntryId: "catalog-first",
            model: "runtime-first",
            reasoning: { effort: "medium" },
            providerProfileNameSnapshot: "First Provider",
            providerProfileSource: "managed",
            runtimeCapabilityFingerprint: "capability-first",
          },
        }),
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("does not attach an active snapshot to a different runtime attempt", async () => {
    const workspaceId = "ws-attempt-isolation";
    const sharedThreadId = "shared:attempt-isolation";
    beginTurn(
      workspaceId,
      sharedThreadId,
      freezeTurnSnapshot({
        engine: "codex",
        providerProfileId: "provider-attempt-a",
        model: "model-attempt-a",
      }),
      "attempt-a",
    );
    const handlers: Handlers = {
      onNormalizedRealtimeEvent: vi.fn(),
    };
    const { root } = await mount(handlers, {
      useNormalizedRealtimeAdapters: true,
    });

    await act(async () => {
      listener?.({
        workspace_id: workspaceId,
        message: {
          method: "item/updated",
          params: {
            threadId: sharedThreadId,
            nativeThreadId: "codex-native-attempt-b",
            sharedOwner: {
              sharedSessionId: "attempt-isolation",
              sharedThreadId,
              nativeThreadId: "codex-native-attempt-b",
              attemptId: "attempt-b",
              bindingKey: "codex:provider-attempt-b",
              engine: "codex",
            },
            item: {
              id: "assistant-attempt-b",
              type: "agentMessage",
              text: "attempt b",
            },
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onNormalizedRealtimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        item: expect.not.objectContaining({
          executionTargetSnapshot: expect.anything(),
        }),
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("does not route codex completed agentMessage snapshots through legacy itemCompleted when normalized handler is provided", async () => {
    const handlers: Handlers = {
      onNormalizedRealtimeEvent: vi.fn(),
      onItemCompleted: vi.fn(),
      onThreadTokenUsageUpdated: vi.fn(),
    };
    const { root } = await mount(handlers, {
      useNormalizedRealtimeAdapters: true,
    });

    await act(async () => {
      listener?.({
        workspace_id: "ws-codex-direct",
        message: {
          method: "item/completed",
          params: {
            threadId: "thread-codex-direct-2",
            item: {
              id: "assistant-codex-direct-2",
              type: "agentMessage",
              text: "final direct text",
            },
            usage: {
              input_tokens: 8,
              output_tokens: 13,
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onNormalizedRealtimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        engine: "codex",
        workspaceId: "ws-codex-direct",
        threadId: "thread-codex-direct-2",
        operation: "completeAgentMessage",
        item: expect.objectContaining({
          id: "assistant-codex-direct-2",
          kind: "message",
          role: "assistant",
          text: "final direct text",
        }),
      }),
    );
    expect(handlers.onItemCompleted).not.toHaveBeenCalled();
    expect(handlers.onThreadTokenUsageUpdated).toHaveBeenCalledWith(
      "ws-codex-direct",
      "thread-codex-direct-2",
      expect.objectContaining({
        total: expect.objectContaining({
          inputTokens: 8,
          outputTokens: 13,
        }),
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps codex item/updated snapshots flowing after streaming delta in normalized mode", async () => {
    const handlers: Handlers = {
      onAgentMessageDelta: vi.fn(),
      onItemUpdated: vi.fn(),
    };
    const { root } = await mount(handlers, {
      useNormalizedRealtimeAdapters: true,
    });

    await act(async () => {
      listener?.({
        workspace_id: "ws-codex",
        message: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-codex-2",
            itemId: "assistant-codex-2",
            delta: "codex stream",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      listener?.({
        workspace_id: "ws-codex",
        message: {
          method: "item/updated",
          params: {
            threadId: "thread-codex-2",
            item: {
              id: "assistant-codex-2",
              type: "agentMessage",
              text: "codex snapshot",
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onAgentMessageDelta).toHaveBeenCalledTimes(1);
    expect(handlers.onAgentMessageDelta).toHaveBeenCalledWith({
      workspaceId: "ws-codex",
      threadId: "thread-codex-2",
      itemId: "assistant-codex-2",
      delta: "codex stream",
    });
    expect(handlers.onItemUpdated).toHaveBeenCalledTimes(1);
    expect(handlers.onItemUpdated).toHaveBeenCalledWith(
      "ws-codex",
      "thread-codex-2",
      expect.objectContaining({
        id: "assistant-codex-2",
        type: "agentMessage",
        text: "codex snapshot",
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("prefers codex item/updated snapshot over later delta for the same assistant item", async () => {
    const handlers: Handlers = {
      onNormalizedRealtimeEvent: vi.fn(),
      onAgentMessageDelta: vi.fn(),
    };
    const { root } = await mount(handlers, {
      useNormalizedRealtimeAdapters: true,
    });

    await act(async () => {
      listener?.({
        workspace_id: "ws-codex",
        message: {
          method: "item/updated",
          params: {
            threadId: "thread-codex-3",
            item: {
              id: "assistant-codex-3",
              type: "agentMessage",
              text: "snapshot authority",
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      listener?.({
        workspace_id: "ws-codex",
        message: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-codex-3",
            itemId: "assistant-codex-3",
            delta: "late delta after snapshot",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onNormalizedRealtimeEvent).toHaveBeenCalledTimes(1);
    expect(handlers.onNormalizedRealtimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        engine: "codex",
        workspaceId: "ws-codex",
        threadId: "thread-codex-3",
        operation: "itemUpdated",
        item: expect.objectContaining({
          id: "assistant-codex-3",
          kind: "message",
          role: "assistant",
          text: "snapshot authority",
        }),
      }),
    );
    expect(handlers.onAgentMessageDelta).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("prefers codex item/started snapshot over later delta for the same assistant item", async () => {
    const handlers: Handlers = {
      onNormalizedRealtimeEvent: vi.fn(),
      onAgentMessageDelta: vi.fn(),
    };
    const { root } = await mount(handlers, {
      useNormalizedRealtimeAdapters: true,
    });

    await act(async () => {
      listener?.({
        workspace_id: "ws-codex",
        message: {
          method: "item/started",
          params: {
            threadId: "thread-codex-started-1",
            item: {
              id: "assistant-codex-started-1",
              type: "agentMessage",
              text: "started snapshot authority",
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      listener?.({
        workspace_id: "ws-codex",
        message: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-codex-started-1",
            itemId: "assistant-codex-started-1",
            delta: "late delta after started snapshot",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onNormalizedRealtimeEvent).toHaveBeenCalledTimes(1);
    expect(handlers.onNormalizedRealtimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        engine: "codex",
        workspaceId: "ws-codex",
        threadId: "thread-codex-started-1",
        operation: "itemStarted",
        item: expect.objectContaining({
          id: "assistant-codex-started-1",
          kind: "message",
          role: "assistant",
          text: "started snapshot authority",
        }),
      }),
    );
    expect(handlers.onAgentMessageDelta).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("routes claude text:delta through legacy fallback when normalized adapters are disabled", async () => {
    const handlers: Handlers = {
      onAgentMessageDelta: vi.fn(),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-claude",
        message: {
          method: "text:delta",
          params: {
            threadId: "claude:session-99",
            delta: "streaming text",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onAgentMessageDelta).toHaveBeenCalledWith({
      workspaceId: "ws-claude",
      threadId: "claude:session-99",
      itemId: "claude:session-99:text-delta",
      delta: "streaming text",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("ignores turnId as assistant item id for legacy claude text:delta fallback", async () => {
    const handlers: Handlers = {
      onAgentMessageDelta: vi.fn(),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-claude",
        message: {
          method: "text:delta",
          params: {
            threadId: "claude:session-98",
            turnId: "turn-98",
            delta: "streaming text",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onAgentMessageDelta).toHaveBeenCalledWith({
      workspaceId: "ws-claude",
      threadId: "claude:session-98",
      itemId: "claude:session-98:text-delta",
      delta: "streaming text",
      turnId: "turn-98",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("hydrates tool output from params in legacy item/completed routing", async () => {
    const handlers: Handlers = {
      onItemCompleted: vi.fn(),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-claude",
        message: {
          method: "item/completed",
          params: {
            threadId: "claude:session-42",
            output: "stdout-line-1\nstdout-line-2",
            item: {
              id: "cmd-1",
              type: "commandExecution",
              command: "ls -la",
              status: "completed",
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onItemCompleted).toHaveBeenCalledWith(
      "ws-claude",
      "claude:session-42",
      expect.objectContaining({
        id: "cmd-1",
        type: "commandExecution",
        aggregatedOutput: "stdout-line-1\nstdout-line-2",
        output: "stdout-line-1\nstdout-line-2",
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("routes a Shared turn error with the durable attempt target", async () => {
    const handlers: Handlers = {
      onTurnError: vi.fn(),
    };
    const { root } = await mount(handlers);
    const executionTargetSnapshot = {
      engine: "codex",
      providerProfileId: "provider-error",
      modelCatalogEntryId: "catalog-error",
      model: "runtime-error",
      reasoning: { effort: "high" },
      providerProfileNameSnapshot: "Provider Error",
      providerProfileSource: "managed",
      runtimeCapabilityFingerprint: "capability-error",
    };

    await act(async () => {
      listener?.({
        workspace_id: "ws-shared-error",
        message: {
          method: "turn/error",
          params: {
            threadId: "shared:thread-error",
            nativeThreadId: "codex-native-error",
            turnId: "runtime-turn-error",
            error: { message: "provider rejected" },
            sharedOwner: {
              sharedSessionId: "thread-error",
              sharedThreadId: "shared:thread-error",
              nativeThreadId: "codex-native-error",
              runtimeTurnId: "runtime-turn-error",
              attemptId: "attempt-error",
              bindingKey: "codex:provider-error",
              engine: "codex",
              executionTargetSnapshot,
            },
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onTurnError).toHaveBeenCalledWith(
      "ws-shared-error",
      "shared:thread-error",
      "runtime-turn-error",
      {
        message: "provider rejected",
        willRetry: false,
        engine: "codex",
        executionTargetSnapshot,
      },
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("settles a stale Shared Binding without projecting its raw provider error row", async () => {
    const handlers: Handlers = {
      onTurnError: vi.fn(),
    };
    const { root } = await mount(handlers);

    await act(async () => {
      listener?.({
        workspace_id: "ws-shared-stale",
        message: {
          method: "turn/error",
          params: {
            threadId: "shared:thread-stale",
            nativeThreadId: "claude:session-stale",
            turnId: "runtime-turn-stale",
            sharedRecoveryReason: "native-session-not-found",
            error: {
              message: "No conversation found with session ID: session-stale",
            },
            sharedOwner: {
              sharedSessionId: "thread-stale",
              sharedThreadId: "shared:thread-stale",
              nativeThreadId: "claude:session-stale",
              runtimeTurnId: "runtime-turn-stale",
              attemptId: "attempt-stale",
              bindingKey: "claude:provider-stale",
              engine: "claude",
            },
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onTurnError).toHaveBeenCalledWith(
      "ws-shared-stale",
      "shared:thread-stale",
      "runtime-turn-stale",
      expect.objectContaining({
        suppressMessage: true,
        engine: "claude",
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("projects a terminal-only Shared assistant with its durable target", async () => {
    const handlers: Handlers = {
      onNormalizedRealtimeEvent: vi.fn(),
      onAgentMessageCompleted: vi.fn(),
      onTurnCompleted: vi.fn(),
    };
    const { root } = await mount(handlers);
    const executionTargetSnapshot = {
      engine: "codex",
      providerProfileId: "provider-terminal",
      modelCatalogEntryId: "catalog-terminal",
      model: "runtime-terminal",
      reasoning: { effort: "medium" },
      providerProfileNameSnapshot: "Provider Terminal",
      providerProfileSource: "managed",
      runtimeCapabilityFingerprint: null,
    };

    await act(async () => {
      listener?.({
        workspace_id: "ws-shared-terminal",
        message: {
          method: "turn/completed",
          params: {
            threadId: "shared:thread-terminal",
            nativeThreadId: "native-terminal",
            turnId: "runtime-terminal",
            result: { text: "terminal response" },
            sharedOwner: {
              sharedSessionId: "thread-terminal",
              sharedThreadId: "shared:thread-terminal",
              nativeThreadId: "native-terminal",
              runtimeTurnId: "runtime-terminal",
              attemptId: "attempt-terminal",
              bindingKey: "codex:provider-terminal",
              engine: "codex",
              executionTargetSnapshot,
            },
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onNormalizedRealtimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "completeAgentMessage",
        threadId: "shared:thread-terminal",
        turnId: "runtime-terminal",
        item: expect.objectContaining({
          text: "terminal response",
          executionTargetSnapshot,
        }),
      }),
    );
    // Project-memory fusion requires onAgentMessageCompleted even when canvas
    // projection already succeeded via onNormalizedRealtimeEvent.
    expect(handlers.onAgentMessageCompleted).toHaveBeenCalledWith({
      workspaceId: "ws-shared-terminal",
      threadId: "shared:thread-terminal",
      itemId: "runtime-terminal",
      text: "terminal response",
      turnId: "runtime-terminal",
    });
    expect(handlers.onTurnCompleted).toHaveBeenCalledWith(
      "ws-shared-terminal",
      "shared:thread-terminal",
      "runtime-terminal",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("projects an empty provenance anchor for a reasoning-only Shared turn", async () => {
    const handlers: Handlers = {
      onNormalizedRealtimeEvent: vi.fn(),
      onTurnCompleted: vi.fn(),
    };
    const { root } = await mount(handlers);
    const executionTargetSnapshot = {
      engine: "claude",
      providerProfileId: null,
      modelCatalogEntryId: "claude-local",
      model: "claude-sonnet",
      reasoning: null,
      providerProfileNameSnapshot: "本地配置",
      providerProfileSource: "local",
      runtimeCapabilityFingerprint: null,
    };

    await act(async () => {
      listener?.({
        workspace_id: "ws-shared-reasoning-only",
        message: {
          method: "turn/completed",
          params: {
            threadId: "shared:thread-reasoning-only",
            nativeThreadId: "claude:native-reasoning-only",
            turnId: "runtime-reasoning-only",
            sharedOwner: {
              sharedSessionId: "thread-reasoning-only",
              sharedThreadId: "shared:thread-reasoning-only",
              nativeThreadId: "claude:native-reasoning-only",
              runtimeTurnId: "runtime-reasoning-only",
              attemptId: "attempt-reasoning-only",
              bindingKey: "claude:default",
              engine: "claude",
              executionTargetSnapshot,
            },
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handlers.onNormalizedRealtimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "completeAgentMessage",
        threadId: "shared:thread-reasoning-only",
        item: expect.objectContaining({
          text: "",
          executionTargetSnapshot,
        }),
      }),
    );
    expect(handlers.onTurnCompleted).toHaveBeenCalledWith(
      "ws-shared-reasoning-only",
      "shared:thread-reasoning-only",
      "runtime-reasoning-only",
    );

    await act(async () => {
      root.unmount();
    });
  });

});
