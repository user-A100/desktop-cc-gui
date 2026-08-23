/**
 * Shared hide identity：把 binding / live / parent 的字面 id 收成可互认的键。
 *
 * Codex 在 Windows 上 live id 常为 rollout filename stem，binding 却是 canonical uuid。
 * 任意 `:` 剥离会把盘符 `S:\…` 当成 engine 前缀。本模块按平台区分路径，只剥已知 engine。
 */

import { collectQoderSessionIdentityKeys } from "../../threads/utils/qoderSessionIdentity";

export const SHARED_HIDE_ENGINE_PREFIXES = [
  "claude",
  "codex",
  "kimi",
  "grok",
  "opencode",
  "pi",
  "qoder",
] as const;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Codex 会话文件名：rollout-2026-04-10T10-00-00-{canonical} */
const CODEX_ROLLOUT_STEM_RE =
  /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)$/;

function asTrimmedId(value: string): string {
  return value.trim();
}

/** Windows 盘符绝对路径：`S:\…` / `S:/…` */
export function isWindowsDrivePathId(id: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(id);
}

/** Windows UNC / extended-length：`\\server\share`、`\\?\C:\…`、`//?/` */
export function isWindowsUncOrExtendedPathId(id: string): boolean {
  return (
    id.startsWith("\\\\") ||
    id.startsWith("//") ||
    id.startsWith("\\\\?\\") ||
    id.startsWith("//?/")
  );
}

/** macOS / Linux POSIX 绝对路径。排除 `engine:` / URL scheme。 */
export function isPosixAbsolutePathId(id: string): boolean {
  if (!id.startsWith("/")) {
    return false;
  }
  if (id.includes("://")) {
    return false;
  }
  return true;
}

/**
 * 路径形 id：禁止当 session / engine 前缀处理。
 * Windows 与 POSIX 分开识别，避免把盘符冒号或 `/Users` 补成 hide 键。
 */
export function isSharedHideFilesystemPathId(id: string): boolean {
  const trimmed = asTrimmedId(id);
  if (!trimmed) {
    return false;
  }
  return (
    isWindowsDrivePathId(trimmed) ||
    isWindowsUncOrExtendedPathId(trimmed) ||
    isPosixAbsolutePathId(trimmed)
  );
}

export function hasKnownSharedEnginePrefix(id: string): boolean {
  const trimmed = asTrimmedId(id);
  if (!trimmed || isSharedHideFilesystemPathId(trimmed)) {
    return false;
  }
  const lower = trimmed.toLowerCase();
  return SHARED_HIDE_ENGINE_PREFIXES.some((engine) =>
    lower.startsWith(`${engine}:`),
  );
}

/** 只剥已知 engine 前缀。盘符 / POSIX 路径原样返回。 */
export function stripKnownSharedEnginePrefix(id: string): string {
  const trimmed = asTrimmedId(id);
  if (!trimmed || isSharedHideFilesystemPathId(trimmed)) {
    return trimmed;
  }
  const lower = trimmed.toLowerCase();
  for (const engine of SHARED_HIDE_ENGINE_PREFIXES) {
    const prefix = `${engine}:`;
    if (lower.startsWith(prefix)) {
      return trimmed.slice(prefix.length).trim();
    }
  }
  return trimmed;
}

/**
 * 从字面 id 抽出 Codex canonical uuid（小写）。
 * 覆盖：裸 uuid、`codex:uuid`、`rollout-…-{uuid}`、`codex:rollout-…-{uuid}`。
 * 非 uuid 的 rollout suffix（如 session-alpha）返回 null。
 */
export function extractCodexCanonicalSessionId(
  id: string,
): string | null {
  const bare = stripKnownSharedEnginePrefix(id);
  if (!bare || isSharedHideFilesystemPathId(bare)) {
    return null;
  }
  if (UUID_RE.test(bare)) {
    return bare.toLowerCase();
  }
  const rollout = bare.match(CODEX_ROLLOUT_STEM_RE);
  const suffix = rollout?.[1]?.trim() ?? "";
  if (suffix && UUID_RE.test(suffix)) {
    return suffix.toLowerCase();
  }
  return null;
}

/**
 * 一条字面 id 展开成 hide / lookup 可互认的键。
 * 不发明未观测到的 rollout 时间戳。
 */
export function collectSharedHideIdentityKeys(id: string): string[] {
  const trimmed = asTrimmedId(id);
  if (!trimmed) {
    return [];
  }
  if (trimmed.toLowerCase().startsWith("qoder:")) {
    const qoderKeys = collectQoderSessionIdentityKeys(trimmed);
    if (qoderKeys.length > 0) {
      return qoderKeys;
    }
  }
  const keys = new Set<string>([trimmed]);
  if (isSharedHideFilesystemPathId(trimmed)) {
    return [...keys];
  }
  const bare = stripKnownSharedEnginePrefix(trimmed);
  if (bare) {
    keys.add(bare);
  }
  const uuid = extractCodexCanonicalSessionId(trimmed);
  if (uuid) {
    keys.add(uuid);
    keys.add(`codex:${uuid}`);
  }
  return [...keys];
}

export function sharedHideIdentityIntersects(
  candidate: string,
  hideKeys: ReadonlySet<string>,
): boolean {
  const trimmed = asTrimmedId(candidate);
  if (!trimmed || hideKeys.size === 0) {
    return false;
  }
  if (hideKeys.has(trimmed)) {
    return true;
  }
  for (const key of collectSharedHideIdentityKeys(trimmed)) {
    if (hideKeys.has(key)) {
      return true;
    }
  }
  return false;
}
