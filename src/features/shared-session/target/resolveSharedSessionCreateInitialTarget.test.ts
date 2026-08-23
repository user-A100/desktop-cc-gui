import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getClaudeProviders,
  getCodexProviders,
  getEngineModels,
  getGrokProviders,
  getKimiProviders,
  getOpenCodeProviders,
} from "../../../services/tauri";
import { syncClaudeModelMappingForProfile } from "../../vendors/activateEngineProviderProfile";

import {
  loadOrderedSharedCreateProviders,
  loadAuthoritativeModelsForCreateProvider,
  resolveFirstSharedCreateProvider,
  resolveSharedSessionCreateInitialTarget,
} from "./resolveSharedSessionCreateInitialTarget";

vi.mock("../../../services/tauri", () => ({
  getClaudeProviders: vi.fn(),
  getCodexProviders: vi.fn(),
  getGrokProviders: vi.fn(),
  getKimiProviders: vi.fn(),
  getOpenCodeProviders: vi.fn(),
  getEngineModels: vi.fn(),
}));

vi.mock("../../vendors/activateEngineProviderProfile", () => ({
  syncClaudeModelMappingForProfile: vi.fn(),
}));

const getClaudeProvidersMock = vi.mocked(getClaudeProviders);
const getCodexProvidersMock = vi.mocked(getCodexProviders);
const getGrokProvidersMock = vi.mocked(getGrokProviders);
const getKimiProvidersMock = vi.mocked(getKimiProviders);
const getOpenCodeProvidersMock = vi.mocked(getOpenCodeProviders);
const getEngineModelsMock = vi.mocked(getEngineModels);
const syncClaudeModelMappingForProfileMock = vi.mocked(
  syncClaudeModelMappingForProfile,
);

describe("resolveFirstSharedCreateProvider", () => {
  it("picks the first ordered provider as managed when not local", () => {
    expect(
      resolveFirstSharedCreateProvider(
        "claude",
        [
          { id: "minimax-m3", name: "MiniMax-M3", isLocalProvider: false },
          {
            id: "__local_settings_json__",
            name: "本地",
            isLocalProvider: true,
          },
        ],
        "本地配置",
      ),
    ).toEqual({
      id: "minimax-m3",
      name: "MiniMax-M3",
      source: "managed",
    });
  });

  it("normalizes local sentinel to disk source and local display name", () => {
    expect(
      resolveFirstSharedCreateProvider(
        "claude",
        [
          {
            id: "__local_settings_json__",
            name: "settings.json",
            isLocalProvider: true,
          },
        ],
        "本地配置",
      ),
    ).toEqual({
      id: "__local_settings_json__",
      name: "本地配置",
      source: "disk",
    });
  });

  it("keeps Qoder Global as a fixed managed distribution", () => {
    expect(
      resolveFirstSharedCreateProvider(
        "qoder",
        [
          {
            id: "__qoder_global__",
            name: "Qoder Global",
            isLocalProvider: false,
          },
        ],
        "本地配置",
      ),
    ).toEqual({
      id: "__qoder_global__",
      name: "Qoder Global",
      source: "managed",
    });
  });

  it("keeps the Qoder empty-list fallback as an explicit Global binding", () => {
    expect(
      resolveFirstSharedCreateProvider("qoder", [], "本地配置"),
    ).toEqual({
      id: "__qoder_global__",
      name: "Qoder Global",
      source: "managed",
    });
  });
});

describe("loadAuthoritativeModelsForCreateProvider", () => {
  beforeEach(() => {
    getEngineModelsMock.mockReset();
    getEngineModelsMock.mockResolvedValue([]);
  });

  it("force-refreshes local profiles", async () => {
    await loadAuthoritativeModelsForCreateProvider("claude", {
      id: "__local_settings_json__",
      name: "本地配置",
      source: "disk",
    });
    expect(getEngineModelsMock).toHaveBeenCalledWith("claude", {
      providerProfileId: "__local_settings_json__",
      forceRefresh: true,
    });
  });

  it("loads managed profiles without forceRefresh", async () => {
    await loadAuthoritativeModelsForCreateProvider("claude", {
      id: "minimax-m3",
      name: "MiniMax-M3",
      source: "managed",
    });
    expect(getEngineModelsMock).toHaveBeenCalledWith("claude", {
      providerProfileId: "minimax-m3",
    });
  });
});

describe("resolveSharedSessionCreateInitialTarget", () => {
  beforeEach(() => {
    getClaudeProvidersMock.mockReset();
    getCodexProvidersMock.mockReset();
    getGrokProvidersMock.mockReset();
    getKimiProvidersMock.mockReset();
    getOpenCodeProvidersMock.mockReset();
    getEngineModelsMock.mockReset();
    syncClaudeModelMappingForProfileMock.mockReset();
    syncClaudeModelMappingForProfileMock.mockResolvedValue(undefined);
  });

  it("uses first claude provider with authoritative models and syncs mapping", async () => {
    getClaudeProvidersMock.mockResolvedValue([
      {
        id: "__local_settings_json__",
        name: "Local",
        isLocalProvider: true,
      },
      {
        id: "minimax-m3",
        name: "MiniMax-M3",
        isLocalProvider: false,
      },
    ] as never);
    getEngineModelsMock.mockResolvedValue([
      {
        id: "claude-opus-5",
        model: "real-local-opus",
        displayName: "real-local-opus",
        description: "",
        isDefault: true,
      },
    ]);

    const target = await resolveSharedSessionCreateInitialTarget({
      engine: "claude",
      localProviderName: "本地配置",
      unavailableModelMessage: "Claude 没有可用 Model。",
    });

    expect(syncClaudeModelMappingForProfileMock).toHaveBeenCalledWith(
      "__local_settings_json__",
    );
    expect(getEngineModelsMock).toHaveBeenCalledWith("claude", {
      providerProfileId: "__local_settings_json__",
      forceRefresh: true,
    });
    expect(target).toEqual(
      expect.objectContaining({
        engine: "claude",
        providerProfileId: null,
        modelCatalogEntryId: "claude-opus-5",
        model: "real-local-opus",
        providerProfileNameSnapshot: "本地配置",
        providerProfileSource: "disk",
      }),
    );
  });

  it("defaults to managed first provider without local mislabel", async () => {
    getClaudeProvidersMock.mockResolvedValue([
      {
        id: "minimax-m3",
        name: "MiniMax-M3",
        isLocalProvider: false,
      },
    ] as never);
    getEngineModelsMock.mockResolvedValue([
      {
        id: "claude-sonnet-5",
        model: "MiniMax-M3",
        displayName: "MiniMax-M3",
        description: "",
        isDefault: true,
      },
    ]);

    const target = await resolveSharedSessionCreateInitialTarget({
      engine: "claude",
      localProviderName: "本地配置",
      unavailableModelMessage: "Claude 没有可用 Model。",
    });

    expect(getEngineModelsMock).toHaveBeenCalledWith("claude", {
      providerProfileId: "minimax-m3",
    });
    expect(target.providerProfileId).toBe("minimax-m3");
    expect(target.providerProfileSource).toBe("managed");
    expect(target.providerProfileNameSnapshot).toBe("MiniMax-M3");
    expect(target.providerProfileNameSnapshot).not.toBe("本地配置");
  });

  it("fails closed when authoritative catalog is empty", async () => {
    getGrokProvidersMock.mockResolvedValue([
      {
        id: "__local_config_toml__",
        name: "Local",
        isLocalProvider: true,
      },
    ] as never);
    getEngineModelsMock.mockResolvedValue([]);

    await expect(
      resolveSharedSessionCreateInitialTarget({
        engine: "grok",
        localProviderName: "本地配置",
        unavailableModelMessage: "Grok CLI 没有可用 Model。",
      }),
    ).rejects.toThrow("Grok CLI");
  });

  it("resolves Pi to the local sentinel without fetching any vendor list", async () => {
    getEngineModelsMock.mockResolvedValue([
      {
        id: "kimi-coding/k3",
        model: "kimi-coding/k3",
        displayName: "kimi-coding/k3",
        description: "",
        isDefault: true,
      },
    ]);

    const target = await resolveSharedSessionCreateInitialTarget({
      engine: "pi",
      localProviderName: "本地配置",
      unavailableModelMessage: "Pi CLI 没有可用 Model。",
    });

    expect(getClaudeProvidersMock).not.toHaveBeenCalled();
    expect(getCodexProvidersMock).not.toHaveBeenCalled();
    expect(getKimiProvidersMock).not.toHaveBeenCalled();
    expect(getGrokProvidersMock).not.toHaveBeenCalled();
    expect(getOpenCodeProvidersMock).not.toHaveBeenCalled();
    expect(getEngineModelsMock).toHaveBeenCalledWith("pi", {
      providerProfileId: "__local_pi__",
      forceRefresh: true,
    });
    expect(target).toEqual(
      expect.objectContaining({
        engine: "pi",
        providerProfileId: null,
        modelCatalogEntryId: "kimi-coding/k3",
        model: "kimi-coding/k3",
        providerProfileNameSnapshot: "本地配置",
        providerProfileSource: "disk",
      }),
    );
  });

  it("resolves Qoder to Global without reading an unrelated vendor list", async () => {
    getEngineModelsMock.mockResolvedValue([
      {
        id: "qoder-global-model",
        model: "qoder-global-model",
        displayName: "Qoder Global model",
        description: "",
        isDefault: true,
        providerProfileId: "__qoder_global__",
      },
    ]);

    const providers = await loadOrderedSharedCreateProviders("qoder");
    expect(providers).toEqual([
      {
        id: "__qoder_global__",
        name: "Qoder Global",
        isLocalProvider: false,
      },
      {
        id: "__qoder_cn__",
        name: "Qoder CN",
        isLocalProvider: false,
      },
    ]);

    const target = await resolveSharedSessionCreateInitialTarget({
      engine: "qoder",
      localProviderName: "本地配置",
      unavailableModelMessage: "Qoder 没有可用 Model。",
    });

    expect(getEngineModelsMock).toHaveBeenCalledWith("qoder", {
      providerProfileId: "__qoder_global__",
    });
    expect(target).toEqual(
      expect.objectContaining({
        engine: "qoder",
        providerProfileId: "__qoder_global__",
        providerProfileNameSnapshot: "Qoder Global",
        providerProfileSource: "managed",
      }),
    );
  });

  it("does not abort create when claude mapping sync fails", async () => {
    getClaudeProvidersMock.mockResolvedValue([
      {
        id: "__local_settings_json__",
        name: "Local",
        isLocalProvider: true,
      },
    ] as never);
    syncClaudeModelMappingForProfileMock.mockRejectedValueOnce(
      new Error("mapping offline"),
    );
    getEngineModelsMock.mockResolvedValue([
      {
        id: "claude-haiku-4-5",
        model: "haiku",
        displayName: "haiku",
        description: "",
        isDefault: true,
      },
    ]);

    await expect(
      resolveSharedSessionCreateInitialTarget({
        engine: "claude",
        localProviderName: "本地配置",
        unavailableModelMessage: "Claude 没有可用 Model。",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        modelCatalogEntryId: "claude-haiku-4-5",
        model: "haiku",
      }),
    );
  });
});
