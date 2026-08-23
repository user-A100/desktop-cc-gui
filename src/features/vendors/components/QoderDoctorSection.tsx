import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import Stethoscope from "lucide-react/dist/esm/icons/stethoscope";

import { runQoderDoctor } from "../../../services/tauri";
import type { CodexDoctorResult } from "../../../types";

type QoderDoctorSectionProps = {
  qoderBin?: string | null;
  providerProfileId: string;
  cliName: string;
};

/** Distribution-scoped diagnostic. It intentionally runs only on explicit click. */
export function QoderDoctorSection({
  qoderBin,
  providerProfileId,
  cliName,
}: QoderDoctorSectionProps) {
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CodexDoctorResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runDoctor = useCallback(async () => {
    setRunning(true);
    try {
      setResult(await runQoderDoctor(qoderBin ?? null, providerProfileId));
      setError(null);
    } catch (error) {
      setResult(null);
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  }, [providerProfileId, qoderBin]);

  const detail = result?.details?.trim();
  return (
    <div className="vendor-group-row">
      <div className="vendor-group-row-copy">
        <span className="vendor-group-row-title">Doctor</span>
        <span className="settings-help">
          {result
            ? result.ok
              ? t("settings.qoderLooksGood", {
                  defaultValue: `${cliName}、认证与 ACP handshake 正常。`,
                })
              : detail ||
                t("settings.qoderIssueDetected", {
                  defaultValue: `${cliName} 需要检查安装、认证或 ACP handshake。`,
                })
            : error ||
              t("settings.qoderDoctorIdle", {
                defaultValue: "按需检测当前发行版，不会切换或影响另一张卡。",
              })}
        </span>
      </div>
      <button
        type="button"
        className="vendor-btn-cancel"
        onClick={() => void runDoctor()}
        disabled={running}
      >
        <Stethoscope size={13} aria-hidden />
        {running
          ? t("settings.running", { defaultValue: "检测中" })
          : t("settings.runQoderDoctor", { defaultValue: "运行 Doctor" })}
      </button>
    </div>
  );
}
