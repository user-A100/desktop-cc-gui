import { describe, expect, it } from "vitest";
import type { SessionIndexRow } from "../../../services/tauri";
import type { ThreadSummary } from "../../../types";
import {
  buildNativeIndexEarlyPaintSummaries,
  projectNativeIndexRowsToSummaries,
  selectNativeSessionIndexRows,
  shouldDeferNativeIndexRowUntilHideReady,
  shouldRememberHideUnreadiness,
} from "./useThreadActions.nativeIndexProjection";

function indexRow(
  engine: SessionIndexRow["engine"],
  sessionId: string,
): SessionIndexRow {
  return {
    engine,
    sessionId,
    title: sessionId,
    updatedAt: 100,
  };
}

describe("native Session Index projection", () => {
  it("hide unreadiness keeps every native engine, not PI only", () => {
    const rows = [
      indexRow("claude", "claude-1"),
      indexRow("grok", "grok-1"),
      indexRow("pi", "pi-1"),
      indexRow("qoder", "qoder-1"),
      indexRow("dsh", "dsh-1"),
    ];
    expect(shouldRememberHideUnreadiness(false)).toBe(true);
    const projected = projectNativeIndexRowsToSummaries(
      selectNativeSessionIndexRows(rows),
      {
        workspaceId: "ws-1",
        mappedTitles: {},
        getCustomName: () => undefined,
        hiddenSharedBindingIds: new Set(),
      },
    );
    const engines = projected.map((row) => row.engineSource);
    expect(engines).toEqual(
      expect.arrayContaining(["claude", "grok", "pi", "qoder", "dsh"]),
    );
    expect(engines).not.toEqual(["pi"]);
  });

  it("first-paint keeps newer last-good C when Index only has A,B", () => {
    const painted = buildNativeIndexEarlyPaintSummaries({
      rows: [
        { ...indexRow("claude", "a"), updatedAt: 10 },
        { ...indexRow("claude", "b"), updatedAt: 11 },
      ],
      workspaceId: "ws-1",
      getCustomName: () => undefined,
      hideSet: new Set(),
      currentThreads: undefined,
      lastGood: [
        {
          id: "claude:c",
          name: "C",
          createdAt: 20,
          updatedAt: 20,
          engineSource: "claude",
        } as ThreadSummary,
      ],
    });
    expect(painted.map((row) => row.id).sort()).toEqual([
      "claude:a",
      "claude:b",
      "claude:c",
    ]);
  });

  it("first-paint does not resurrect empty Claude Session or MOSSX last-good rows", () => {
    const painted = buildNativeIndexEarlyPaintSummaries({
      rows: [
        {
          engine: "claude",
          sessionId: "user-1",
          title: "分析左侧栏消失问题",
          updatedAt: 30,
        },
      ],
      workspaceId: "ws-1",
      getCustomName: () => undefined,
      hideSet: new Set(),
      currentThreads: undefined,
      lastGood: [
        {
          id: "claude:empty-uuid",
          name: "Claude Session",
          createdAt: 40,
          updatedAt: 40,
          engineSource: "claude",
        } as ThreadSummary,
        {
          id: "claude:mossx-1",
          name: "MOSSX_CONTEXT_PACKAGE:sha25…",
          createdAt: 39,
          updatedAt: 39,
          engineSource: "claude",
        } as ThreadSummary,
        {
          id: "claude:c",
          name: "C",
          createdAt: 20,
          updatedAt: 20,
          engineSource: "claude",
        } as ThreadSummary,
      ],
    });
    expect(painted.map((row) => row.id).sort()).toEqual([
      "claude:c",
      "claude:user-1",
    ]);
  });

  it("first-paint drops protocol-owned Claude rows even if history title is 继续", () => {
    const fileUuid = "1807f883-011c-46bd-94d5-ff483ffb1a4a";
    const painted = buildNativeIndexEarlyPaintSummaries({
      rows: [
        {
          engine: "claude",
          sessionId: fileUuid,
          title: "MOSSX_CONTEXT_PACKAGE:sha256:dead…",
          updatedAt: 50,
        },
        {
          engine: "claude",
          sessionId: "user-keep",
          title: "修订 readme",
          updatedAt: 40,
        },
      ],
      workspaceId: "ws-1",
      getCustomName: () => undefined,
      hideSet: new Set([fileUuid, `claude:${fileUuid}`]),
      currentThreads: undefined,
      lastGood: [
        {
          id: `claude:${fileUuid}`,
          name: "继续",
          createdAt: 50,
          updatedAt: 50,
          engineSource: "claude",
        } as ThreadSummary,
      ],
    });
    expect(painted.map((row) => row.id)).toEqual(["claude:user-keep"]);
  });

  it("first-paint does not resurrect empty DSH Session last-good rows", () => {
    const painted = buildNativeIndexEarlyPaintSummaries({
      rows: [
        {
          engine: "dsh",
          sessionId: "user-1",
          title: "帮我看一下这段代码",
          updatedAt: 30,
        },
      ],
      workspaceId: "ws-1",
      getCustomName: () => undefined,
      hideSet: new Set(),
      currentThreads: undefined,
      lastGood: [
        {
          id: "dsh:empty-dsh",
          name: "dsh session",
          createdAt: 40,
          updatedAt: 40,
          engineSource: "dsh",
        } as ThreadSummary,
        {
          id: "dsh:pending",
          name: "DeepSeek Harness Session",
          createdAt: 39,
          updatedAt: 39,
          engineSource: "dsh",
        } as ThreadSummary,
        {
          id: "dsh:keep",
          name: "已有真实标题",
          createdAt: 20,
          updatedAt: 20,
          engineSource: "dsh",
        } as ThreadSummary,
      ],
    });
    expect(painted.map((row) => row.id).sort()).toEqual([
      "dsh:keep",
      "dsh:user-1",
    ]);
  });

  it("first-paint does not resurrect empty Codex Session last-good rows", () => {
    const painted = buildNativeIndexEarlyPaintSummaries({
      rows: [
        {
          engine: "codex",
          sessionId: "user-1",
          title: "分析左侧栏消失问题",
          updatedAt: 30,
        },
      ],
      workspaceId: "ws-1",
      getCustomName: () => undefined,
      hideSet: new Set(),
      currentThreads: undefined,
      lastGood: [
        {
          id: "empty-uuid",
          name: "Codex Session",
          createdAt: 40,
          updatedAt: 40,
          engineSource: "codex",
        } as ThreadSummary,
        {
          id: "helper-1",
          name: "You are generating OpenSpec project context.",
          createdAt: 39,
          updatedAt: 39,
          engineSource: "codex",
        } as ThreadSummary,
        {
          id: "nick-1",
          name: "Aristotle",
          createdAt: 20,
          updatedAt: 20,
          engineSource: "codex",
        } as ThreadSummary,
      ],
    });
    expect(painted.map((row) => row.id).sort()).toEqual(["nick-1", "user-1"]);
  });

  it("unreadiness defers new grok/pi/qoder rows but keeps last-good and claude", () => {
    const lastGoodGrok = {
      id: "grok:keep",
      name: "已有 Grok",
      createdAt: 20,
      updatedAt: 20,
      engineSource: "grok",
    } as ThreadSummary;
    const painted = buildNativeIndexEarlyPaintSummaries({
      rows: [
        { ...indexRow("claude", "new-claude"), updatedAt: 40 },
        { ...indexRow("grok", "new-grok"), updatedAt: 41 },
        { ...indexRow("pi", "new-pi"), updatedAt: 42 },
        {
          engine: "qoder",
          sessionId: "__qoder_global__:new-qoder",
          title: "你好 kk",
          updatedAt: 43,
        },
        { ...indexRow("grok", "keep"), updatedAt: 20 },
      ],
      workspaceId: "ws-1",
      getCustomName: () => undefined,
      hideSet: new Set(),
      currentThreads: undefined,
      lastGood: [lastGoodGrok],
      hideReady: false,
    });
    const ids = painted.map((row) => row.id).sort();
    expect(ids).toContain("claude:new-claude");
    expect(ids).toContain("grok:keep");
    expect(ids).not.toContain("grok:new-grok");
    expect(ids).not.toContain("pi:new-pi");
    expect(ids.some((id) => id.includes("new-qoder"))).toBe(false);
    expect(
      shouldDeferNativeIndexRowUntilHideReady(
        { id: "grok:new-grok", engineSource: "grok" },
        { hideReady: false, keepIds: new Set(["grok:keep"]) },
      ),
    ).toBe(true);
  });
});
