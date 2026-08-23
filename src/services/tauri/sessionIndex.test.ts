import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  isLocalPendingDraftSessionId,
  scheduleTombstoneLocalPendingDraftIndexRow,
  writeClientCreatedSessionIndex,
} from "./sessionIndex";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

async function flushIndexWrite(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("sessionIndex pending drafts", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(1);
  });

  it("recognizes local pending session ids and rejects short aliases", () => {
    expect(
      isLocalPendingDraftSessionId("claude-pending-1787016153035-0bittx"),
    ).toBe(true);
    expect(
      isLocalPendingDraftSessionId("codex-pending-1786994371985-fv4mt5"),
    ).toBe(true);
    expect(isLocalPendingDraftSessionId("claude-pending-1")).toBe(false);
    expect(
      isLocalPendingDraftSessionId("claude-pending-subagent:parent:tool"),
    ).toBe(false);
  });

  it("does not upsert a pending client draft into Session Index", async () => {
    writeClientCreatedSessionIndex({
      engine: "claude",
      sessionId: "claude:claude-pending-1787016153035-0bittx",
      workspacePath: "/tmp/ws",
      title: "claude session",
    });
    await flushIndexWrite();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("still upserts a real native session id", async () => {
    writeClientCreatedSessionIndex({
      engine: "claude",
      sessionId: "claude:session-real-1",
      workspacePath: "/tmp/ws",
      title: "帮我看一下这段代码",
    });
    await flushIndexWrite();
    expect(invoke).toHaveBeenCalledWith("upsert_session_index_rows", {
      rows: [
        expect.objectContaining({
          engine: "claude",
          sessionId: "session-real-1",
          title: "帮我看一下这段代码",
          workspacePath: "/tmp/ws",
          cwd: "/tmp/ws",
        }),
      ],
    });
  });

  it("keeps a canonical Qoder id intact for Rust-side profile validation", async () => {
    writeClientCreatedSessionIndex({
      engine: "qoder",
      sessionId: "qoder:__qoder_cn__:same-raw-session",
      workspacePath: "/tmp/ws",
      providerProfileId: "__qoder_cn__",
    });
    await flushIndexWrite();

    expect(invoke).toHaveBeenCalledWith("upsert_session_index_rows", {
      rows: [
        expect.objectContaining({
          engine: "qoder",
          sessionId: "qoder:__qoder_cn__:same-raw-session",
          providerProfileId: "__qoder_cn__",
        }),
      ],
    });
  });

  it("tombstones a remapped pending Index row and ignores non-pending ids", async () => {
    scheduleTombstoneLocalPendingDraftIndexRow(
      "claude:claude-pending-1787016153035-0bittx",
    );
    scheduleTombstoneLocalPendingDraftIndexRow("claude-pending-1");
    scheduleTombstoneLocalPendingDraftIndexRow("claude:session-real-1");
    await flushIndexWrite();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("tombstone_session_index_rows", {
      sessionIds: ["claude-pending-1787016153035-0bittx"],
    });
  });
});
