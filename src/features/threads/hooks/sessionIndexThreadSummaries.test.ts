import { describe, expect, it } from "vitest";
import {
  mergeSessionIndexRowsIntoSummaries,
  mergeSummariesForMissingEngines,
  sessionIndexRowToThreadId,
  sessionIndexRowsToThreadSummaries,
  shouldHidePlaceholderNativeDraftFromSidebar,
  stripEmptyClaudeIndexFallbackSummaries,
} from "./sessionIndexThreadSummaries";
import type { ThreadSummary } from "../../../types";

describe("sessionIndexThreadSummaries", () => {
  it("maps claude/codex/kimi rows to thread ids", () => {
    expect(
      sessionIndexRowToThreadId({
        engine: "claude",
        sessionId: "abc",
        title: "hi",
        updatedAt: 1,
      }),
    ).toBe("claude:abc");
    expect(
      sessionIndexRowToThreadId({
        engine: "codex",
        sessionId: "uuid-1",
        title: "hi",
        updatedAt: 1,
      }),
    ).toBe("uuid-1");
    expect(
      sessionIndexRowToThreadId({
        engine: "kimi",
        sessionId: "k1",
        title: "hi",
        updatedAt: 1,
      }),
    ).toBe("kimi:k1");
    expect(
      sessionIndexRowToThreadId({
        engine: "pi",
        sessionId: "p1",
        title: "hi",
        updatedAt: 1,
      }),
    ).toBe("pi:p1");
  });

  it("keeps Qoder Global/CN index rows with the same raw id distinct", () => {
    const rows = sessionIndexRowsToThreadSummaries(
      [
        {
          engine: "qoder",
          sessionId: "same-raw-session",
          title: "Global session",
          updatedAt: 20,
          providerProfileId: "__qoder_global__",
        },
        {
          engine: "qoder",
          sessionId: "same-raw-session",
          title: "CN session",
          updatedAt: 10,
          providerProfileId: "__qoder_cn__",
        },
      ],
      {
        workspaceId: "ws",
        mappedTitles: {},
        getCustomName: () => "",
        hiddenSharedBindingIds: new Set([
          "qoder:__qoder_global__:same-raw-session",
        ]),
      },
    );

    expect(rows).toEqual([
      expect.objectContaining({
        id: "qoder:__qoder_cn__:same-raw-session",
        providerProfileId: "__qoder_cn__",
      }),
    ]);
  });

  it("builds thread summaries with custom titles", () => {
    const rows = sessionIndexRowsToThreadSummaries(
      [
        {
          engine: "claude",
          sessionId: "s1",
          title: "First prompt",
          updatedAt: 100,
          sizeBytes: 12,
        },
      ],
      {
        workspaceId: "ws",
        mappedTitles: {},
        getCustomName: () => "",
      },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("claude:s1");
    expect(rows[0]?.engineSource).toBe("claude");
    expect(rows[0]?.name).toContain("First");
    expect(rows[0]?.createdAt).toBe(100);
  });

  it("carries provider label fields from index rows", () => {
    const rows = sessionIndexRowsToThreadSummaries(
      [
        {
          engine: "codex",
          sessionId: "uuid-9",
          title: "你好",
          updatedAt: 100,
          providerProfileId: "profile-xmapi",
          providerProfileName: "xmapi.cc",
        },
        {
          engine: "grok",
          sessionId: "g1",
          title: "在吗",
          updatedAt: 90,
        },
      ],
      {
        workspaceId: "ws",
        mappedTitles: {},
        getCustomName: () => "",
      },
    );
    expect(rows).toHaveLength(2);
    const codex = rows.find((row) => row.id === "uuid-9");
    expect(codex?.providerProfileId).toBe("profile-xmapi");
    expect(codex?.providerProfileName).toBe("xmapi.cc");
    const grok = rows.find((row) => row.id === "grok:g1");
    expect(grok?.providerProfileId).toBeUndefined();
  });

  it("keeps live provider fields when merging older index rows", () => {
    const live: ThreadSummary[] = [
      {
        id: "uuid-9",
        name: "你好",
        updatedAt: 200,
        engineSource: "codex",
        threadKind: "native",
        providerProfileId: "profile-xmapi",
        providerProfileName: "xmapi.cc",
      },
    ];
    const merged = mergeSessionIndexRowsIntoSummaries(
      live,
      [
        {
          engine: "codex",
          sessionId: "uuid-9",
          title: "你好",
          updatedAt: 100,
        },
      ],
      {
        workspaceId: "ws",
        mappedTitles: {},
        getCustomName: () => "",
      },
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.providerProfileId).toBe("profile-xmapi");
    expect(merged[0]?.providerProfileName).toBe("xmapi.cc");
  });

  it("keeps a live DSH header preset when a newer index row has none", () => {
    const live: ThreadSummary[] = [
      {
        id: "dsh:sess-preset",
        name: "hello from dsh",
        updatedAt: 100,
        engineSource: "dsh",
        threadKind: "native",
        dshAgentPreset: "code",
      },
    ];
    const merged = mergeSessionIndexRowsIntoSummaries(
      live,
      [
        {
          engine: "dsh",
          sessionId: "sess-preset",
          title: "hello from dsh",
          updatedAt: 200,
        },
      ],
      {
        workspaceId: "ws",
        mappedTitles: {},
        getCustomName: () => "",
      },
    );
    expect(merged[0]?.dshAgentPreset).toBe("code");
  });

  it("maps explicit createdAt and does not let a later updatedAt replace it", () => {
    const rows = sessionIndexRowsToThreadSummaries(
      [
        {
          engine: "claude",
          sessionId: "s1",
          title: "First prompt",
          createdAt: 50,
          updatedAt: 900,
        },
      ],
      {
        workspaceId: "ws",
        mappedTitles: {},
        getCustomName: () => "",
      },
    );
    expect(rows[0]?.createdAt).toBe(50);
    expect(rows[0]?.updatedAt).toBe(900);
  });

  it("drops commit-message helper rows from the first-paint index", () => {
    const rows = sessionIndexRowsToThreadSummaries(
      [
        {
          engine: "grok",
          sessionId: "commit-en",
          title:
            "Please generate a commit message. The commit message must follow the Conventional Commits specification",
          updatedAt: 200,
        },
        {
          engine: "claude",
          sessionId: "user-1",
          title: "当前收起逻辑与数据不一致",
          updatedAt: 100,
        },
      ],
      {
        workspaceId: "ws",
        mappedTitles: {},
        getCustomName: () => "",
      },
    );
    expect(rows.map((row) => row.id)).toEqual(["claude:user-1"]);
  });

  it("preserves explicit empty disk size for never-started index rows", () => {
    const rows = sessionIndexRowsToThreadSummaries(
      [
        {
          engine: "claude",
          sessionId: "empty-1",
          title: "刚起的草稿",
          updatedAt: 10,
          sizeBytes: 0,
        },
      ],
      {
        workspaceId: "ws",
        mappedTitles: {},
        getCustomName: () => "",
      },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sizeBytes).toBe(0);
  });

  it("hides Shared-owned and protocol-hidden index rows before first paint", () => {
    const rows = sessionIndexRowsToThreadSummaries(
      [
        {
          engine: "claude",
          sessionId: "owned-1",
          title: "分析一下接口",
          updatedAt: 10,
        },
        {
          engine: "claude",
          sessionId: "user-1",
          title: "分析一下接口",
          updatedAt: 9,
        },
      ],
      {
        workspaceId: "ws",
        mappedTitles: {},
        getCustomName: () => "",
        hiddenSharedBindingIds: new Set(["claude:owned-1", "owned-1"]),
      },
    );
    expect(rows.map((row) => row.id)).toEqual(["claude:user-1"]);
  });

  it("drops empty Claude Session fallbacks and MOSSX control-plane titles", () => {
    const rows = sessionIndexRowsToThreadSummaries(
      [
        {
          engine: "claude",
          sessionId: "empty-uuid",
          title: "Claude Session",
          updatedAt: 12,
        },
        {
          engine: "claude",
          sessionId: "mossx-1",
          title: "MOSSX_CONTEXT_PACKAGE:sha25…",
          updatedAt: 11,
        },
        {
          engine: "claude",
          sessionId: "claude-pending-1787016153035-0bittx",
          title: "Claude Session",
          updatedAt: 10,
        },
        {
          engine: "claude",
          sessionId: "user-1",
          title: "分析左侧栏消失问题",
          updatedAt: 9,
        },
      ],
      {
        workspaceId: "ws",
        mappedTitles: {},
        getCustomName: () => "",
      },
    );
    expect(rows.map((row) => row.id)).toEqual(["claude:user-1"]);
  });

  it("drops empty Codex Session fallbacks, helpers, MOSSX and pending drafts", () => {
    const rows = sessionIndexRowsToThreadSummaries(
      [
        {
          engine: "codex",
          sessionId: "empty-uuid",
          title: "Codex Session",
          updatedAt: 12,
        },
        {
          engine: "codex",
          sessionId: "mossx-1",
          title: "MOSSX_CONTEXT_PACKAGE:sha25…",
          updatedAt: 11,
        },
        {
          engine: "codex",
          sessionId: "helper-1",
          title: "You are generating OpenSpec project context.",
          updatedAt: 10,
        },
        {
          engine: "codex",
          sessionId: "codex-pending-1786994371985-fv4mt5",
          title: "Codex Session",
          updatedAt: 9,
        },
        {
          engine: "codex",
          sessionId: "user-1",
          title: "分析左侧栏消失问题",
          updatedAt: 8,
        },
        {
          engine: "codex",
          sessionId: "nick-1",
          title: "Aristotle",
          updatedAt: 7,
        },
      ],
      {
        workspaceId: "ws",
        mappedTitles: {},
        getCustomName: () => "",
      },
    );
    expect(rows.map((row) => row.id)).toEqual(["user-1", "nick-1"]);
  });

  it("last-good strip drops empty Claude Session, MOSSX and pending drafts", () => {
    const kept = stripEmptyClaudeIndexFallbackSummaries([
      {
        id: "claude:empty-uuid",
        name: "Claude Session",
        updatedAt: 3,
        engineSource: "claude",
      },
      {
        id: "claude:mossx-1",
        name: "MOSSX_CONTEXT_PACKAGE:sha25…",
        updatedAt: 2,
        engineSource: "claude",
      },
      {
        id: "claude:claude-pending-1787016153035-0bittx",
        name: "Claude Session",
        updatedAt: 1,
        engineSource: "claude",
      },
      {
        id: "claude:user-1",
        name: "分析左侧栏消失问题",
        updatedAt: 0,
        engineSource: "claude",
      },
    ] as ThreadSummary[]);
    expect(kept.map((row) => row.id)).toEqual(["claude:user-1"]);
  });

  it("drops empty DSH / Grok / Gemini placeholder drafts and pending, keeps custom and real titles", () => {
    const rows = sessionIndexRowsToThreadSummaries(
      [
        {
          engine: "dsh",
          sessionId: "empty-dsh",
          title: "dsh session",
          updatedAt: 12,
        },
        {
          engine: "dsh",
          sessionId: "empty-dsh-long",
          title: "DeepSeek Harness Session",
          updatedAt: 11,
        },
        {
          engine: "grok",
          sessionId: "empty-grok",
          title: "grok session",
          updatedAt: 10,
        },
        {
          engine: "gemini",
          sessionId: "empty-gemini",
          title: "Gemini Session",
          updatedAt: 9,
        },
        {
          engine: "dsh",
          sessionId: "dsh-pending-1787016153035-0bittx",
          title: "dsh session",
          updatedAt: 8,
        },
        {
          engine: "dsh",
          sessionId: "named-dsh",
          title: "dsh session",
          updatedAt: 7,
        },
        {
          engine: "dsh",
          sessionId: "real-dsh",
          title: "帮我看一下这段代码",
          updatedAt: 6,
        },
      ],
      {
        workspaceId: "ws",
        mappedTitles: {},
        getCustomName: (_workspaceId, threadId) =>
          threadId === "dsh:named-dsh" ? "我的草稿" : "",
      },
    );
    expect(rows.map((row) => row.id)).toEqual([
      "dsh:named-dsh",
      "dsh:real-dsh",
    ]);
  });

  it("last-good strip drops empty Codex Session, helpers and pending drafts", () => {
    const kept = stripEmptyClaudeIndexFallbackSummaries([
      {
        id: "empty-uuid",
        name: "Codex Session",
        updatedAt: 4,
        engineSource: "codex",
      },
      {
        id: "helper-1",
        name: "You are generating OpenSpec project context.",
        updatedAt: 3,
        engineSource: "codex",
      },
      {
        id: "codex-pending-1786994371985-fv4mt5",
        name: "Codex Session",
        updatedAt: 2,
        engineSource: "codex",
      },
      {
        id: "user-1",
        name: "分析左侧栏消失问题",
        updatedAt: 1,
        engineSource: "codex",
      },
    ] as ThreadSummary[]);
    expect(kept.map((row) => row.id)).toEqual(["user-1"]);
  });

  it("last-good strip drops empty DSH / Grok placeholders and pending drafts", () => {
    const kept = stripEmptyClaudeIndexFallbackSummaries([
      {
        id: "dsh:empty-dsh",
        name: "dsh session",
        updatedAt: 4,
        engineSource: "dsh",
      },
      {
        id: "grok:empty-grok",
        name: "Grok Session",
        updatedAt: 3,
        engineSource: "grok",
      },
      {
        id: "dsh:dsh-pending-1787016153035-0bittx",
        name: "dsh session",
        updatedAt: 2,
        engineSource: "dsh",
      },
      {
        id: "dsh:real-dsh",
        name: "帮我看一下这段代码",
        updatedAt: 1,
        engineSource: "dsh",
      },
    ] as ThreadSummary[]);
    expect(kept.map((row) => row.id)).toEqual(["dsh:real-dsh"]);
  });

  it("hides local pending drafts unless the user gave a custom name", () => {
    expect(
      shouldHidePlaceholderNativeDraftFromSidebar({
        engine: "claude",
        threadId: "claude:claude-pending-1787016153035-0bittx",
        displayName: "Claude Session",
      }),
    ).toBe(true);
    expect(
      shouldHidePlaceholderNativeDraftFromSidebar({
        engine: "dsh",
        threadId: "dsh:dsh-pending-1787016153035-0bittx",
        displayName: "dsh session",
      }),
    ).toBe(true);
    expect(
      shouldHidePlaceholderNativeDraftFromSidebar({
        engine: "codex",
        threadId: "codex-pending-1786994371985-fv4mt5",
        displayName: "我的草稿",
        hasCustomName: true,
      }),
    ).toBe(false);
    expect(
      shouldHidePlaceholderNativeDraftFromSidebar({
        engine: "claude",
        threadId: "claude:user-1",
        displayName: "分析左侧栏消失问题",
      }),
    ).toBe(false);
  });

  it("hides leftover Agent N placeholders but keeps the active conversation", () => {
    expect(
      shouldHidePlaceholderNativeDraftFromSidebar({
        engine: "codex",
        threadId: "real-codex-id",
        displayName: "Agent 5",
      }),
    ).toBe(true);
    expect(
      shouldHidePlaceholderNativeDraftFromSidebar({
        engine: "claude",
        threadId: "claude:real",
        displayName: "Claude Session",
        isActive: true,
      }),
    ).toBe(false);
    expect(
      shouldHidePlaceholderNativeDraftFromSidebar({
        engine: "grok",
        threadId: "grok:child",
        displayName: "grok session",
        isChildSession: true,
      }),
    ).toBe(false);
  });

  it("never hides a shared canonical row via the owner predicate", () => {
    const rows = sessionIndexRowsToThreadSummaries(
      [
        {
          engine: "claude",
          sessionId: "shared:s1",
          title: "Shared Session",
          updatedAt: 3,
        },
      ],
      {
        workspaceId: "ws",
        mappedTitles: {},
        getCustomName: () => "",
        hiddenSharedBindingIds: new Set(["shared:s1"]),
      },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("shared:s1");
  });

  it("merges without dropping newer live rows", () => {
    const merged = mergeSessionIndexRowsIntoSummaries(
      [
        {
          id: "claude:s1",
          name: "Live name",
          updatedAt: 200,
          engineSource: "claude",
          threadKind: "native",
        },
      ],
      [
        {
          engine: "claude",
          sessionId: "s1",
          title: "Index older",
          updatedAt: 100,
        },
        {
          engine: "codex",
          sessionId: "c1",
          title: "Codex from index",
          updatedAt: 150,
        },
      ],
      {
        workspaceId: "ws",
        mappedTitles: {},
        getCustomName: () => "",
      },
    );
    const byId = new Map(merged.map((row) => [row.id, row]));
    expect(byId.get("claude:s1")?.name).toBe("Live name");
    expect(byId.get("c1")?.engineSource).toBe("codex");
  });

  it("stamps createdAt onto a newer live row without overwriting it", () => {
    const merged = mergeSessionIndexRowsIntoSummaries(
      [
        {
          id: "claude:s1",
          name: "Live name",
          updatedAt: 200,
          engineSource: "claude",
          threadKind: "native",
        },
      ],
      [
        {
          engine: "claude",
          sessionId: "s1",
          title: "Index older",
          createdAt: 40,
          updatedAt: 100,
        },
      ],
      {
        workspaceId: "ws",
        mappedTitles: {},
        getCustomName: () => "",
      },
    );
    expect(merged[0]?.createdAt).toBe(40);
    expect(merged[0]?.updatedAt).toBe(200);
    expect(merged[0]?.name).toBe("Live name");
  });

  it("keeps last-good claude rows when index only returned shared and codex", () => {
    const merged = mergeSummariesForMissingEngines(
      [
        {
          id: "shared:1",
          name: "Shared",
          updatedAt: 30,
          threadKind: "shared",
        },
        {
          id: "codex-1",
          name: "Codex",
          updatedAt: 20,
          engineSource: "codex",
          threadKind: "native",
        },
      ],
      [
        {
          id: "claude:old",
          name: "Claude history",
          updatedAt: 10,
          engineSource: "claude",
          threadKind: "native",
        },
        {
          id: "codex-older",
          name: "Should stay out",
          updatedAt: 5,
          engineSource: "codex",
          threadKind: "native",
        },
      ],
    );
    expect(merged.map((row) => row.id)).toEqual([
      "shared:1",
      "codex-1",
      "claude:old",
    ]);
  });

  it("does not resurrect stale local pending drafts when an engine is missing from index", () => {
    const merged = mergeSummariesForMissingEngines(
      [
        {
          id: "codex-1",
          name: "Codex",
          updatedAt: 20,
          engineSource: "codex",
          threadKind: "native",
        },
      ],
      [
        {
          id: "grok:grok-pending-1787016153035-0bittx",
          name: "grok session",
          updatedAt: 40,
          engineSource: "grok",
          threadKind: "native",
        },
        {
          id: "grok-pending-1787016153035-0bittx",
          name: "grok session",
          updatedAt: 39,
          engineSource: "grok",
          threadKind: "native",
        },
        {
          id: "grok:14a64a80-c9ab-4ff1-a1de-196dca031750",
          name: "Real Grok",
          updatedAt: 10,
          engineSource: "grok",
          threadKind: "native",
        },
      ],
    );
    expect(merged.map((row) => row.id)).toEqual([
      "codex-1",
      "grok:14a64a80-c9ab-4ff1-a1de-196dca031750",
    ]);
  });
});
