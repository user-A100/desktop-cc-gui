import { useMemo } from "react";

import type { EngineType } from "../../../types";
import type { ExecutionTarget } from "../../shared-session/target/types";
import { resolveAtomicReasoningOptions } from "../../models/atomicModelReasoning";
import type { ProviderTargetGroup } from "../../composer/components/ChatInputBox/hooks/useProviderTargetCatalogOwners";
import { ModelSelect } from "../../composer/components/ChatInputBox/selectors/ModelSelect";
import { ReasoningSelect } from "../../composer/components/ChatInputBox/selectors/ReasoningSelect";
import type { ModelInfo, ReasoningEffort } from "../../composer/components/ChatInputBox/types";
import type { AgentExecutionTarget } from "../types";

export type StageTargetCatalog = {
  groups: ProviderTargetGroup[];
  ensureProfiles: () => Promise<void> | void;
  ensureModels: (
    engine: EngineType,
    providerProfileId: string,
  ) => Promise<ModelInfo[] | void> | ModelInfo[] | void;
  reloadConfig: (
    engine: EngineType,
    providerProfileId: string,
  ) => Promise<void> | void;
  profileLoadError: string | null;
};

type StageTargetPickerProps = {
  value: AgentExecutionTarget;
  catalog: StageTargetCatalog;
  disabled?: boolean;
  onChange: (next: AgentExecutionTarget) => void;
};

function toExecutionTarget(value: AgentExecutionTarget): ExecutionTarget {
  return {
    engine: value.engine,
    providerProfileId: value.providerProfileId ?? null,
    modelCatalogEntryId: value.modelCatalogEntryId ?? null,
    model: value.model ?? null,
    reasoning: value.reasoningEffort
      ? { effort: value.reasoningEffort }
      : null,
    providerProfileNameSnapshot: value.providerProfileNameSnapshot ?? null,
    providerProfileSource:
      (value.providerProfileSource as ExecutionTarget["providerProfileSource"]) ??
      null,
  };
}

function fromExecutionTarget(
  target: ExecutionTarget,
  prev: AgentExecutionTarget,
): AgentExecutionTarget {
  return {
    engine: target.engine,
    providerProfileId: target.providerProfileId ?? null,
    modelCatalogEntryId: target.modelCatalogEntryId ?? null,
    model: target.model ?? null,
    reasoningEffort:
      target.reasoning?.effort ?? prev.reasoningEffort ?? null,
    providerProfileNameSnapshot: target.providerProfileNameSnapshot ?? null,
    providerProfileSource: target.providerProfileSource ?? null,
    runtimeCapabilityFingerprint: prev.runtimeCapabilityFingerprint ?? null,
  };
}

/**
 * 模板编辑器用：与 PromptEnhancerDialog 同一套 ModelSelect + ReasoningSelect。
 * catalog 由弹层单例注入，禁止每段自挂 useAtomicProviderTargetCatalog。
 * 模型列表只在打开菜单时拉取（onOpenTargetCatalog / onOpenProviderProfile）。
 */
export function StageTargetPicker({
  value,
  catalog,
  disabled,
  onChange,
}: StageTargetPickerProps) {
  const providerId = (
    ["claude", "codex", "kimi", "grok", "opencode", "pi", "qoder"].includes(
      value.engine,
    )
      ? value.engine
      : "claude"
  ) as "claude" | "codex" | "kimi" | "grok" | "opencode" | "pi" | "qoder";

  const executionTarget = useMemo(() => toExecutionTarget(value), [value]);

  const reasoningOptions = useMemo(() => {
    return resolveAtomicReasoningOptions(value.engine, {
      id: value.modelCatalogEntryId ?? value.model ?? undefined,
      model: value.model ?? value.modelCatalogEntryId ?? undefined,
    }) as ReasoningEffort[];
  }, [value.engine, value.model, value.modelCatalogEntryId]);

  const modelValue =
    value.modelCatalogEntryId?.trim() || value.model?.trim() || "";

  return (
    <div
      className={`ma-stage-target-picker${disabled ? " is-disabled" : ""}`}
      aria-disabled={disabled || undefined}
    >
      <ModelSelect
        value={modelValue}
        onChange={() => undefined}
        currentProvider={providerId}
        targetGroups={catalog.groups}
        executionTarget={executionTarget}
        onExecutionTargetChange={(next) => {
          if (disabled) return;
          onChange(fromExecutionTarget(next, value));
        }}
        onOpenTargetCatalog={() => {
          void catalog.ensureProfiles();
        }}
        onOpenProviderProfile={(engine, profileId) =>
          catalog.ensureModels(engine, profileId)
        }
        onReloadProviderConfig={(engine, profileId) =>
          catalog.reloadConfig(engine, profileId)
        }
        targetCatalogError={catalog.profileLoadError}
        triggerVariant="default"
        menuLayer="overlay"
      />
      {reasoningOptions.length > 0 ? (
        <ReasoningSelect
          value={(value.reasoningEffort as ReasoningEffort | null) ?? null}
          options={reasoningOptions}
          disabled={disabled}
          onChange={(effort) => {
            if (disabled) return;
            onChange({
              ...value,
              reasoningEffort: effort,
            });
          }}
        />
      ) : null}
    </div>
  );
}
