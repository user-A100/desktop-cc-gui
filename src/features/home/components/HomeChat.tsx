import { useDeferredValue, useEffect, useRef, useState, type ReactNode } from "react";
import Check from "lucide-react/dist/esm/icons/check";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import Folder from "lucide-react/dist/esm/icons/folder";
import FolderPlus from "lucide-react/dist/esm/icons/folder-plus";
import { useTranslation } from "react-i18next";
import type { EngineType } from "../../../types";
import type { WorkspaceKind } from "../../../types";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../../components/ui/popover";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "../../../components/ui/command";
import { EngineIcon } from "../../engine/components/EngineIcon";
import { SetupIncompleteBanner } from "../../onboarding/components/SetupIncompleteBanner";
import { TokenIndicator } from "../../composer/components/ChatInputBox/TokenIndicator";
import {
  ComposerBranchBadge,
  type ComposerBranchControl,
} from "../../composer/components/ComposerBranchBadge";
import { ParticleWordmark } from "./ParticleWordmark";

type HomeChatProps = {
  workspaces: Array<{
    id: string;
    name: string;
    path?: string;
    kind?: WorkspaceKind;
    worktree?: {
      branch: string;
    } | null;
  }>;
  selectedWorkspaceId?: string | null;
  onSelectWorkspace: (workspaceId: string) => void;
  onAddWorkspace?: () => void;
  composerNode?: ReactNode;
  selectedEngine?: EngineType;
  branchControl?: ComposerBranchControl | null;
};

function getEngineLabel(engine: EngineType): string {
  switch (engine) {
    case "claude":
      return "Claude";
    case "gemini":
      return "Gemini";
    case "grok":
      return "Grok";
    case "kimi":
      return "Kimi";
    case "opencode":
      return "OpenCode";
    case "dsh":
      return "DSH";
    case "pi":
      return "PI CLI";
    case "qoder":
      return "Qoder CLI";
    case "codex":
    default:
      return "Codex";
  }
}

export function HomeChat({
  workspaces,
  selectedWorkspaceId = null,
  onSelectWorkspace,
  onAddWorkspace,
  composerNode,
  selectedEngine = "codex",
  branchControl = null,
}: HomeChatProps) {
  const { t } = useTranslation();
  const heroRef = useRef<HTMLElement | null>(null);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [workspaceQuery, setWorkspaceQuery] = useState("");
  const engineLabel = getEngineLabel(selectedEngine);
  const homeTitle = t("homeChat.minimalTitle", "Create anything");
  const selectedWorkspace = workspaces.find((workspace) => workspace.id === selectedWorkspaceId)
    ?? workspaces[0]
    ?? null;
  const showUsageIndicator = selectedEngine !== "codex";
  const deferredWorkspaceQuery = useDeferredValue(workspaceQuery.trim().toLowerCase());
  const filteredWorkspaces = deferredWorkspaceQuery.length === 0
    ? workspaces
    : workspaces.filter((workspace) => {
      const name = workspace.name.toLowerCase();
      const path = workspace.path?.toLowerCase() ?? "";
      return name.includes(deferredWorkspaceQuery) || path.includes(deferredWorkspaceQuery);
    });
  const resolvedWorkspaceId = selectedWorkspace?.id ?? workspaces[0]?.id ?? "";
  useEffect(() => {
    if (!workspaceMenuOpen) {
      setWorkspaceQuery("");
    }
  }, [workspaceMenuOpen]);

  function handleWorkspaceSelect(workspaceId: string) {
    onSelectWorkspace(workspaceId);
    setWorkspaceMenuOpen(false);
    setWorkspaceQuery("");
  }

  function handleAddWorkspace() {
    setWorkspaceMenuOpen(false);
    setWorkspaceQuery("");
    onAddWorkspace?.();
  }

  return (
    <div className="home-chat">
      <div className="home-chat-shell">
        <SetupIncompleteBanner />
        <div className="home-chat-hero-wrap" ref={heroRef}>
          <ParticleWordmark containerRef={heroRef} />
          <header className="home-chat-hero">
            <div
              className="home-chat-engine-mark"
              role="img"
              aria-label={engineLabel}
            >
              <EngineIcon
                engine={selectedEngine}
                size={32}
                className="home-chat-engine-icon"
              />
            </div>

            <div className="home-chat-headline">
              <h1 className="home-chat-title">
                {homeTitle}
              </h1>
            </div>
          </header>
        </div>

        <section className="home-chat-stage">
          <section
            className="home-chat-composer-panel"
            aria-label={t("home.newConversation", "New Conversation")}
          >
            <div className="home-chat-composer-host">{composerNode}</div>
            {selectedWorkspace ? (
              <div
                className="home-chat-composer-meta"
                title={selectedWorkspace.name}
              >
                <div className="composer-branch-badge home-chat-workspace-select" title={selectedWorkspace.name}>
                  <Popover open={workspaceMenuOpen} onOpenChange={setWorkspaceMenuOpen}>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        className="composer-branch-badge-trigger"
                        aria-label={t("homeChat.workspaceSelectLabel", "Workspace")}
                        aria-expanded={workspaceMenuOpen}
                      >
                        <Folder
                          size={13}
                          aria-hidden
                          className="composer-branch-badge-icon"
                        />
                        <span className="composer-branch-badge-name">
                          {selectedWorkspace.name}
                        </span>
                        <ChevronDown
                          size={12}
                          aria-hidden
                          className="composer-branch-badge-caret"
                        />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent
                      align="center"
                      className="w-72 p-0"
                      side="bottom"
                      sideOffset={8}
                    >
                      <Command shouldFilter={false}>
                        <CommandInput
                          value={workspaceQuery}
                          onValueChange={setWorkspaceQuery}
                          placeholder={t("homeChat.workspaceSearchPlaceholder", "Search projects")}
                          autoFocus
                          aria-label={t("homeChat.workspaceSelectLabel", "Workspace")}
                        />
                        <CommandList>
                          <CommandGroup>
                            {filteredWorkspaces.map((workspace) => {
                              const isSelected = workspace.id === resolvedWorkspaceId;
                              return (
                                <CommandItem
                                  key={workspace.id}
                                  value={workspace.id}
                                  data-selected={isSelected ? "true" : undefined}
                                  onSelect={() => handleWorkspaceSelect(workspace.id)}
                                >
                                  <Folder className="size-4 shrink-0 opacity-60" aria-hidden />
                                  <span className="min-w-0 flex-1 truncate">
                                    {workspace.name}
                                  </span>
                                  {isSelected ? (
                                    <Check className="size-4 shrink-0" aria-hidden />
                                  ) : null}
                                </CommandItem>
                              );
                            })}
                          </CommandGroup>
                          {filteredWorkspaces.length === 0 ? (
                            <div className="py-6 text-center text-sm text-muted-foreground">
                              {t("homeChat.workspaceNoMatch", "No projects found")}
                            </div>
                          ) : null}
                          <CommandSeparator />
                          <CommandGroup>
                            <CommandItem
                              value="__add_workspace__"
                              onSelect={handleAddWorkspace}
                            >
                              <FolderPlus className="size-4 shrink-0" aria-hidden />
                              <span>{t("homeChat.addWorkspaceAction", "Add new project")}</span>
                            </CommandItem>
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                </div>
                {branchControl?.branchName ? (
                  <ComposerBranchBadge {...branchControl} />
                ) : null}
                {showUsageIndicator ? (
                  <div className="composer-branch-row-usage">
                    <TokenIndicator percentage={null} />
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>

        </section>
      </div>
    </div>
  );
}
