import { invoke } from "@tauri-apps/api/core";
import type { CodexDoctorResult, CodexLaunchProfilePreview } from "../../types";

export type PreviewCodexLaunchProfileRequest = {
  codexBin: string | null;
  codexArgs: string | null;
  workspaceId?: string | null;
  useWorkspaceDraft?: boolean;
};

export async function runCodexDoctor(
  codexBin: string | null,
  codexArgs: string | null,
): Promise<CodexDoctorResult> {
  return invoke<CodexDoctorResult>("codex_doctor", { codexBin, codexArgs });
}

export async function runClaudeDoctor(
  claudeBin: string | null,
): Promise<CodexDoctorResult> {
  return invoke<CodexDoctorResult>("claude_doctor", { claudeBin });
}

export async function runKimiDoctor(
  kimiBin: string | null,
): Promise<CodexDoctorResult> {
  return invoke<CodexDoctorResult>("kimi_doctor", { kimiBin });
}

export async function runGrokDoctor(
  grokBin: string | null,
): Promise<CodexDoctorResult> {
  return invoke<CodexDoctorResult>("grok_doctor", { grokBin });
}

export async function runOpenCodeDoctor(
  opencodeBin: string | null,
): Promise<CodexDoctorResult> {
  return invoke<CodexDoctorResult>("opencode_doctor", { opencodeBin });
}

export async function runPiDoctor(
  piBin: string | null,
): Promise<CodexDoctorResult> {
  return invoke<CodexDoctorResult>("pi_doctor", { piBin });
}

export async function runDshDoctor(
  dshBin: string | null,
): Promise<CodexDoctorResult> {
  return invoke<CodexDoctorResult>("dsh_doctor", { dshBin });
}

export async function runQoderDoctor(
  qoderBin: string | null,
  providerProfileId?: string | null,
): Promise<CodexDoctorResult> {
  return invoke<CodexDoctorResult>("qoder_doctor", {
    qoderBin,
    providerProfileId: providerProfileId ?? null,
  });
}

export async function previewCodexLaunchProfile({
  codexBin,
  codexArgs,
  workspaceId = null,
  useWorkspaceDraft = false,
}: PreviewCodexLaunchProfileRequest): Promise<CodexLaunchProfilePreview> {
  return invoke<CodexLaunchProfilePreview>("codex_preview_launch_profile", {
    codexBin,
    codexArgs,
    workspaceId,
    useWorkspaceDraft,
  });
}
