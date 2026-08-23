import { describe, expect, it } from "vitest";
import {
  clearSharedSessionBindingsForSharedThread,
  hasPendingSharedSessionBindingForEngine,
  isSharedOwnedNativeThreadId,
  registerSharedSessionNativeBinding,
  rebindSharedSessionNativeThread,
  resolvePendingSharedSessionBindingForEngine,
  resolvePendingSharedSessionBindingForTarget,
  resolveSharedSessionBindingByNativeThread,
  resolveSharedSessionBindingFromRuntimeOwner,
  resolveSharedRuntimeControlOwner,
} from "./sharedSessionBridge";
import { QODER_GLOBAL_PROVIDER_PROFILE_ID } from "../../threads/constants/codexProviderProfiles";

describe("sharedSessionBridge", () => {
  it("routes Rust runtime owner metadata before frontend binding registration", () => {
    expect(
      resolveSharedSessionBindingFromRuntimeOwner("ws-owner", {
        threadId: "shared:thread-owner",
        nativeThreadId: "claude:native-owner",
        sharedOwner: {
          sharedThreadId: "shared:thread-owner",
          nativeThreadId: "claude:native-owner",
          engine: "claude",
          attemptId: "attempt-owner",
          executionTargetSnapshot: {
            engine: "claude",
            providerProfileId: "provider-owner",
            modelCatalogEntryId: "catalog-sonnet",
            model: "claude-sonnet-runtime",
            reasoning: { effort: "high" },
            providerProfileNameSnapshot: "Owner Provider",
            providerProfileSource: "managed",
            runtimeCapabilityFingerprint: "capability-owner",
          },
        },
      }),
    ).toEqual({
      workspaceId: "ws-owner",
      sharedThreadId: "shared:thread-owner",
      nativeThreadId: "claude:native-owner",
      engine: "claude",
      attemptId: "attempt-owner",
      providerProfileId: "provider-owner",
      executionTargetSnapshot: {
        engine: "claude",
        providerProfileId: "provider-owner",
        modelCatalogEntryId: "catalog-sonnet",
        model: "claude-sonnet-runtime",
        reasoning: { effort: "high" },
        providerProfileNameSnapshot: "Owner Provider",
        providerProfileSource: "managed",
        runtimeCapabilityFingerprint: "capability-owner",
      },
    });
  });

  it("routes a hidden native event through its canonical Runtime owner", () => {
    expect(
      resolveSharedSessionBindingFromRuntimeOwner("ws-native-owner", {
        threadId: "claude:hidden-native-owner",
        nativeThreadId: "claude:hidden-native-owner",
        sharedOwner: {
          sharedThreadId: "shared:native-owner",
          nativeThreadId: "claude:hidden-native-owner",
          engine: "claude",
          attemptId: "attempt-native-owner",
        },
      }),
    ).toMatchObject({
      workspaceId: "ws-native-owner",
      sharedThreadId: "shared:native-owner",
      nativeThreadId: "claude:hidden-native-owner",
      engine: "claude",
      attemptId: "attempt-native-owner",
    });
  });

  it("preserves durable Squad binding identity before frontend hydration", () => {
    expect(
      resolveSharedSessionBindingFromRuntimeOwner("ws-squad", {
        sharedOwner: {
          sharedThreadId: "shared:squad",
          nativeThreadId: "codex:native-squad",
          engine: "codex",
          attemptId: "attempt-squad",
          bindingKey: "squad:run-1:analyze-1:codex:default",
        },
      }),
    ).toMatchObject({
      attemptId: "attempt-squad",
      bindingKey: "squad:run-1:analyze-1:codex:default",
    });
  });

  it("rejects a runtime owner whose embedded snapshot has a different engine", () => {
    const binding = resolveSharedSessionBindingFromRuntimeOwner("ws-owner", {
      threadId: "shared:thread-owner",
      nativeThreadId: "claude:native-owner",
      sharedOwner: {
        sharedThreadId: "shared:thread-owner",
        nativeThreadId: "claude:native-owner",
        engine: "claude",
        attemptId: "attempt-owner",
        executionTargetSnapshot: {
          engine: "codex",
          model: "poisoned-current-picker-model",
        },
      },
    });

    expect(binding).toBeNull();
  });

  it.each(["kimi", "grok", "opencode"] as const)(
    "routes %s runtime owner metadata into Shared Session",
    (engine) => {
      expect(
        resolveSharedSessionBindingFromRuntimeOwner("ws-owner", {
          threadId: "shared:thread-owner",
          nativeThreadId: `${engine}:native-owner`,
          sharedOwner: {
            sharedThreadId: "shared:thread-owner",
            nativeThreadId: `${engine}:native-owner`,
            engine,
            attemptId: "attempt-owner",
            executionTargetSnapshot: {
              engine,
              providerProfileId: `provider-${engine}`,
              modelCatalogEntryId: `catalog-${engine}`,
              model: `runtime-${engine}`,
              providerProfileNameSnapshot: `${engine} Provider`,
              providerProfileSource: "managed",
            },
          },
        }),
      ).toMatchObject({
        workspaceId: "ws-owner",
        sharedThreadId: "shared:thread-owner",
        nativeThreadId: `${engine}:native-owner`,
        engine,
        attemptId: "attempt-owner",
        providerProfileId: `provider-${engine}`,
      });
    },
  );

  it("requires the complete Runtime owner for Shared control responses", () => {
    const params = {
      threadId: "shared:thread-owner",
      nativeThreadId: "codex-native-owner",
      turnId: "runtime-turn-owner",
      sharedOwner: {
        sharedThreadId: "shared:thread-owner",
        nativeThreadId: "codex-native-owner",
        runtimeTurnId: "runtime-turn-owner",
        attemptId: "attempt-owner",
        providerRuntimeKey: "codex::ws-owner::provider-owner",
        engine: "codex",
        executionTargetSnapshot: {
          engine: "codex",
          providerProfileId: "provider-owner",
          modelCatalogEntryId: "catalog-owner",
          model: "runtime-owner",
          providerProfileNameSnapshot: "Owner Provider",
          providerProfileSource: "managed",
        },
      },
    };

    expect(resolveSharedRuntimeControlOwner("ws-owner", params)).toEqual({
      attemptId: "attempt-owner",
      providerRuntimeKey: "codex::ws-owner::provider-owner",
      sharedThreadId: "shared:thread-owner",
      nativeThreadId: "codex-native-owner",
      runtimeTurnId: "runtime-turn-owner",
      engine: "codex",
      providerProfileId: "provider-owner",
    });
    expect(
      resolveSharedRuntimeControlOwner("ws-owner", {
        ...params,
        sharedOwner: {
          ...params.sharedOwner,
          providerRuntimeKey: "",
        },
      }),
    ).toBeNull();
    expect(
      resolveSharedRuntimeControlOwner("ws-owner", {
        ...params,
        threadId: "shared:poisoned",
      }),
    ).toBeNull();
    // Historical Claude bug: params.turnId was assistant item id while
    // sharedOwner.runtimeTurnId was the attempt runtime turn → fail closed.
    expect(
      resolveSharedRuntimeControlOwner("ws-owner", {
        ...params,
        turnId: "assistant-item-stale",
      }),
    ).toBeNull();
  });

  it("accepts Shared control owner when turnId matches runtimeTurnId after projection", () => {
    // Mirrors Rust project_app_server_event_to_shared_owner force-align for
    // item/tool/requestUserInput (stale assistant-item turnId rewritten).
    const params = {
      threadId: "shared:thread-owner",
      nativeThreadId: "claude:native-ask",
      turnId: "runtime-turn-ask",
      sharedOwner: {
        sharedThreadId: "shared:thread-owner",
        nativeThreadId: "claude:native-ask",
        runtimeTurnId: "runtime-turn-ask",
        attemptId: "attempt-ask",
        providerRuntimeKey: "claude::ws-owner::provider-ask",
        engine: "claude",
        executionTargetSnapshot: {
          engine: "claude",
          providerProfileId: "provider-ask",
          modelCatalogEntryId: "catalog-ask",
          model: "claude-runtime",
          providerProfileNameSnapshot: "Claude Ask",
          providerProfileSource: "managed" as const,
        },
      },
    };
    expect(resolveSharedRuntimeControlOwner("ws-owner", params)).toEqual({
      attemptId: "attempt-ask",
      providerRuntimeKey: "claude::ws-owner::provider-ask",
      sharedThreadId: "shared:thread-owner",
      nativeThreadId: "claude:native-ask",
      runtimeTurnId: "runtime-turn-ask",
      engine: "claude",
      providerProfileId: "provider-ask",
    });
  });

  it("rejects a runtime owner whose provider conflicts with the frozen snapshot", () => {
    const binding = resolveSharedSessionBindingFromRuntimeOwner("ws-owner", {
      threadId: "shared:thread-owner",
      nativeThreadId: "claude:native-owner",
      sharedOwner: {
        sharedThreadId: "shared:thread-owner",
        nativeThreadId: "claude:native-owner",
        engine: "claude",
        providerProfileId: "provider-poisoned",
        attemptId: "attempt-owner",
        executionTargetSnapshot: {
          engine: "claude",
          providerProfileId: "provider-owner",
          modelCatalogEntryId: "catalog-sonnet",
          model: "claude-sonnet-runtime",
          providerProfileNameSnapshot: "Owner Provider",
          providerProfileSource: "managed",
        },
      },
    });

    expect(binding).toBeNull();
  });

  it("registers and resolves native thread bindings for shared sessions", () => {
    registerSharedSessionNativeBinding({
      workspaceId: "ws-1",
      sharedThreadId: "shared:thread-1",
      nativeThreadId: "claude-pending-shared-1",
      engine: "claude",
    });

    expect(
      resolveSharedSessionBindingByNativeThread("ws-1", "claude-pending-shared-1"),
    ).toEqual({
      workspaceId: "ws-1",
      sharedThreadId: "shared:thread-1",
      nativeThreadId: "claude-pending-shared-1",
      engine: "claude",
    });

    clearSharedSessionBindingsForSharedThread("ws-1", "shared:thread-1");
  });

  it("rebinds pending native thread ids to finalized session ids", () => {
    registerSharedSessionNativeBinding({
      workspaceId: "ws-2",
      sharedThreadId: "shared:thread-2",
      nativeThreadId: "claude-pending-shared-1",
      engine: "claude",
    });

    const rebound = rebindSharedSessionNativeThread({
      workspaceId: "ws-2",
      oldNativeThreadId: "claude-pending-shared-1",
      newNativeThreadId: "claude:session-1",
    });

    expect(rebound?.nativeThreadId).toBe("claude:session-1");
    expect(
      resolveSharedSessionBindingByNativeThread("ws-2", "claude:session-1")?.sharedThreadId,
    ).toBe("shared:thread-2");
    expect(resolveSharedSessionBindingByNativeThread("ws-2", "claude-pending-shared-1")).toBeNull();

    clearSharedSessionBindingsForSharedThread("ws-2", "shared:thread-2");
  });

  it("resolves a unique pending binding for engine-level shared routing", () => {
    registerSharedSessionNativeBinding({
      workspaceId: "ws-3",
      sharedThreadId: "shared:thread-3",
      nativeThreadId: "codex-pending-shared-3",
      engine: "codex",
    });
    expect(
      resolvePendingSharedSessionBindingForEngine("ws-3", "codex")?.sharedThreadId,
    ).toBe("shared:thread-3");
    clearSharedSessionBindingsForSharedThread("ws-3", "shared:thread-3");
  });

  it("requires pending binding match to be unique", () => {
    registerSharedSessionNativeBinding({
      workspaceId: "ws-4",
      sharedThreadId: "shared:thread-4a",
      nativeThreadId: "codex-pending-shared-4a",
      engine: "codex",
    });
    registerSharedSessionNativeBinding({
      workspaceId: "ws-4",
      sharedThreadId: "shared:thread-4b",
      nativeThreadId: "codex-pending-shared-4b",
      engine: "codex",
    });
    expect(resolvePendingSharedSessionBindingForEngine("ws-4", "codex")).toBeNull();
    clearSharedSessionBindingsForSharedThread("ws-4", "shared:thread-4a");
    clearSharedSessionBindingsForSharedThread("ws-4", "shared:thread-4b");
  });

  it("ignores stale pending bindings when resolving by engine", () => {
    const now = Date.now();
    registerSharedSessionNativeBinding({
      workspaceId: "ws-5",
      sharedThreadId: "shared:thread-5",
      nativeThreadId: "codex-pending-shared-5",
      engine: "codex",
      registeredAtMs: now - 31_000,
    });
    expect(resolvePendingSharedSessionBindingForEngine("ws-5", "codex")).toBeNull();
    clearSharedSessionBindingsForSharedThread("ws-5", "shared:thread-5");
  });

  it("resolves pending bindings per execution target when dual providers run in parallel", () => {
    registerSharedSessionNativeBinding({
      workspaceId: "ws-6",
      sharedThreadId: "shared:thread-6a",
      nativeThreadId: "claude-pending-shared-6a",
      engine: "claude",
    });
    registerSharedSessionNativeBinding({
      workspaceId: "ws-6",
      sharedThreadId: "shared:thread-6b",
      nativeThreadId: "claude-pending-shared-6b",
      engine: "claude",
      providerProfileId: "openrouter",
    });

    // Target 级解析：每个 provider 各自命中自己的 pending binding。
    expect(
      resolvePendingSharedSessionBindingForTarget("ws-6", "claude", null)?.sharedThreadId,
    ).toBe("shared:thread-6a");
    expect(
      resolvePendingSharedSessionBindingForTarget("ws-6", "claude", "openrouter")
        ?.sharedThreadId,
    ).toBe("shared:thread-6b");

    // 旧 engine-only 解析在同 engine 双 pending 时仍 fail-closed（不跨线）。
    expect(resolvePendingSharedSessionBindingForEngine("ws-6", "claude")).toBeNull();

    clearSharedSessionBindingsForSharedThread("ws-6", "shared:thread-6a");
    clearSharedSessionBindingsForSharedThread("ws-6", "shared:thread-6b");
  });

  it("does not cross-match default and managed provider bindings", () => {
    registerSharedSessionNativeBinding({
      workspaceId: "ws-7",
      sharedThreadId: "shared:thread-7",
      nativeThreadId: "codex-pending-shared-7",
      engine: "codex",
      providerProfileId: "openai",
    });

    // default 查询不命中 managed-provider binding。
    expect(resolvePendingSharedSessionBindingForTarget("ws-7", "codex")).toBeNull();
    expect(
      resolvePendingSharedSessionBindingForTarget("ws-7", "codex", "  "),
    ).toBeNull();
    // 其他 managed provider 也不命中。
    expect(
      resolvePendingSharedSessionBindingForTarget("ws-7", "codex", "openrouter"),
    ).toBeNull();
    // 归属 provider 精确命中。
    expect(
      resolvePendingSharedSessionBindingForTarget("ws-7", "codex", "openai")
        ?.nativeThreadId,
    ).toBe("codex-pending-shared-7");

    clearSharedSessionBindingsForSharedThread("ws-7", "shared:thread-7");
  });

  it("fails closed when two providers expose the same native thread identity", () => {
    registerSharedSessionNativeBinding({
      workspaceId: "ws-8",
      sharedThreadId: "shared:thread-8a",
      nativeThreadId: "native-collision",
      engine: "codex",
      providerProfileId: "provider-a",
    });
    registerSharedSessionNativeBinding({
      workspaceId: "ws-8",
      sharedThreadId: "shared:thread-8b",
      nativeThreadId: "native-collision",
      engine: "codex",
      providerProfileId: "provider-b",
    });

    expect(
      resolveSharedSessionBindingByNativeThread("ws-8", "native-collision"),
    ).toBeNull();
    expect(
      rebindSharedSessionNativeThread({
        workspaceId: "ws-8",
        oldNativeThreadId: "native-collision",
        newNativeThreadId: "must-not-rebind",
      }),
    ).toBeNull();

    clearSharedSessionBindingsForSharedThread("ws-8", "shared:thread-8a");
    clearSharedSessionBindingsForSharedThread("ws-8", "shared:thread-8b");
  });

  it("recognizes Qoder legacy aliases against a Global canonical binding", () => {
    const canonicalId = `qoder:${QODER_GLOBAL_PROVIDER_PROFILE_ID}:raw-session`;
    registerSharedSessionNativeBinding({
      workspaceId: "ws-qoder-alias",
      sharedThreadId: "shared:thread-qoder-alias",
      nativeThreadId: canonicalId,
      engine: "qoder",
      providerProfileId: QODER_GLOBAL_PROVIDER_PROFILE_ID,
    });

    expect(
      resolveSharedSessionBindingByNativeThread("ws-qoder-alias", canonicalId)
        ?.sharedThreadId,
    ).toBe("shared:thread-qoder-alias");
    expect(
      isSharedOwnedNativeThreadId("ws-qoder-alias", "qoder-pending-shared-x"),
    ).toBe(true);
    expect(hasPendingSharedSessionBindingForEngine("ws-qoder-alias", "qoder")).toBe(
      false,
    );

    clearSharedSessionBindingsForSharedThread(
      "ws-qoder-alias",
      "shared:thread-qoder-alias",
    );
  });

  it("does not treat a user Grok native as Shared-owned", () => {
    expect(isSharedOwnedNativeThreadId("ws-user-grok", "grok:user-native")).toBe(
      false,
    );
    expect(hasPendingSharedSessionBindingForEngine("ws-user-grok", "grok")).toBe(
      false,
    );
  });
});
