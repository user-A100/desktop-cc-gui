import { describe, expect, it } from "vitest";
import {
  buildNativeOwnerToSharedThreadMap,
  buildSharedSidebarHiddenParentKeys,
  expandHiddenSharedBindingIds,
  isSharedSidebarHiddenPup,
  lookupSharedOwnerByNativeParent,
  normalizeSharedSessionSummary,
  remapParentThreadIdToSharedOwner,
  remapThreadParentsToSharedOwners,
  toSharedThreadSummary,
} from "./sharedSessionSummaries";

describe("sharedSessionSummaries", () => {
  it("keeps native thread ids for all supported Shared engines", () => {
    const summary = normalizeSharedSessionSummary({
      id: "shared-session-1",
      threadId: "shared:shared-session-1",
      title: "Shared Session",
      updatedAt: 1_730_000_000_000,
      selectedEngine: "grok",
      nativeThreadIds: [
        "claude:session-1",
        "claude-pending-shared-2",
        "019d767b-5541-7010-a30d-a454864bccd8",
        "grok:session-3",
        "kimi:session-4",
        "opencode:session-5",
        "pi:session-6",
        "pi-pending-shared-7",
        "gemini:session-3",
        "gemini-pending-4",
      ],
    });

    expect(summary).toMatchObject({
      id: "shared-session-1",
      threadId: "shared:shared-session-1",
      selectedEngine: "grok",
    });
    expect(summary?.nativeThreadIds).toEqual([
      "claude:session-1",
      "claude-pending-shared-2",
      "019d767b-5541-7010-a30d-a454864bccd8",
      "grok:session-3",
      "kimi:session-4",
      "opencode:session-5",
      "pi:session-6",
      "pi-pending-shared-7",
    ]);
  });

  it("maps Shared createdAt onto the sidebar summary without using updatedAt", () => {
    const summary = normalizeSharedSessionSummary({
      id: "shared-session-created",
      threadId: "shared:shared-session-created",
      title: "Shared Session",
      createdAt: 40,
      updatedAt: 900,
      selectedEngine: "claude",
      nativeThreadIds: [],
    });

    expect(summary?.createdAt).toBe(40);
    expect(toSharedThreadSummary(summary!).createdAt).toBe(40);
    expect(toSharedThreadSummary(summary!).updatedAt).toBe(900);
  });

  it("rejects malformed non-shared thread ids from shared summaries", () => {
    expect(
      normalizeSharedSessionSummary({
        id: "not-shared",
        threadId: "gemini:session-1",
        selectedEngine: "claude",
      }),
    ).toBeNull();
  });

  it("expands hidden binding ids for raw and engine-prefixed forms", () => {
    const expanded = expandHiddenSharedBindingIds([
      "grok:real-session-1",
      "kimi-pending-shared-2",
      "019d767b-5541-7010-a30d-a454864bccd8",
      "opencode:ses_opc_1",
      "pi:real-pi-session",
      "pi-pending-shared-2",
      "qoder:real-qoder-session",
    ]);

    expect(expanded.has("grok:real-session-1")).toBe(true);
    expect(expanded.has("real-session-1")).toBe(true);
    expect(expanded.has("kimi:kimi-pending-shared-2")).toBe(true);
    expect(expanded.has("kimi-pending-shared-2")).toBe(true);
    expect(expanded.has("019d767b-5541-7010-a30d-a454864bccd8")).toBe(true);
    expect(expanded.has("codex:019d767b-5541-7010-a30d-a454864bccd8")).toBe(
      true,
    );
    expect(expanded.has("opencode:ses_opc_1")).toBe(true);
    expect(expanded.has("ses_opc_1")).toBe(true);
    expect(expanded.has("pi:real-pi-session")).toBe(true);
    expect(expanded.has("real-pi-session")).toBe(true);
    expect(expanded.has("pi:pi-pending-shared-2")).toBe(true);
    expect(expanded.has("pi-pending-shared-2")).toBe(true);
    expect(expanded.has("qoder:real-qoder-session")).toBe(true);
    expect(expanded.has("real-qoder-session")).toBe(true);
  });

  it("hides Qoder Shared pups when their parent uses the raw native id", () => {
    const threads = [
      {
        id: "shared:qoder-owner",
        name: "Qoder Shared",
        updatedAt: 1,
        engineSource: "qoder" as const,
        threadKind: "shared" as const,
        nativeThreadIds: ["qoder:shared-qoder-owner"],
      },
    ];
    const keys = buildSharedSidebarHiddenParentKeys(threads);

    expect(keys.has("qoder:shared-qoder-owner")).toBe(true);
    expect(keys.has("shared-qoder-owner")).toBe(true);
    expect(
      isSharedSidebarHiddenPup(
        { id: "qoder:shared-pup" },
        "shared-qoder-owner",
        keys,
      ),
    ).toBe(true);
    expect(
      isSharedSidebarHiddenPup(
        { id: "qoder:user-pup" },
        "qoder:user-owned-parent",
        keys,
      ),
    ).toBe(false);
  });

  it("keeps Qoder Global/CN Shared owner projection isolated for the same raw id", () => {
    const globalOwner = "qoder:__qoder_global__:same-raw-session";
    const cnOwner = "qoder:__qoder_cn__:same-raw-session";
    const keys = buildSharedSidebarHiddenParentKeys([
      {
        id: "shared:qoder-global-owner",
        name: "Qoder Global Shared",
        updatedAt: 1,
        engineSource: "qoder" as const,
        threadKind: "shared" as const,
        nativeThreadIds: [globalOwner],
      },
    ]);

    expect(keys.has(globalOwner)).toBe(true);
    expect(keys.has("same-raw-session")).toBe(false);
    expect(
      isSharedSidebarHiddenPup({ id: "qoder:global-pup" }, globalOwner, keys),
    ).toBe(true);
    expect(
      isSharedSidebarHiddenPup({ id: "qoder:cn-pup" }, cnOwner, keys),
    ).toBe(false);
  });

  it("remaps grok subagent parents from hidden native owner to shared thread", () => {
    const summary = normalizeSharedSessionSummary({
      id: "shared-session-1",
      threadId: "shared:shared-session-1",
      title: "Shared Session",
      updatedAt: 1,
      selectedEngine: "grok",
      nativeThreadIds: ["grok:parent-native"],
    });
    expect(summary).not.toBeNull();
    const map = buildNativeOwnerToSharedThreadMap([summary!]);
    expect(map.get("grok:parent-native")).toBe("shared:shared-session-1");
    expect(map.get("parent-native")).toBe("shared:shared-session-1");

    const remapped = remapThreadParentsToSharedOwners(
      [
        {
          id: "grok:child-1",
          name: "子代理 1",
          updatedAt: 2,
          engineSource: "grok",
          parentThreadId: "grok:parent-native",
        },
        {
          id: "shared:shared-session-1",
          name: "Shared Session",
          updatedAt: 3,
          engineSource: "grok",
          threadKind: "shared",
        },
      ],
      map,
    );
    expect(remapped.find((t) => t.id === "grok:child-1")?.parentThreadId).toBe(
      "shared:shared-session-1",
    );
  });

  it("lookupSharedOwnerByNativeParent matches codex raw vs engine-prefixed owners", () => {
    const summary = normalizeSharedSessionSummary({
      id: "shared-codex",
      threadId: "shared:shared-codex",
      title: "Shared Codex",
      updatedAt: 1,
      selectedEngine: "codex",
      nativeThreadIds: ["codex:019d767b-5541-7010-a30d-a454864bccd8"],
    });
    expect(summary).not.toBeNull();
    const map = buildNativeOwnerToSharedThreadMap([summary!]);
    const sharedId = "shared:shared-codex";

    // binding 带 codex:，child parent 为 raw uuid（live Codex 常见）
    expect(
      lookupSharedOwnerByNativeParent(
        "019d767b-5541-7010-a30d-a454864bccd8",
        map,
      ),
    ).toBe(sharedId);
    expect(
      lookupSharedOwnerByNativeParent(
        "codex:019d767b-5541-7010-a30d-a454864bccd8",
        map,
      ),
    ).toBe(sharedId);

    // binding 为 raw，child parent 为 codex:
    const rawBinding = normalizeSharedSessionSummary({
      id: "shared-codex-2",
      threadId: "shared:shared-codex-2",
      title: "Shared Codex 2",
      updatedAt: 1,
      selectedEngine: "codex",
      nativeThreadIds: ["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"],
    });
    const mapRaw = buildNativeOwnerToSharedThreadMap([rawBinding!]);
    expect(
      lookupSharedOwnerByNativeParent(
        "codex:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        mapRaw,
      ),
    ).toBe("shared:shared-codex-2");
  });

  it("remaps codex/claude/grok parent variants onto shared without touching unrelated trees", () => {
    const sessions = [
      normalizeSharedSessionSummary({
        id: "s-codex",
        threadId: "shared:s-codex",
        title: "S Codex",
        updatedAt: 1,
        selectedEngine: "codex",
        nativeThreadIds: ["codex:parent-codex"],
      })!,
      normalizeSharedSessionSummary({
        id: "s-claude",
        threadId: "shared:s-claude",
        title: "S Claude",
        updatedAt: 1,
        selectedEngine: "claude",
        nativeThreadIds: ["claude:parent-claude"],
      })!,
      normalizeSharedSessionSummary({
        id: "s-grok",
        threadId: "shared:s-grok",
        title: "S Grok",
        updatedAt: 1,
        selectedEngine: "grok",
        nativeThreadIds: ["grok:parent-grok"],
      })!,
    ];
    const map = buildNativeOwnerToSharedThreadMap(sessions);

    const input = [
      {
        id: "child-codex",
        name: "Archimedes",
        updatedAt: 2,
        engineSource: "codex" as const,
        parentThreadId: "parent-codex", // raw vs codex: binding
      },
      {
        id: "claude:child-1",
        name: "Explore",
        updatedAt: 2,
        engineSource: "claude" as const,
        parentThreadId: "parent-claude", // bare vs claude: binding
      },
      {
        id: "grok:child-1",
        name: "子代理",
        updatedAt: 2,
        engineSource: "grok" as const,
        parentThreadId: "grok:parent-grok",
      },
      {
        id: "codex:normal-child",
        name: "Native nest",
        updatedAt: 2,
        engineSource: "codex" as const,
        parentThreadId: "codex:visible-parent", // 非 shared owner
      },
      {
        id: "orphan-no-parent",
        name: "Top level",
        updatedAt: 2,
        engineSource: "codex" as const,
      },
    ];

    const remapped = remapThreadParentsToSharedOwners(input, map);
    expect(remapped.find((t) => t.id === "child-codex")?.parentThreadId).toBe(
      "shared:s-codex",
    );
    expect(remapped.find((t) => t.id === "claude:child-1")?.parentThreadId).toBe(
      "shared:s-claude",
    );
    expect(remapped.find((t) => t.id === "grok:child-1")?.parentThreadId).toBe(
      "shared:s-grok",
    );
    expect(
      remapped.find((t) => t.id === "codex:normal-child")?.parentThreadId,
    ).toBe("codex:visible-parent");
    expect(remapped.find((t) => t.id === "orphan-no-parent")?.parentThreadId).toBe(
      undefined,
    );

    // 无 map / 空 parent：恒等
    expect(remapThreadParentsToSharedOwners(input, new Map())).toBe(input);
    expect(remapParentThreadIdToSharedOwner(null, map)).toBeNull();
    expect(lookupSharedOwnerByNativeParent("codex:visible-parent", map)).toBeNull();
  });

  it("isSharedSidebarHiddenPup hides shared-owned pups by parent id shapes only", () => {
    const threads = [
      {
        id: "shared:s1",
        name: "S",
        updatedAt: 1,
        engineSource: "codex" as const,
        threadKind: "shared" as const,
        nativeThreadIds: ["codex:hidden-owner"],
      },
    ];
    const keys = buildSharedSidebarHiddenParentKeys(threads);
    expect(keys.has("shared:s1")).toBe(true);
    expect(keys.has("codex:hidden-owner")).toBe(true);
    expect(keys.has("hidden-owner")).toBe(true);

    expect(
      isSharedSidebarHiddenPup(
        { id: "pup-1" },
        "shared:s1",
        keys,
      ),
    ).toBe(true);
    expect(
      isSharedSidebarHiddenPup(
        { id: "pup-2" },
        "hidden-owner",
        keys,
      ),
    ).toBe(true);
    expect(
      isSharedSidebarHiddenPup(
        { id: "pup-3" },
        "codex:hidden-owner",
        keys,
      ),
    ).toBe(true);
    // Native 父子 / 无 parent / Shared 自身
    expect(
      isSharedSidebarHiddenPup(
        { id: "codex:child" },
        "codex:visible-parent",
        keys,
      ),
    ).toBe(false);
    expect(isSharedSidebarHiddenPup({ id: "solo" }, null, keys)).toBe(false);
    expect(
      isSharedSidebarHiddenPup(
        { id: "shared:s1", threadKind: "shared" },
        null,
        keys,
      ),
    ).toBe(false);
  });

  it("hides Shared Codex pups when parent is a Windows live rollout stem", () => {
    const uuid = "b7e2c1a0-4d3f-4a21-9c8e-1f2a3b4c5d6e";
    const rolloutStem = `rollout-2026-04-10T10-00-00-${uuid}`;
    const summary = normalizeSharedSessionSummary({
      id: "shared-codex-win",
      threadId: "shared:shared-codex-win",
      title: "Shared Codex Win",
      updatedAt: 1,
      selectedEngine: "codex",
      nativeThreadIds: [`codex:${uuid}`],
    });
    expect(summary).not.toBeNull();
    const map = buildNativeOwnerToSharedThreadMap([summary!]);
    expect(lookupSharedOwnerByNativeParent(rolloutStem, map)).toBe(
      "shared:shared-codex-win",
    );
    expect(lookupSharedOwnerByNativeParent(`codex:${rolloutStem}`, map)).toBe(
      "shared:shared-codex-win",
    );

    const threads = [
      {
        id: "shared:shared-codex-win",
        name: "Shared Codex Win",
        updatedAt: 1,
        engineSource: "codex" as const,
        threadKind: "shared" as const,
        nativeThreadIds: [`codex:${uuid}`],
      },
    ];
    const keys = buildSharedSidebarHiddenParentKeys(threads);
    expect(keys.has(uuid)).toBe(true);
    expect(keys.has(`codex:${uuid}`)).toBe(true);
    expect([...keys].some((key) => key.startsWith("rollout-"))).toBe(false);

    expect(
      isSharedSidebarHiddenPup({ id: "pup-socrates" }, rolloutStem, keys),
    ).toBe(true);
    expect(
      isSharedSidebarHiddenPup(
        { id: "pup-singer" },
        `codex:${rolloutStem}`,
        keys,
      ),
    ).toBe(true);
    expect(
      isSharedSidebarHiddenPup(
        { id: "native-child" },
        "codex:visible-parent",
        keys,
      ),
    ).toBe(false);
  });

  it("does not invent engine hide keys for Windows / POSIX filesystem ids", () => {
    const winDrive = expandHiddenSharedBindingIds(["S:\\AIWorker\\proj"]);
    expect([...winDrive]).toEqual(["S:\\AIWorker\\proj"]);

    const winUnc = expandHiddenSharedBindingIds(["\\\\?\\C:\\AIWorker\\proj"]);
    expect([...winUnc]).toEqual(["\\\\?\\C:\\AIWorker\\proj"]);

    const macHome = expandHiddenSharedBindingIds(["/Users/me/proj"]);
    expect([...macHome]).toEqual(["/Users/me/proj"]);

    const linuxHome = expandHiddenSharedBindingIds(["/home/me/proj"]);
    expect([...linuxHome]).toEqual(["/home/me/proj"]);

    const emptyMap = new Map<string, string>();
    expect(lookupSharedOwnerByNativeParent("S:\\AIWorker\\proj", emptyMap)).toBeNull();
    expect(lookupSharedOwnerByNativeParent("/Users/me/proj", emptyMap)).toBeNull();
    expect(
      isSharedSidebarHiddenPup(
        { id: "cwd-row" },
        "S:\\AIWorker\\proj",
        new Set(["shared:s1"]),
      ),
    ).toBe(false);
  });

  it("hides Claude subagent when parent is protocol file uuid extra hide", () => {
    const fileUuid = "1807f883-011c-46bd-94d5-ff483ffb1a4a";
    const keys = buildSharedSidebarHiddenParentKeys(
      [
        {
          id: "shared:267c001d-932a-4a05-bfa9-a238937f7707",
          name: "Shared",
          updatedAt: 1,
          engineSource: "claude",
          threadKind: "shared",
          nativeThreadIds: ["claude:c65677af-c64e-4fce-9e34-76f1cd1a7c7f"],
        },
      ],
      [fileUuid, `claude:${fileUuid}`],
    );
    expect(
      isSharedSidebarHiddenPup(
        { id: `claude:subagent:${fileUuid}:agent-a0f4436c38b58a97e` },
        `claude:${fileUuid}`,
        keys,
      ),
    ).toBe(true);
    expect(
      isSharedSidebarHiddenPup(
        { id: `claude:subagent:${fileUuid}:agent-a0f4436c38b58a97e` },
        fileUuid,
        keys,
      ),
    ).toBe(true);
  });

  it("hides Shared Codex Raman when parent is the protocol owner file uuid", () => {
    const owner = "019fdaa8-262e-7981-8572-ce0884b61784";
    const keys = buildSharedSidebarHiddenParentKeys(
      [
        {
          id: "shared:89d8becf-c13a-4cad-94e8-2815d4cb179a",
          name: "Shared",
          updatedAt: 1,
          engineSource: "codex",
          threadKind: "shared",
          nativeThreadIds: ["codex:default"],
        },
      ],
      [owner, `codex:${owner}`],
    );
    expect(
      isSharedSidebarHiddenPup(
        { id: "codex:raman-child" },
        owner,
        keys,
      ),
    ).toBe(true);
    expect(
      isSharedSidebarHiddenPup(
        { id: "codex:kierkegaard-child" },
        `codex:${owner}`,
        keys,
      ),
    ).toBe(true);
    expect(
      isSharedSidebarHiddenPup(
        { id: "codex:raman-child" },
        "codex:default",
        keys,
      ),
    ).toBe(true);
  });

  it("keeps local Codex TUI/Desktop pups visible", () => {
    const keys = buildSharedSidebarHiddenParentKeys(
      [
        {
          id: "shared:other",
          name: "Shared",
          updatedAt: 1,
          engineSource: "codex",
          threadKind: "shared",
          nativeThreadIds: ["codex:hidden-owner"],
        },
      ],
      ["1807f883-011c-46bd-94d5-ff483ffb1a4a"],
    );
    expect(
      isSharedSidebarHiddenPup(
        { id: "01a00d8f-7e8d-7481-bb59-9d3f79e4b51b" },
        "01a00d6c-205e-7492-b344-dccefed9909d",
        keys,
      ),
    ).toBe(false);
    expect(
      isSharedSidebarHiddenPup(
        { id: "019fc810-0a87-7542-8cf3-5a70454f2fa4" },
        "019fc7da-75f2-73a3-8793-9a8705e33a18",
        keys,
      ),
    ).toBe(false);
  });
});
