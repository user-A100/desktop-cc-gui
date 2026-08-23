import { describe, expect, it } from "vitest";

import {
  collectSharedHideIdentityKeys,
  extractCodexCanonicalSessionId,
  hasKnownSharedEnginePrefix,
  isPosixAbsolutePathId,
  isSharedHideFilesystemPathId,
  isWindowsDrivePathId,
  isWindowsUncOrExtendedPathId,
  sharedHideIdentityIntersects,
  stripKnownSharedEnginePrefix,
} from "./sharedHideIdentity";

const CANONICAL_UUID = "b7e2c1a0-4d3f-4a21-9c8e-1f2a3b4c5d6e";
const ROLLOUT_STEM = `rollout-2026-04-10T10-00-00-${CANONICAL_UUID}`;

describe("sharedHideIdentity", () => {
  describe("Windows path ids", () => {
    it("treats drive-letter and UNC / extended paths as filesystem ids", () => {
      expect(isWindowsDrivePathId("S:\\AIWorker\\proj")).toBe(true);
      expect(isWindowsDrivePathId("S:/AIWorker/proj")).toBe(true);
      expect(isWindowsDrivePathId("c:\\Users\\me")).toBe(true);
      expect(isWindowsDrivePathId("S:relative")).toBe(false);
      expect(isWindowsDrivePathId("codex:session")).toBe(false);

      expect(isWindowsUncOrExtendedPathId("\\\\server\\share\\proj")).toBe(true);
      expect(isWindowsUncOrExtendedPathId("\\\\?\\C:\\AIWorker\\proj")).toBe(true);
      expect(isWindowsUncOrExtendedPathId("//?/C:/AIWorker/proj")).toBe(true);
      expect(isWindowsUncOrExtendedPathId("//server/share/proj")).toBe(true);
      expect(isWindowsUncOrExtendedPathId("codex:session")).toBe(false);

      expect(isSharedHideFilesystemPathId("S:\\AIWorker\\proj")).toBe(true);
      expect(isSharedHideFilesystemPathId("\\\\?\\C:\\AIWorker\\proj")).toBe(true);
    });

    it("does not strip a drive letter as an engine prefix", () => {
      expect(stripKnownSharedEnginePrefix("S:\\AIWorker\\proj")).toBe(
        "S:\\AIWorker\\proj",
      );
      expect(hasKnownSharedEnginePrefix("S:\\AIWorker\\proj")).toBe(false);
      expect(extractCodexCanonicalSessionId("S:\\AIWorker\\proj")).toBeNull();
      expect(collectSharedHideIdentityKeys("S:\\AIWorker\\proj")).toEqual([
        "S:\\AIWorker\\proj",
      ]);
      expect(collectSharedHideIdentityKeys("\\\\server\\share\\proj")).toEqual([
        "\\\\server\\share\\proj",
      ]);
    });
  });

  describe("macOS / Linux path ids", () => {
    it("treats POSIX absolute paths as filesystem ids", () => {
      expect(isPosixAbsolutePathId("/Users/me/proj")).toBe(true);
      expect(isPosixAbsolutePathId("/home/me/proj")).toBe(true);
      expect(isPosixAbsolutePathId("/var/folders/xx/tmp")).toBe(true);
      expect(isPosixAbsolutePathId("https://example.com/x")).toBe(false);
      expect(isPosixAbsolutePathId("codex:session")).toBe(false);

      expect(isSharedHideFilesystemPathId("/Users/me/proj")).toBe(true);
      expect(isSharedHideFilesystemPathId("/home/me/proj")).toBe(true);
    });

    it("does not invent engine-prefixed hide keys for POSIX paths", () => {
      expect(collectSharedHideIdentityKeys("/Users/me/proj")).toEqual([
        "/Users/me/proj",
      ]);
      expect(collectSharedHideIdentityKeys("/home/me/proj")).toEqual([
        "/home/me/proj",
      ]);
      expect(extractCodexCanonicalSessionId("/Users/me/proj")).toBeNull();
      expect(extractCodexCanonicalSessionId("/home/me/proj")).toBeNull();
    });
  });

  describe("Codex uuid ↔ rollout stem", () => {
    it("extracts the same canonical uuid from raw, prefixed, and stem forms", () => {
      expect(extractCodexCanonicalSessionId(CANONICAL_UUID)).toBe(CANONICAL_UUID);
      expect(extractCodexCanonicalSessionId(`codex:${CANONICAL_UUID}`)).toBe(
        CANONICAL_UUID,
      );
      expect(extractCodexCanonicalSessionId(ROLLOUT_STEM)).toBe(CANONICAL_UUID);
      expect(extractCodexCanonicalSessionId(`codex:${ROLLOUT_STEM}`)).toBe(
        CANONICAL_UUID,
      );
      expect(
        extractCodexCanonicalSessionId("rollout-2026-04-10T10-00-00-session-alpha"),
      ).toBeNull();
    });

    it("intersects hide keys across uuid and rollout stem without inventing timestamps", () => {
      const fromUuid = new Set(collectSharedHideIdentityKeys(`codex:${CANONICAL_UUID}`));
      expect(fromUuid.has(CANONICAL_UUID)).toBe(true);
      expect(fromUuid.has(`codex:${CANONICAL_UUID}`)).toBe(true);
      expect([...fromUuid].some((key) => key.startsWith("rollout-"))).toBe(false);

      expect(sharedHideIdentityIntersects(ROLLOUT_STEM, fromUuid)).toBe(true);
      expect(sharedHideIdentityIntersects(`codex:${ROLLOUT_STEM}`, fromUuid)).toBe(
        true,
      );
      expect(
        sharedHideIdentityIntersects(
          "rollout-2026-04-10T10-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          fromUuid,
        ),
      ).toBe(false);

      const fromStem = new Set(collectSharedHideIdentityKeys(ROLLOUT_STEM));
      expect(fromStem.has(ROLLOUT_STEM)).toBe(true);
      expect(fromStem.has(CANONICAL_UUID)).toBe(true);
      expect(sharedHideIdentityIntersects(`codex:${CANONICAL_UUID}`, fromStem)).toBe(
        true,
      );
    });

    it("uses the same identity rule regardless of host platform", () => {
      const hide = new Set(collectSharedHideIdentityKeys(CANONICAL_UUID));
      expect(sharedHideIdentityIntersects(ROLLOUT_STEM, hide)).toBe(true);
      expect(sharedHideIdentityIntersects(`codex:${ROLLOUT_STEM}`, hide)).toBe(true);
      expect(sharedHideIdentityIntersects(`codex:${CANONICAL_UUID}`, hide)).toBe(
        true,
      );
    });
  });

  describe("known engine prefixes", () => {
    it("strips only known engines and leaves unrelated colons alone", () => {
      expect(stripKnownSharedEnginePrefix("claude:abc")).toBe("abc");
      expect(stripKnownSharedEnginePrefix("CODEX:xyz")).toBe("xyz");
      expect(stripKnownSharedEnginePrefix("qoder:session")).toBe("session");
      expect(stripKnownSharedEnginePrefix("gemini:session")).toBe("gemini:session");
      expect(hasKnownSharedEnginePrefix("grok:session")).toBe(true);
      expect(hasKnownSharedEnginePrefix("qoder:session")).toBe(true);
      expect(hasKnownSharedEnginePrefix("gemini:session")).toBe(false);
    });
  });

  describe("Qoder distribution identity", () => {
    it("does not let canonical Global/CN ids with the same raw session collide", () => {
      const globalId = "qoder:__qoder_global__:same-raw-session";
      const cnId = "qoder:__qoder_cn__:same-raw-session";
      const globalKeys = new Set(collectSharedHideIdentityKeys(globalId));

      expect([...globalKeys]).toEqual([globalId]);
      expect(sharedHideIdentityIntersects(globalId, globalKeys)).toBe(true);
      expect(sharedHideIdentityIntersects(cnId, globalKeys)).toBe(false);
    });
  });
});
