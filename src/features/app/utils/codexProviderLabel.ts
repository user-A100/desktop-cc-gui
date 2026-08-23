import type { ThreadSummary } from "../../../types";
import {
  CLAUDE_LOCAL_PROVIDER_PROFILE_ID,
  CODEX_DISK_PROVIDER_PROFILE_ID,
  DSH_LOCAL_PROVIDER_PROFILE_ID,
  GROK_LOCAL_PROVIDER_PROFILE_ID,
  KIMI_LOCAL_PROVIDER_PROFILE_ID,
  OPENCODE_LOCAL_PROVIDER_PROFILE_ID,
  PI_LOCAL_PROVIDER_PROFILE_ID,
  QODER_LOCAL_PROVIDER_PROFILE_ID,
} from "../../threads/constants/codexProviderProfiles";

const LABELABLE_ENGINES = new Set([
  "claude",
  "codex",
  "grok",
  "kimi",
  "opencode",
  "pi",
  "dsh",
  "qoder",
  "gemini",
]);

const LOCAL_PROVIDER_PROFILE_IDS = new Set([
  CLAUDE_LOCAL_PROVIDER_PROFILE_ID,
  CODEX_DISK_PROVIDER_PROFILE_ID,
  KIMI_LOCAL_PROVIDER_PROFILE_ID,
  GROK_LOCAL_PROVIDER_PROFILE_ID,
  OPENCODE_LOCAL_PROVIDER_PROFILE_ID,
  PI_LOCAL_PROVIDER_PROFILE_ID,
  DSH_LOCAL_PROVIDER_PROFILE_ID,
  QODER_LOCAL_PROVIDER_PROFILE_ID,
]);

export function resolveEngineProviderLabel(thread: ThreadSummary) {
  const engine = thread.engineSource ?? "codex";
  if (!LABELABLE_ENGINES.has(engine)) {
    return null;
  }

  const profileId = thread.providerProfileId?.trim() ?? "";
  if (LOCAL_PROVIDER_PROFILE_IDS.has(profileId)) {
    return "local";
  }
  const label =
    thread.providerProfileName?.trim() ||
    (engine === "codex" ? thread.sourceLabel?.trim() : "") ||
    profileId;
  if (label) {
    return label;
  }
  // PI / DSH / Grok / Kimi / OpenCode 曾把本地 sentinel 剥掉，侧栏会空。
  // 没有 binding 的这些引擎按官方本地配置显示。
  if (
    engine === "pi" ||
    engine === "dsh" ||
    engine === "grok" ||
    engine === "kimi" ||
    engine === "opencode"
  ) {
    return "local";
  }
  if (engine === "qoder") {
    return "Qoder Global";
  }
  return null;
}

export const resolveCodexProviderLabel = resolveEngineProviderLabel;
