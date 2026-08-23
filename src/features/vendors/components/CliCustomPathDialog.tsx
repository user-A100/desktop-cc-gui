import { useEffect, useState, type ReactNode } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { SettingsRowHelp } from "./SettingsRowHelp";

export type CliCustomPathEngine =
  | "claude"
  | "codex"
  | "kimi"
  | "grok"
  | "opencode"
  | "pi"
  | "dsh"
  | "qoder"
  | "qoder-cn";

export type CliCustomPathSavePayload = {
  path: string | null;
  args?: string | null;
};

type PathSourceMode = "system" | "custom";

type CliCustomPathDialogProps = {
  isOpen: boolean;
  engine: CliCustomPathEngine;
  initialPath: string | null;
  initialArgs?: string | null;
  onSave: (payload: CliCustomPathSavePayload) => Promise<void>;
  onClose: () => void;
};

/** Shared display meta for every CLI engine — single source, no per-engine branches in render. */
const CLI_CUSTOM_PATH_ENGINE_META: Record<
  CliCustomPathEngine,
  { command: string; displayName: string }
> = {
  claude: { command: "claude", displayName: "Claude Code CLI" },
  codex: { command: "codex", displayName: "Codex CLI" },
  kimi: { command: "kimi", displayName: "Kimi CLI" },
  grok: { command: "grok", displayName: "Grok CLI" },
  opencode: { command: "opencode", displayName: "OpenCode CLI" },
  pi: { command: "pi", displayName: "PI CLI" },
  dsh: { command: "dsh", displayName: "DeepSeek Harness" },
  qoder: { command: "qodercli", displayName: "Qoder Global CLI" },
  "qoder-cn": { command: "qoderclicn", displayName: "Qoder CN CLI" },
};

function normalizeNullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function resolvePathSourceMode(path: string | null | undefined): PathSourceMode {
  return path?.trim() ? "custom" : "system";
}

export function CliCustomPathDialog({
  isOpen,
  engine,
  initialPath,
  initialArgs = null,
  onSave,
  onClose,
}: CliCustomPathDialogProps) {
  const { t } = useTranslation();
  const meta = CLI_CUSTOM_PATH_ENGINE_META[engine];
  const supportsArgs = engine === "codex";

  const [mode, setMode] = useState<PathSourceMode>(() =>
    resolvePathSourceMode(initialPath),
  );
  const [pathDraft, setPathDraft] = useState(initialPath ?? "");
  const [argsDraft, setArgsDraft] = useState(initialArgs ?? "");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setMode(resolvePathSourceMode(initialPath));
    setPathDraft(initialPath ?? "");
    setArgsDraft(initialArgs ?? "");
    setIsSaving(false);
    setError(null);
  }, [initialArgs, initialPath, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isSaving) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isOpen, isSaving, onClose]);

  if (!isOpen) {
    return null;
  }

  const nextPath = mode === "system" ? null : normalizeNullable(pathDraft);
  const nextArgs = normalizeNullable(argsDraft);
  const customPathMissing = mode === "custom" && nextPath === null;
  const dirty =
    nextPath !== (initialPath ?? null) ||
    (supportsArgs && nextArgs !== (initialArgs ?? null));
  const canSave = dirty && !isSaving && !customPathMissing;

  const handleModeChange = (nextMode: PathSourceMode) => {
    if (isSaving || nextMode === mode) {
      return;
    }
    setMode(nextMode);
    setError(null);
  };

  const handleBrowse = async () => {
    const selection = await openFileDialog({
      multiple: false,
      directory: false,
    });
    if (!selection || Array.isArray(selection)) {
      return;
    }
    setMode("custom");
    setPathDraft(selection);
  };

  const handleSave = async () => {
    if (!canSave) {
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      await onSave(
        supportsArgs
          ? { path: nextPath, args: nextArgs }
          : { path: nextPath },
      );
      onClose();
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : String(saveError),
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div
      className="vendor-dialog-overlay"
      onClick={() => !isSaving && onClose()}
    >
      <div
        className="vendor-dialog vendor-dialog-md"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cli-custom-path-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="vendor-dialog-header">
          <h3 id="cli-custom-path-dialog-title">
            {t("settings.vendor.customPathTitle", {
              engine: meta.displayName,
            })}
          </h3>
          <button
            type="button"
            className="vendor-dialog-close"
            onClick={() => !isSaving && onClose()}
            disabled={isSaving}
            aria-label={t("settings.vendor.cancel")}
          >
            &times;
          </button>
        </div>

        <div className="vendor-dialog-body vendor-dialog-body-compact">
          <div className="cli-path-field">
            <span className="settings-field-label" id="cli-path-source-label">
              {t("settings.vendor.customPathSourceLabel")}
            </span>
            <div
              className="settings-segmented cli-path-mode-segmented"
              role="group"
              aria-labelledby="cli-path-source-label"
            >
              <button
                type="button"
                className={cn(
                  "settings-segmented-btn",
                  mode === "system" && "active",
                )}
                onClick={() => handleModeChange("system")}
                disabled={isSaving}
                aria-pressed={mode === "system"}
              >
                {t("settings.vendor.customPathModeSystem")}
              </button>
              <button
                type="button"
                className={cn(
                  "settings-segmented-btn",
                  mode === "custom" && "active",
                )}
                onClick={() => handleModeChange("custom")}
                disabled={isSaving}
                aria-pressed={mode === "custom"}
              >
                {t("settings.vendor.customPathModeCustom")}
              </button>
            </div>
          </div>

          {mode === "system" ? (
            <div className="cli-path-mode-status" role="status">
              <span>{t("settings.vendor.customPathSystemHint")}</span>
              <code>{meta.command}</code>
            </div>
          ) : (
            <div className="cli-path-field">
              <label
                className="settings-field-label"
                htmlFor="cli-custom-path-input"
              >
                {t("settings.vendor.customPathFieldLabel")}
              </label>
              <div className="settings-field-row">
                <input
                  id="cli-custom-path-input"
                  className="settings-input"
                  value={pathDraft}
                  placeholder={t("settings.vendor.customPathPlaceholder", {
                    command: meta.command,
                  })}
                  onChange={(event) => setPathDraft(event.target.value)}
                  disabled={isSaving}
                  autoFocus
                />
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void handleBrowse()}
                  disabled={isSaving}
                >
                  {t("settings.browse")}
                </button>
              </div>
              <div className="settings-help">
                {t("settings.vendor.customPathCustomHint")}
              </div>
              {customPathMissing ? (
                <div className="settings-help" role="status">
                  {t("settings.vendor.customPathRequired")}
                </div>
              ) : null}
            </div>
          )}

          {supportsArgs ? (
            <div className="cli-path-field">
              <label
                className="settings-field-label"
                htmlFor="cli-custom-args-input"
              >
                {t("settings.defaultCodexArgs")}
              </label>
              <div className="settings-field-row">
                <input
                  id="cli-custom-args-input"
                  className="settings-input"
                  value={argsDraft}
                  placeholder={t("settings.codexArgsPlaceholder")}
                  onChange={(event) => setArgsDraft(event.target.value)}
                  disabled={isSaving}
                />
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setArgsDraft("")}
                  disabled={isSaving}
                >
                  {t("settings.clear")}
                </button>
              </div>
              <div className="settings-help">
                {t("settings.codexArgsDesc")}{" "}
                <code>{t("settings.appServer")}</code>
                {t("settings.codexArgsDescSuffix")}
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="settings-help" role="alert">
              {error}
            </div>
          ) : null}
        </div>

        <div className="vendor-dialog-footer">
          <button
            type="button"
            className="vendor-btn-cancel"
            onClick={onClose}
            disabled={isSaving}
          >
            {t("settings.vendor.cancel")}
          </button>
          <button
            type="button"
            className="vendor-btn-save"
            onClick={() => void handleSave()}
            disabled={!canSave}
          >
            {isSaving ? t("settings.saving") : t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

type CliCustomPathEntryProps = {
  engine: CliCustomPathEngine;
  path: string | null;
  args?: string | null;
  showArgsSummary?: boolean;
  /**
   * When set, path/args status is folded into this help popover and no
   * secondary line is rendered under the title.
   */
  helpContent?: ReactNode;
  onConfigure: () => void;
};

export function CliCustomPathEntry({
  engine,
  path,
  args = null,
  showArgsSummary = false,
  helpContent,
  onConfigure,
}: CliCustomPathEntryProps) {
  const { t } = useTranslation();
  const meta = CLI_CUSTOM_PATH_ENGINE_META[engine];
  const pathSummary = path?.trim()
    ? path.trim()
    : t("settings.vendor.customPathUsingSystemPath");
  const argsSummary =
    showArgsSummary && args?.trim()
      ? args.trim()
      : showArgsSummary
        ? t("settings.vendor.customPathNoArgs")
        : null;
  const summary = argsSummary
    ? `${pathSummary} · ${argsSummary}`
    : pathSummary;
  // Dense group cards use the help popover for status; keep inline summary only
  // when the caller did not provide help (legacy / other layouts).
  const showInlineSummary = !helpContent;

  return (
    <div
      className="vendor-group-row vendor-group-row-clickable vendor-custom-path-row"
      onClick={onConfigure}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onConfigure();
        }
      }}
    >
      <div className="vendor-group-row-copy">
        <span className="vendor-group-row-title">
          {t("settings.vendor.customPathTitle", {
            engine: meta.displayName,
          })}
          {helpContent ? <SettingsRowHelp>{helpContent}</SettingsRowHelp> : null}
        </span>
        {showInlineSummary ? (
          <div
            className="settings-help vendor-custom-path-summary"
            title={summary}
          >
            {summary}
          </div>
        ) : null}
      </div>
      <div className="vendor-group-row-trailing">
        <button
          type="button"
          className="vendor-group-row-chevron-btn"
          aria-label={t("settings.vendor.configurePath")}
          onClick={(event) => {
            event.stopPropagation();
            onConfigure();
          }}
        >
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
