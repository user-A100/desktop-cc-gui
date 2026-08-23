/** Qoder distribution 的登录/PAT 区块，布局对齐 PI。 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Eye from "lucide-react/dist/esm/icons/eye";
import EyeOff from "lucide-react/dist/esm/icons/eye-off";
import LogIn from "lucide-react/dist/esm/icons/log-in";

import {
  qoderAuthDeletePat,
  qoderAuthSetPat,
  qoderAuthStatus,
  type QoderAuthStatus,
} from "../../../services/tauri/qoderAuth";
import { requestTerminalCommand } from "../../terminal/utils/terminalCommandRequestEvent";
import { loadSettingsStyles } from "../../../styles/featureStyleLoaders";
import { useFeatureStylesReady } from "../../../styles/useFeatureStylesReady";
import { DeleteConfirmDialog } from "./DeleteConfirmDialog";
import { CliIcon } from "./cliEngineNav";
import { QODER_GLOBAL_PROVIDER_PROFILE_ID } from "../../threads/constants/codexProviderProfiles";

function quoteTerminalArg(value: string): string {
  // requestTerminalCommand runs through the user's shell. Keep plain CLI paths
  // readable, but quote every other value with POSIX-safe single quotes. Keep
  // an explicit home-prefix expandable so the terminal command matches Rust's
  // configured config-root normalization.
  if (value === "~") {
    return "$HOME";
  }
  if (value.startsWith("~/")) {
    return `$HOME/${quoteTerminalArg(value.slice(2))}`;
  }
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

type QoderAuthSectionProps = {
  qoderBin?: string | null;
  configDir?: string | null;
  providerProfileId?: string;
  cliName?: string;
};

export function QoderAuthSection({
  qoderBin,
  configDir,
  providerProfileId = QODER_GLOBAL_PROVIDER_PROFILE_ID,
  cliName = "qodercli",
}: QoderAuthSectionProps) {
  useFeatureStylesReady(loadSettingsStyles);
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<QoderAuthStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftKey, setDraftKey] = useState("");
  const [draftVisible, setDraftVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isGlobal = providerProfileId === QODER_GLOBAL_PROVIDER_PROFILE_ID;
  const authFileName = isGlobal ? "qoder-auth.json" : "qoder-cn-auth.json";
  const defaultAuthFilePath = `~/.ccgui/${authFileName}`;

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await qoderAuthStatus(providerProfileId));
      setLoadError(null);
    } catch (error) {
      setLoadError(String(error));
    }
  }, [providerProfileId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const closeEditor = useCallback(() => {
    setEditing(false);
    setDraftKey("");
    setDraftVisible(false);
    setActionError(null);
  }, []);

  const openEditor = useCallback(() => {
    if (editing) {
      closeEditor();
      return;
    }
    setEditing(true);
    setDraftKey("");
    setDraftVisible(false);
    setActionError(null);
  }, [editing, closeEditor]);

  const handleLaunchLogin = useCallback(() => {
    const customBin = qoderBin?.trim();
    const command = customBin ? quoteTerminalArg(customBin) : cliName;
    const configuredDirectory = configDir?.trim();
    requestTerminalCommand({
      terminalId:
        isGlobal ? "qoder-login" : "qoder-cn-login",
      title: `${cliName} login`,
      command: [
        command,
        configuredDirectory
          ? `--config-dir ${quoteTerminalArg(configuredDirectory)}`
          : null,
        "login",
      ]
        .filter(Boolean)
        .join(" "),
    });
  }, [cliName, configDir, isGlobal, qoderBin]);

  const handleSave = useCallback(async () => {
    const key = draftKey.trim();
    if (!key) {
      closeEditor();
      return;
    }
    setSaving(true);
    setActionError(null);
    try {
      await qoderAuthSetPat(key, providerProfileId);
      closeEditor();
      await refresh();
    } catch (error) {
      setActionError(String(error));
    } finally {
      setSaving(false);
    }
  }, [draftKey, closeEditor, providerProfileId, refresh]);

  const handleDelete = useCallback(async () => {
    try {
      await qoderAuthDeletePat(providerProfileId);
      setConfirmDelete(false);
      await refresh();
    } catch (error) {
      setConfirmDelete(false);
      setActionError(String(error));
    }
  }, [providerProfileId, refresh]);

  const state = snapshot?.state ?? "none";
  const envVar = snapshot?.envVar ?? "QODER_PERSONAL_ACCESS_TOKEN";

  const renderState = () => {
    if (state === "configured") {
      return (
        <span className="pi-auth-status pi-auth-status-ok">
          <span className="pi-auth-dot" aria-hidden />
          {t("settings.vendor.qoderAuth.configured", { defaultValue: "已配置" })}
        </span>
      );
    }
    if (state === "env") {
      return (
        <span
          className="pi-auth-status pi-auth-status-env"
          title={t("settings.vendor.qoderAuth.envActiveHint", {
            cliName,
            defaultValue:
              `环境变量生效中（mossx 启动 ${cliName} 时继承）。如需覆盖，请设置 PAT。`,
          })}
        >
          <span className="pi-auth-dot" aria-hidden />
          {t("settings.vendor.qoderAuth.envActive", {
            defaultValue: "环境变量生效中",
          })}
        </span>
      );
    }
    return (
      <span className="pi-auth-status pi-auth-status-idle">
        <span className="pi-auth-dot" aria-hidden />
        {t("settings.vendor.qoderAuth.notConfigured", { defaultValue: "未配置" })}
      </span>
    );
  };

  return (
    <div className="pi-auth-section">
      <div className="pi-auth-subhead">
        <span className="pi-auth-subhead-title">
          {t("settings.vendor.qoderAuth.loginTitle", { defaultValue: "浏览器登录" })}
        </span>
        <span className="pi-auth-subhead-hint">
          {t("settings.vendor.qoderAuth.loginHint", {
            cliName,
            defaultValue: `在内嵌终端运行 ${cliName} login，完成浏览器授权`,
          })}
        </span>
      </div>
      <div className="vendor-group-card">
        <div className="pi-auth-row">
          <span className="pi-auth-brand-icon">
            <CliIcon id="qoder" label="Qoder" monochrome />
          </span>
          <div className="pi-auth-row-copy">
            <div className="pi-auth-row-name">{cliName}</div>
            <div className="pi-auth-row-desc">
              {t("settings.vendor.qoderAuth.loginDesc", {
                cliName,
                defaultValue: `账号登录 · 浏览器授权后由 ${cliName} 自管 token`,
              })}
            </div>
          </div>
          <div className="pi-auth-row-right">
            <button
              type="button"
              className="vendor-btn-cancel pi-auth-login-btn"
              onClick={handleLaunchLogin}
            >
              <LogIn size={13} aria-hidden />
              {t("settings.vendor.qoderAuth.login", { defaultValue: "登录" })}
            </button>
          </div>
        </div>
      </div>

      <div className="pi-auth-subhead">
        <span className="pi-auth-subhead-title">
          {t("settings.vendor.qoderAuth.apiKeyTitle", { defaultValue: "PAT" })}
        </span>
        <span className="pi-auth-subhead-hint">
          {t("settings.vendor.qoderAuth.apiKeyHint", {
            authFile: defaultAuthFilePath,
            envVar,
            defaultValue: `写入 ${defaultAuthFilePath}，启动时注入 ${envVar}`,
          })}
        </span>
      </div>
      <div className="vendor-group-card">
        {loadError ? (
          <div className="pi-auth-row pi-auth-row-message" role="alert">
            {t("settings.vendor.qoderAuth.loadFailed", {
              defaultValue: "读取认证状态失败",
            })}
            ：{loadError}
          </div>
        ) : null}
        <div className={`pi-auth-provider${editing ? " pi-auth-row-expanded" : ""}`}>
          <div className={`pi-auth-row${editing ? " pi-auth-row-expanded" : ""}`}>
            <span className="pi-auth-brand-icon">
              <CliIcon id="qoder" label="Qoder" monochrome />
            </span>
            <div className="pi-auth-row-copy">
              <div className="pi-auth-row-name">Qoder PAT</div>
              <div className="pi-auth-row-desc">
                <code className="pi-auth-env-chip">{envVar}</code>
              </div>
            </div>
            <div className="pi-auth-row-right">
              {renderState()}
              {state === "configured" && snapshot?.maskedKey ? (
                <code className="pi-auth-mask-chip">{snapshot.maskedKey}</code>
              ) : null}
              {state === "configured" ? (
                <>
                  <button
                    type="button"
                    className="vendor-btn-icon pi-auth-text-btn"
                    onClick={openEditor}
                  >
                    {editing
                      ? t("settings.vendor.qoderAuth.collapse", { defaultValue: "收起" })
                      : t("settings.vendor.qoderAuth.edit", { defaultValue: "编辑" })}
                  </button>
                  <button
                    type="button"
                    className="vendor-btn-icon pi-auth-text-btn pi-auth-text-btn-danger"
                    onClick={() => setConfirmDelete(true)}
                  >
                    {t("settings.vendor.qoderAuth.delete", { defaultValue: "删除" })}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="vendor-btn-cancel pi-auth-login-btn"
                  onClick={openEditor}
                >
                  {editing
                    ? t("settings.vendor.qoderAuth.collapse", { defaultValue: "收起" })
                    : state === "env"
                      ? t("settings.vendor.qoderAuth.overrideSet", {
                          defaultValue: "覆盖设置",
                        })
                      : t("settings.vendor.qoderAuth.setKey", {
                          defaultValue: "设置 Key",
                        })}
                </button>
              )}
            </div>
          </div>
          {editing ? (
            <div className="pi-auth-editor" data-testid="qoder-auth-editor">
              <label className="pi-auth-editor-label" htmlFor="qoder-auth-pat">
                {t("settings.vendor.qoderAuth.keyLabel", {
                  defaultValue: "Personal Access Token",
                })}
              </label>
              <div className="pi-auth-editor-input-row">
                <div className="pi-auth-editor-input-box">
                  <input
                    id="qoder-auth-pat"
                    type={draftVisible ? "text" : "password"}
                    value={draftKey}
                    autoFocus
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setDraftKey(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        void handleSave();
                      } else if (event.key === "Escape") {
                        closeEditor();
                      }
                    }}
                    placeholder={
                      state === "configured"
                        ? t("settings.vendor.qoderAuth.keyPlaceholderKeep", {
                            mask: snapshot?.maskedKey ?? "",
                            defaultValue: `${snapshot?.maskedKey ?? ""}（留空保持不变）`,
                          })
                        : t("settings.vendor.qoderAuth.keyPlaceholderNew", {
                            env: envVar,
                            defaultValue: `粘贴 ${envVar}`,
                          })
                    }
                  />
                  <button
                    type="button"
                    className="vendor-btn-icon pi-auth-eye"
                    onClick={() => setDraftVisible((visible) => !visible)}
                    title={t("settings.vendor.qoderAuth.toggleKeyVisibility", {
                      defaultValue: "显示 / 隐藏",
                    })}
                  >
                    {draftVisible ? (
                      <EyeOff size={14} aria-hidden />
                    ) : (
                      <Eye size={14} aria-hidden />
                    )}
                  </button>
                </div>
              </div>
              {actionError ? (
                <p className="pi-auth-editor-error" role="alert">
                  {actionError}
                </p>
              ) : null}
              <div className="pi-auth-editor-actions">
                <button
                  type="button"
                  className="vendor-btn-danger-solid pi-auth-save"
                  disabled={saving}
                  onClick={() => void handleSave()}
                >
                  {saving
                    ? t("settings.vendor.qoderAuth.saving", { defaultValue: "保存中…" })
                    : t("settings.vendor.qoderAuth.save", { defaultValue: "保存" })}
                </button>
                <button type="button" className="vendor-btn-cancel" onClick={closeEditor}>
                  {t("settings.vendor.cancel", { defaultValue: "取消" })}
                </button>
                <span className="pi-auth-save-hint">
                  {t("settings.vendor.qoderAuth.saveHint", {
                    authFile: defaultAuthFilePath,
                    cliName,
                    defaultValue: `保存后写入 ${defaultAuthFilePath}（0600），启动 ${cliName} 时注入`,
                  })}
                </span>
              </div>
            </div>
          ) : null}
        </div>
        <div className="pi-auth-foot">
          <code>{snapshot?.authFile.path ?? defaultAuthFilePath}</code>
          <span className="pi-auth-perm-badge">0600</span>
          <span className="pi-auth-foot-spacer" />
          <span className="pi-auth-foot-prio">
            {t("settings.vendor.qoderAuth.resolutionOrder", {
              authFile: authFileName,
              cliName,
              defaultValue: `解析顺序：进程环境变量 → ${authFileName} → ${cliName} login`,
            })}
          </span>
        </div>
      </div>

      <DeleteConfirmDialog
        isOpen={confirmDelete}
        providerName="Qoder PAT"
        onConfirm={() => void handleDelete()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
