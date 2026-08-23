import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const currentDir = dirname(fileURLToPath(import.meta.url));
const srcDir = join(currentDir, "..", "..");

/** 已知 features → shell 工具桥（通过 app-shell-parts re-export；后续应迁到 features/shared） */
const FEATURE_SHELL_BRIDGE_ALLOWLIST = new Set([
  "features/app/hooks/useWorkspaceCycling.ts",
  "features/app/hooks/useGitHistoryPanelResize.ts",
  "features/composer/hooks/composerEnginePrefsStore.ts",
  "features/settings/hooks/useAppSettings.ts",
  "features/session-activity/hooks/useSessionRadarFeed.ts",
  // DSH 切会话回写 composer 选择（c181f935d / ea8fd49ed 引入的既有桥）
  "features/threads/hooks/useThreadActionsResumeThread.ts",
  "features/threads/loaders/dshHistoryLoader.ts",
]);

describe("appShellFeatureBoundaries (T3.5/T3.6/T3.7)", () => {
  it("does not import kanban execution from AppShell entry (T3.5)", () => {
    const entry = readFileSync(join(currentDir, "AppShell.tsx"), "utf8");
    expect(entry).not.toContain("useAppShellKanbanExecutionSection");
    expect(entry).not.toMatch(/from\s+["'].*KanbanExecution/);
  });

  it("keeps SearchRadar out of search/composer section (T3.6)", () => {
    const searchComposer = readFileSync(
      join(currentDir, "../sections/useAppShellSearchAndComposerSection.ts"),
      "utf8",
    );
    expect(searchComposer).not.toContain("useAppShellSearchRadarSection");
    const flows = readFileSync(
      join(currentDir, "../hosts/useAppShellWorkspaceFlowsHost.ts"),
      "utf8",
    );
    expect(flows).toContain("useAppShellSearchRadarSection");
  });

  it("keeps features/* free of new app-shell internal imports (T3.7)", () => {
    const features = join(srcDir, "features");
    const offenders: string[] = [];

    function walk(dir: string) {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          walk(p);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(name)) continue;
        const text = readFileSync(p, "utf8");
        if (!/from\s+["'][^"']*app-shell(?:-parts)?\//.test(text)) {
          continue;
        }
        // 禁止 features 直达 app-shell/ 内部（domains/assembly/sections）
        if (/from\s+["'][^"']*app-shell\//.test(text)) {
          offenders.push(`${relative(srcDir, p)}: direct app-shell/ import`);
          continue;
        }
        const rel = relative(srcDir, p);
        if (!FEATURE_SHELL_BRIDGE_ALLOWLIST.has(rel)) {
          offenders.push(`${rel}: unlisted app-shell-parts bridge`);
        }
      }
    }

    walk(features);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
