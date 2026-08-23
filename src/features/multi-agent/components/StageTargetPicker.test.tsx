// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { emptyTarget } from "../templates/types";
import { StageTargetPicker, type StageTargetCatalog } from "./StageTargetPicker";
import type { ProviderTargetGroup } from "../../composer/components/ChatInputBox/hooks/useProviderTargetCatalogOwners";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) =>
      params?.model ? `${key}:${params.model}` : key,
  }),
}));

vi.mock("../../engine/components/EngineIcon", () => ({
  EngineIcon: ({ engine }: { engine: string }) => (
    <span data-testid={`${engine}-icon`} />
  ),
}));

function stubCatalog(
  groups: ProviderTargetGroup[],
  overrides?: Partial<StageTargetCatalog>,
): StageTargetCatalog {
  return {
    groups,
    ensureProfiles: vi.fn(),
    ensureModels: vi.fn(),
    reloadConfig: vi.fn(),
    profileLoadError: null,
    ...overrides,
  };
}

const claudeGroups: ProviderTargetGroup[] = [
  {
    providerId: "claude",
    providerLabel: "Claude Code",
    enabled: true,
    profiles: [
      {
        id: "__local_settings_json__",
        label: "本地配置",
        source: "disk",
        enabled: true,
        models: [{ id: "claude-sonnet-4-6", label: "Sonnet 4.6" }],
        loading: false,
        reloadingConfig: false,
        discoveringModels: false,
        discoverySupported: false,
        error: null,
      },
    ],
  },
];

describe("StageTargetPicker", () => {
  it("does not show loading or fetch catalog on mount for empty stage target", () => {
    const catalog = stubCatalog(claudeGroups);

    render(
      <StageTargetPicker
        value={{ ...emptyTarget("claude"), reasoningEffort: "high" }}
        catalog={catalog}
        onChange={vi.fn()}
      />,
    );

    expect(screen.queryByText("models.loading")).toBeNull();
    expect(screen.queryByText("加载中")).toBeNull();
    const trigger = screen.getByRole("button", { name: "models.selectModel" });
    expect((trigger as HTMLButtonElement).disabled).toBe(false);
    expect(trigger.textContent ?? "").toContain("Claude Code");
    expect(catalog.ensureProfiles).not.toHaveBeenCalled();
    expect(catalog.ensureModels).not.toHaveBeenCalled();
  });

  it("shows selected model snapshot when stage target is complete", () => {
    const catalog = stubCatalog(claudeGroups);

    render(
      <StageTargetPicker
        value={{
          ...emptyTarget("claude"),
          model: "claude-sonnet-4-6",
          modelCatalogEntryId: "claude-sonnet-4-6",
          providerProfileNameSnapshot: "本地配置",
          providerProfileSource: "disk",
          reasoningEffort: "high",
        }}
        catalog={catalog}
        onChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: /chat.currentModel:Sonnet 4.6/ })
        .textContent ?? "",
    ).toContain("Sonnet 4.6");
    expect(catalog.ensureModels).not.toHaveBeenCalled();
  });
});
