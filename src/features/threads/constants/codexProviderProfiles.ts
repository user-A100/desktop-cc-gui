export const CODEX_DISK_PROVIDER_PROFILE_ID = "__disk__";
/** 本地/磁盘默认渠道的统一展示名（对用户隐藏底层文件名） */
export const LOCAL_PROVIDER_PROFILE_DISPLAY_NAME = "本地配置";
export const CODEX_DISK_PROVIDER_PROFILE_NAME = LOCAL_PROVIDER_PROFILE_DISPLAY_NAME;
export const CLAUDE_LOCAL_PROVIDER_PROFILE_ID = "__local_settings_json__";
export const CLAUDE_LOCAL_PROVIDER_PROFILE_NAME = LOCAL_PROVIDER_PROFILE_DISPLAY_NAME;
export const KIMI_LOCAL_PROVIDER_PROFILE_ID = "__local_config_toml__";
export const KIMI_LOCAL_PROVIDER_PROFILE_NAME = LOCAL_PROVIDER_PROFILE_DISPLAY_NAME;
export const GROK_LOCAL_PROVIDER_PROFILE_ID = "__local_config_toml__";
export const GROK_LOCAL_PROVIDER_PROFILE_NAME = LOCAL_PROVIDER_PROFILE_DISPLAY_NAME;
export const OPENCODE_LOCAL_PROVIDER_PROFILE_ID = "__local_opencode_json__";
export const OPENCODE_LOCAL_PROVIDER_PROFILE_NAME = LOCAL_PROVIDER_PROFILE_DISPLAY_NAME;
export const PI_LOCAL_PROVIDER_PROFILE_ID = "__local_pi__";
export const PI_LOCAL_PROVIDER_PROFILE_NAME = LOCAL_PROVIDER_PROFILE_DISPLAY_NAME;
/** DSH has no mossx provider profiles; this id is a synthetic local host slot. */
export const DSH_LOCAL_PROVIDER_PROFILE_ID = "__dsh_host_catalog__";
export const DSH_LOCAL_PROVIDER_PROFILE_NAME = LOCAL_PROVIDER_PROFILE_DISPLAY_NAME;
/** Historic Qoder local sentinel. Existing sessions resolve to Qoder Global. */
export const QODER_LOCAL_PROVIDER_PROFILE_ID = "__local_qoder__";
export const QODER_LOCAL_PROVIDER_PROFILE_NAME = LOCAL_PROVIDER_PROFILE_DISPLAY_NAME;
/** Fixed distribution bindings; unlike ordinary native local profiles, these
 * must survive model/session selection to keep Global and CN isolated. */
export const QODER_GLOBAL_PROVIDER_PROFILE_ID = "__qoder_global__";
export const QODER_GLOBAL_PROVIDER_PROFILE_NAME = "Qoder Global";
export const QODER_CN_PROVIDER_PROFILE_ID = "__qoder_cn__";
export const QODER_CN_PROVIDER_PROFILE_NAME = "Qoder CN";

export type EngineProviderProfileOption = {
  id: string;
  name: string;
  source: "disk" | "managed";
  availability?: "available" | "unavailable";
};

export type EngineProviderProfileSelection = {
  providerProfileId?: string | null;
  providerProfile?: EngineProviderProfileOption | null;
};

export type CodexProviderProfileOption = EngineProviderProfileOption;
export type CodexProviderProfileSelection = EngineProviderProfileSelection;
