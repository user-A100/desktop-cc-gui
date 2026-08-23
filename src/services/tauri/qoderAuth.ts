import { invoke } from "@tauri-apps/api/core";

/**
 * Qoder CLI 认证（浏览器 login + mossx 托管的 PAT）。
 *
 * 安全边界：完整 PAT 永不回传前端，status 只携带 mask 后的展示串。
 */

export type QoderAuthState = "configured" | "env" | "none";

export interface QoderAuthStatus {
  distribution: "global" | "cn";
  authFile: { path: string; exists: boolean };
  state: QoderAuthState;
  maskedKey?: string;
  envVar: string;
}

export async function qoderAuthStatus(
  providerProfileId?: string | null,
): Promise<QoderAuthStatus> {
  return invoke<QoderAuthStatus>("qoder_auth_status", { providerProfileId });
}

export async function qoderAuthSetPat(
  key: string,
  providerProfileId?: string | null,
): Promise<void> {
  return invoke<void>("qoder_auth_set_pat", { key, providerProfileId });
}

export async function qoderAuthDeletePat(
  providerProfileId?: string | null,
): Promise<void> {
  return invoke<void>("qoder_auth_delete_pat", { providerProfileId });
}
