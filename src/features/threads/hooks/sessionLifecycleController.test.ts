import { describe, expect, it, vi } from "vitest";
import {
  addForkThreadNamePrefix,
  createSessionLifecycleThreadStarter,
  extractProviderBindingFromStartedThread,
  extractThreadId,
  isManagedEngineProviderProfileId,
  localProviderBindingForEngine,
  providerBindingFromSelectedProfile,
  resolveClaudeForkThreadName,
  resolveSendProviderProfileId,
} from "./sessionLifecycleController";

vi.mock("../../../services/globalRuntimeNotices", () => ({
  pushGlobalRuntimeNotice: vi.fn(),
}));

describe("sessionLifecycleController", () => {
  it("extracts thread ids from supported response shapes", () => {
    expect(extractThreadId({ result: { thread: { id: "codex:1" } } })).toBe("codex:1");
    expect(extractThreadId({ thread_id: 42 })).toBe("42");
    expect(extractThreadId(null)).toBe("");
  });

  it("keeps provider binding from response before fallback", () => {
    expect(
      extractProviderBindingFromStartedThread(
        {
          thread: {
            provider_profile_id: "profile-a",
            provider_profile_name: "Profile A",
          },
        },
        { providerProfileId: "fallback" },
      ),
    ).toMatchObject({
      providerProfileId: "profile-a",
      providerProfileName: "Profile A",
    });
  });

  it("builds provider binding from selected profile", () => {
    expect(
      providerBindingFromSelectedProfile({
        id: "profile-a",
        name: "Profile A",
        source: "managed",
      }),
    ).toMatchObject({
      providerProfileId: "profile-a",
      providerProfileName: "Profile A",
      providerProfileSource: "managed",
      providerAvailability: "available",
    });
  });

  it("builds disk provider display metadata from disk profile id fallback", () => {
    expect(
      providerBindingFromSelectedProfile(null, "__disk__"),
    ).toMatchObject({
      providerProfileId: "__disk__",
      providerProfileName: "本地配置",
      providerProfileSource: "disk",
      providerAvailability: "available",
    });
  });

  it.each([
    "__local_settings_json__",
    "__local_config_toml__",
    "__local_opencode_json__",
    "__local_pi__",
    "__dsh_host_catalog__",
    "__local_qoder__",
  ])("keeps local profile %s for sidebar labels", (profileId) => {
    expect(
      providerBindingFromSelectedProfile({
        id: profileId,
        name: "Local config",
        source: "disk",
      }),
    ).toMatchObject({
      providerProfileId: profileId,
      providerProfileName: "Local config",
      providerProfileSource: "disk",
    });
  });

  it("defaults PI / DSH / Grok locally and Qoder to its explicit Global binding", () => {
    expect(localProviderBindingForEngine("pi")).toMatchObject({
      providerProfileId: "__local_pi__",
    });
    expect(localProviderBindingForEngine("dsh")).toMatchObject({
      providerProfileId: "__dsh_host_catalog__",
    });
    expect(localProviderBindingForEngine("grok")).toMatchObject({
      providerProfileId: "__local_config_toml__",
    });
    expect(localProviderBindingForEngine("qoder")).toMatchObject({
      providerProfileId: "__qoder_global__",
      providerProfileName: "Qoder Global",
      providerProfileSource: "managed",
    });
    expect(isManagedEngineProviderProfileId("__local_pi__")).toBe(false);
    expect(isManagedEngineProviderProfileId("__local_qoder__")).toBe(false);
    expect(isManagedEngineProviderProfileId("grok-managed")).toBe(true);
  });

  it("send uses the thread managed binding instead of a leftover composer picker", () => {
    expect(
      resolveSendProviderProfileId({
        threadProviderProfileId: "provider-b",
        composerProviderProfileId: "provider-a",
      }),
    ).toBe("provider-b");
    expect(
      resolveSendProviderProfileId({
        threadProviderProfileId: "__local_pi__",
        composerProviderProfileId: "provider-a",
      }),
    ).toBeNull();
    expect(
      resolveSendProviderProfileId({
        threadProviderProfileId: null,
        composerProviderProfileId: "provider-a",
      }),
    ).toBe("provider-a");
    expect(
      resolveSendProviderProfileId({
        threadProviderProfileId: null,
        composerProviderProfileId: "__disk__",
      }),
    ).toBeNull();
  });

  it("prefixes Claude fork names without duplicating the prefix", () => {
    expect(addForkThreadNamePrefix("Release plan")).toBe("fork-Release plan");
    expect(addForkThreadNamePrefix("fork-Release plan")).toBe("fork-Release plan");
    expect(addForkThreadNamePrefix("")).toBe("fork-Claude Session");
  });

  it("resolves Claude fork names from sidebar summary or first user message", () => {
    expect(
      resolveClaudeForkThreadName({
        workspaceId: "ws",
        parentThreadId: "thread-1",
        threadsByWorkspace: { ws: [{ id: "thread-1", name: "Summary title" }] as any },
        itemsByThread: {},
      }),
    ).toBe("fork-Summary title");

    expect(
      resolveClaudeForkThreadName({
        workspaceId: "ws",
        parentThreadId: "thread-1",
        threadsByWorkspace: { ws: [] },
        itemsByThread: {
          "thread-1": [
            {
              id: "m1",
              kind: "message",
              role: "user",
              text: "Explain the release pipeline",
            },
          ] as any,
        },
      }),
    ).toBe("fork-Explain the release pipeline");
  });

  it("creates a lifecycle starter without message runtime side effects", () => {
    const dispatch = vi.fn();
    const loadedThreadsRef = { current: {} };
    const starter = createSessionLifecycleThreadStarter({
      dispatch,
      loadedThreadsRef,
      workspaceId: "ws",
      folderId: "folder",
      shouldActivate: true,
      selectedProviderBinding: { providerProfileId: "profile-a" },
    });

    expect(starter({ thread: { id: "codex:1" } })).toBe("codex:1");
    expect(loadedThreadsRef.current).toEqual({ "codex:1": true });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "ensureThread" }));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "setActiveThreadId" }));
  });
});
