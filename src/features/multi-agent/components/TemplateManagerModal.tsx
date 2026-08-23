import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import CircleHelp from "lucide-react/dist/esm/icons/circle-help";

import { pushErrorToast } from "../../../services/toasts";
import { useAtomicProviderTargetCatalog } from "../../composer/components/ChatInputBox/hooks/useProviderTargetCatalogOwners";
import type { ProviderId } from "../../composer/components/ChatInputBox/types";
import {
  cloneStage,
  createBlankTemplate,
  deleteCustomTemplate,
  getDefaultTemplateId,
  getTemplateById,
  saveCustomTemplate,
  setDefaultTemplate,
  useTemplateCatalogSnapshot,
} from "../templates/templateStore";
import type {
  CollaborationTemplate,
  CollaborationTemplateStage,
} from "../templates/types";
import {
  displayStageTitle,
  displayTemplateDescription,
  displayTemplateName,
  normalizeStagesFeedModes,
  templateApprovalCount,
  templateFlowLabel,
} from "../templates/types";
import { isCompleteAgentTargetForUi } from "../templates/targetCompleteness";
import { StageAgentPicker } from "./StageAgentPicker";
import { StageTargetPicker } from "./StageTargetPicker";

type TemplateManagerModalProps = {
  open: boolean;
  initialTemplateId?: string | null;
  onClose: () => void;
};

function emptyEditor(template: CollaborationTemplate): CollaborationTemplate {
  // 内置模板展示/编辑用当前 UI 语言，保存后变「我的模板」时保留该语言文案
  const name = displayTemplateName(template);
  const description = displayTemplateDescription(template);
  return {
    ...template,
    name,
    description,
    stages: normalizeStagesFeedModes(
      template.stages.map((stage) => ({
        ...stage,
        title: displayStageTitle(template, stage),
        target: { ...stage.target },
      })),
    ),
  };
}

export function TemplateManagerModal({
  open,
  initialTemplateId,
  onClose,
}: TemplateManagerModalProps) {
  const { t } = useTranslation();
  const catalog = useTemplateCatalogSnapshot();
  // 弹层单例 catalog：与 PromptEnhancerDialog 一样，选择器只消费 groups，打开菜单才拉模型。
  const targetCatalog = useAtomicProviderTargetCatalog({
    enabled: open,
    mode: "shared",
    currentProvider: "claude",
    currentProviderProfileId: null,
    resolveProviderLabel: (id: ProviderId) =>
      t(`providers.${id}.label`, { defaultValue: id }),
    kimiDisabledReason: "",
  });
  const [activeId, setActiveId] = useState(
    initialTemplateId ?? catalog.selectedId,
  );
  const [draft, setDraft] = useState<CollaborationTemplate>(() =>
    emptyEditor(getTemplateById(activeId)),
  );
  const [query, setQuery] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);

  // 仅 open / 显式切模板时 hydrate draft，避免 store 重渲打断输入焦点
  useEffect(() => {
    if (!open) return;
    const id = initialTemplateId ?? catalog.selectedId;
    setActiveId(id);
    setDraft(emptyEditor(getTemplateById(id)));
    setQuery("");
    setHelpOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 故意不依赖 catalog 全量，防失焦
  }, [open, initialTemplateId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return catalog.templates;
    return catalog.templates.filter((item) => {
      const name = displayTemplateName(item).toLowerCase();
      const description = displayTemplateDescription(item).toLowerCase();
      return (
        name.includes(q) ||
        description.includes(q) ||
        item.name.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q)
      );
    });
  }, [catalog.templates, query]);

  const builtins = filtered.filter((item) => item.builtin);
  const customs = filtered.filter((item) => !item.builtin);
  const isBuiltinOrigin = draft.builtin;
  const makeDefault =
    draft.id === getDefaultTemplateId() || draft.id === catalog.defaultId;

  if (!open) return null;

  const pick = (id: string) => {
    setActiveId(id);
    setDraft(emptyEditor(getTemplateById(id)));
  };

  const startNew = () => {
    const blank = createBlankTemplate();
    setActiveId(blank.id);
    setDraft(emptyEditor(blank));
  };

  const updateStage = (
    index: number,
    patch: Partial<CollaborationTemplateStage>,
  ) => {
    setDraft((prev) => ({
      ...prev,
      stages: prev.stages.map((stage, i) =>
        i === index ? { ...stage, ...patch } : stage,
      ),
    }));
  };

  const removeStage = (index: number) => {
    setDraft((prev) => ({
      ...prev,
      stages: normalizeStagesFeedModes(
        prev.stages.filter((_, i) => i !== index),
      ),
    }));
  };

  const addStage = () => {
    setDraft((prev) => ({
      ...prev,
      stages: normalizeStagesFeedModes([
        ...prev.stages,
        cloneStage({
          title: t("multiAgent.template.stageFallback", {
            n: prev.stages.length + 1,
          }),
          // 新增在末尾，默认吃摘要；若成首段由 normalize 改为 full
          upstreamFeedMode: "summary",
        }),
      ]),
    }));
  };

  const moveStage = (index: number, delta: -1 | 1) => {
    setDraft((prev) => {
      const next = index + delta;
      if (next < 0 || next >= prev.stages.length) return prev;
      const stages = [...prev.stages];
      const [row] = stages.splice(index, 1);
      stages.splice(next, 0, row!);
      // 谁到首位谁强制「吃全文」
      return { ...prev, stages: normalizeStagesFeedModes(stages) };
    });
  };

  const save = () => {
    if (!draft.name.trim()) {
      pushErrorToast({
        title: t("multiAgent.template.savedTitle"),
        message: t("multiAgent.template.nameRequired"),
      });
      return;
    }
    if (draft.stages.length === 0) {
      pushErrorToast({
        title: t("multiAgent.template.savedTitle"),
        message: t("multiAgent.template.stageRequired"),
      });
      return;
    }
    const incomplete = draft.stages.filter(
      (s) => !isCompleteAgentTargetForUi(s.target),
    );
    // 允许保存不完整 target（发送时回退会话 target），但明确提示
    const saved = saveCustomTemplate({
      ...draft,
      name: draft.name.trim(),
      description: draft.description.trim(),
      builtin: false,
    });
    if (makeDefault) setDefaultTemplate(saved.id);
    setActiveId(saved.id);
    setDraft(emptyEditor(saved));
    pushErrorToast({
      variant: "success",
      title: t("multiAgent.template.savedTitle"),
      message:
        incomplete.length > 0
          ? t("multiAgent.template.savedWithIncomplete", {
              name: saved.name,
              count: incomplete.length,
            })
          : t("multiAgent.template.saved", { name: saved.name }),
    });
  };

  const remove = () => {
    // 工厂本体无本地副本时：无法从磁盘删除，提示可改后保存覆盖
    const hasLocalCopy = catalog.templates.some(
      (item) => item.id === draft.id && !item.builtin,
    );
    if (isBuiltinOrigin && !hasLocalCopy) {
      pushErrorToast({
        title: t("multiAgent.template.delete"),
        message: t("multiAgent.template.builtinResetHint"),
      });
      return;
    }
    // 删除本地覆盖 → 若命中工厂 id 则恢复内置默认（允许）
    deleteCustomTemplate(draft.id);
    pushErrorToast({
      variant: "success",
      title: t("multiAgent.template.deletedTitle"),
      message: t("multiAgent.template.deleted", { name: draft.name }),
    });
    const fallback = getDefaultTemplateId();
    pick(fallback);
  };

  const stopFieldMouseDown = (event: MouseEvent) => {
    // 防止父层 mousedown / 选择器抢焦点
    event.stopPropagation();
  };

  const modal = (
    <div
      className="ma-tpl-overlay"
      data-composer-portal-focus-guard
      role="dialog"
      aria-modal="true"
      aria-label={t("multiAgent.template.modalTitle")}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`ma-tpl-modal${helpOpen ? " has-help" : ""}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="ma-tpl-modal-head">
          <div>
            <div className="ma-tpl-modal-title">
              {t("multiAgent.template.modalTitle")}
            </div>
            <div className="ma-tpl-modal-sub">
              {t("multiAgent.template.modalSub")}
            </div>
          </div>
          <div className="ma-tpl-head-actions">
            <button
              type="button"
              className={`ma-tpl-help-btn${helpOpen ? " is-on" : ""}`}
              onClick={() => setHelpOpen((v) => !v)}
              aria-expanded={helpOpen}
              aria-controls="ma-tpl-help-panel"
              aria-label={t("multiAgent.template.helpTitle")}
              title={t("multiAgent.template.helpTitle")}
            >
              <CircleHelp size={16} strokeWidth={2} aria-hidden />
            </button>
            <button type="button" className="ma-tpl-close" onClick={onClose}>
              {t("multiAgent.template.close")}
            </button>
          </div>
        </header>

        <div className="ma-tpl-main-row">
        <div className="ma-tpl-body">
          <aside className="ma-tpl-list">
            <input
              className="ma-tpl-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onMouseDown={stopFieldMouseDown}
              placeholder={t("multiAgent.template.search")}
            />
            {builtins.length > 0 ? (
              <>
                <div className="ma-tpl-grp">
                  {t("multiAgent.template.builtin")}
                </div>
                {builtins.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className={`ma-tpl-item${activeId === item.id ? " is-on" : ""}`}
                    onClick={() => pick(item.id)}
                  >
                    <div className="ma-tpl-item-nm">
                      {displayTemplateName(item)}
                      {item.id === catalog.defaultId ? (
                        <span className="ma-tpl-def">
                          {t("multiAgent.template.defaultBadge")}
                        </span>
                      ) : null}
                    </div>
                    <div className="ma-tpl-item-meta">
                      {templateFlowLabel(item)} ·{" "}
                      {t("multiAgent.template.approvalCount", {
                        count: templateApprovalCount(item),
                      })}
                    </div>
                  </button>
                ))}
              </>
            ) : null}
            <div className="ma-tpl-grp">{t("multiAgent.template.mine")}</div>
            {customs.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`ma-tpl-item${activeId === item.id ? " is-on" : ""}`}
                onClick={() => pick(item.id)}
              >
                <div className="ma-tpl-item-nm">
                  {displayTemplateName(item)}
                </div>
                <div className="ma-tpl-item-meta">
                  {templateFlowLabel(item)}
                </div>
              </button>
            ))}
            <button type="button" className="ma-tpl-new" onClick={startNew}>
              {t("multiAgent.template.new")}
            </button>
          </aside>

          <div className="ma-tpl-editor">
            <div className="ma-tpl-row1">
              <input
                className="ma-tpl-name"
                value={draft.name}
                onMouseDown={stopFieldMouseDown}
                onChange={(event) =>
                  setDraft((prev) => ({ ...prev, name: event.target.value }))
                }
              />
              <label className="ma-tpl-mkdef">
                <span
                  className={`ma-tgl${makeDefault ? " is-on" : ""}`}
                  onClick={() => setDefaultTemplate(draft.id)}
                  role="switch"
                  aria-checked={makeDefault}
                />
                {t("multiAgent.template.setDefault")}
              </label>
            </div>
            <input
              className="ma-tpl-desc"
              value={draft.description}
              onMouseDown={stopFieldMouseDown}
              placeholder={t("multiAgent.template.descPlaceholder")}
              onChange={(event) =>
                setDraft((prev) => ({
                  ...prev,
                  description: event.target.value,
                }))
              }
            />

            {draft.stages.map((stage, index) => (
              <div className="ma-step-ed" key={`${stage.id}-${index}`}>
                <div className="ma-step-ed-top">
                  <span
                    className="ma-step-drag"
                    aria-hidden
                    title={t("multiAgent.template.reorder")}
                  >
                    <button
                      type="button"
                      className="ma-step-move"
                      disabled={index === 0}
                      onClick={() => moveStage(index, -1)}
                      aria-label={t("multiAgent.template.moveUp")}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="ma-step-move"
                      disabled={index === draft.stages.length - 1}
                      onClick={() => moveStage(index, 1)}
                      aria-label={t("multiAgent.template.moveDown")}
                    >
                      ↓
                    </button>
                  </span>
                  <input
                    className="ma-step-name"
                    value={stage.title}
                    onMouseDown={stopFieldMouseDown}
                    onChange={(event) =>
                      updateStage(index, { title: event.target.value })
                    }
                  />
                  <StageTargetPicker
                    value={stage.target}
                    catalog={targetCatalog}
                    onChange={(target) => updateStage(index, { target })}
                  />
                  {!isCompleteAgentTargetForUi(stage.target) ? (
                    <span
                      className="ma-stage-incomplete"
                      title={t("multiAgent.template.incompleteTargetHint")}
                    >
                      {t("multiAgent.template.incompleteTarget")}
                    </span>
                  ) : null}
                  <label className="ma-appr">
                    <span
                      className={`ma-tgl${stage.requiresApproval ? " is-on" : ""}`}
                      onClick={() =>
                        updateStage(index, {
                          requiresApproval: !stage.requiresApproval,
                        })
                      }
                      role="switch"
                      aria-checked={stage.requiresApproval}
                    />
                    {t("multiAgent.template.requiresApproval")}
                  </label>
                  <div
                    className="ma-feed-mode"
                    role="group"
                    aria-label={t("multiAgent.template.upstreamFeedAria")}
                  >
                    <button
                      type="button"
                      className={`ma-feed-mode-btn${
                        (stage.upstreamFeedMode ??
                          (index === 0 ? "full" : "summary")) === "summary"
                          ? " is-on"
                          : ""
                      }`}
                      onClick={() =>
                        updateStage(index, { upstreamFeedMode: "summary" })
                      }
                    >
                      {t("multiAgent.template.upstreamFeedSummary")}
                    </button>
                    <button
                      type="button"
                      className={`ma-feed-mode-btn${
                        (stage.upstreamFeedMode ??
                          (index === 0 ? "full" : "summary")) === "full"
                          ? " is-on"
                          : ""
                      }`}
                      onClick={() =>
                        updateStage(index, { upstreamFeedMode: "full" })
                      }
                    >
                      {t("multiAgent.template.upstreamFeedFull")}
                    </button>
                  </div>
                  <StageAgentPicker
                    value={
                      stage.personaAgentId && stage.personaAgentName
                        ? {
                            id: stage.personaAgentId,
                            name: stage.personaAgentName,
                            icon: stage.personaAgentIcon ?? null,
                          }
                        : null
                    }
                    onChange={(persona) => {
                      if (!persona) {
                        updateStage(index, {
                          personaAgentId: null,
                          personaAgentName: null,
                          personaAgentIcon: null,
                          personaAgentPrompt: null,
                        });
                        return;
                      }
                      // 智能体正文单独冻结；不改写本步 rolePrompt（流程指令）
                      updateStage(index, {
                        personaAgentId: persona.id,
                        personaAgentName: persona.name,
                        personaAgentIcon: persona.icon ?? null,
                        personaAgentPrompt: persona.prompt?.trim() || null,
                      });
                    }}
                  />
                  <button
                    type="button"
                    className="ma-step-del"
                    onClick={() => removeStage(index)}
                    aria-label={t("multiAgent.template.deleteStage")}
                  >
                    🗑
                  </button>
                </div>
                <textarea
                  value={stage.rolePrompt}
                  onMouseDown={stopFieldMouseDown}
                  onChange={(event) =>
                    updateStage(index, { rolePrompt: event.target.value })
                  }
                  placeholder={t("multiAgent.template.promptPlaceholder")}
                />
              </div>
            ))}

            <button type="button" className="ma-add-step" onClick={addStage}>
              {t("multiAgent.template.addStage")}
            </button>

            <div className="ma-tpl-efoot">
              <button type="button" className="ma-danger" onClick={remove}>
                {t("multiAgent.template.delete")}
              </button>
              <button type="button" className="ma-ghost" onClick={onClose}>
                {t("multiAgent.template.cancel")}
              </button>
              <button type="button" className="ma-primary" onClick={save}>
                {t("multiAgent.template.save")}
              </button>
            </div>
          </div>
        </div>

        {helpOpen ? (
          <aside
            id="ma-tpl-help-panel"
            className="ma-tpl-help"
            aria-label={t("multiAgent.template.helpTitle")}
          >
            <div className="ma-tpl-help-head">
              <strong>{t("multiAgent.template.helpTitle")}</strong>
              <button
                type="button"
                className="ma-tpl-help-close"
                onClick={() => setHelpOpen(false)}
              >
                {t("multiAgent.template.helpClose")}
              </button>
            </div>
            <div className="ma-tpl-help-body">
              <p className="ma-tpl-help-lead">
                {t("multiAgent.template.helpLead")}
              </p>
              <dl className="ma-tpl-help-list">
                {(
                  [
                    "helpMove",
                    "helpStageName",
                    "helpTarget",
                    "helpApproval",
                    "helpFeed",
                    "helpPersona",
                    "helpClearPersona",
                    "helpDeleteStage",
                    "helpRolePrompt",
                    "helpAddStage",
                    "helpDefault",
                    "helpSave",
                  ] as const
                ).map((key) => (
                  <div key={key} className="ma-tpl-help-item">
                    <dt>{t(`multiAgent.template.${key}Label`)}</dt>
                    <dd>{t(`multiAgent.template.${key}Desc`)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </aside>
        ) : null}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
