import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("../../state/queries", () => ({
  useComposerPathSearch: () => ({ entries: [], isPending: false }),
  useComposerPullRequestSearch: () => ({ entries: [], isPending: false, error: null }),
  useThreadSearch: () => undefined,
}));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerDraftSnapshot: vi.fn(),
  setComposerDraftContext: vi.fn(),
  useComposerDraftSelection: () => null,
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "context-id" }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providersValueAtom: vi.fn(),
    refreshProviders: Symbol("refreshProviders"),
  },
}));

import { useComposerCommandMenu } from "./use-composer-command-menu";

it("/model clears only its trigger and opens the model picker", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const onChangeDraftMessage = vi.fn();
  const onOpenModelPicker = vi.fn();
  let menu: ReturnType<typeof useComposerCommandMenu> | undefined;
  function Probe() {
    menu = useComposerCommandMenu({
      draftMessage: "fix this /mod",
      ownerKey: "draft",
      environmentId: null,
      projectCwd: null,
      selectedProviderStatus: null,
      hasThread: true,
      hasCompactableConversation: false,
      onChangeDraftMessage,
      onOpenModelPicker,
    });
    return null;
  }

  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  const model = menu?.items.find((item) => item.id === "cmd:model");
  if (!model) throw new Error("Expected /model in the slash menu");
  await act(async () => menu?.onSelect(model));

  expect(onOpenModelPicker).toHaveBeenCalledOnce();
  expect(onChangeDraftMessage).toHaveBeenCalledWith("fix this ");
  act(() => root.unmount());
});

it("/ ranks a skill whose name matches exactly above skills that only mention it", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const skill = (name: string, description: string) => ({
    name,
    description,
    path: `/skills/${name}/SKILL.md`,
    enabled: true,
  });
  const provider = {
    instanceId: "codex",
    driver: "codex",
    slashCommands: [],
    skills: [
      skill("lint", "Run lint before review"),
      skill("ship", "Open a pull request after review"),
      skill("review", "Review the current diff"),
    ],
  } as unknown as NonNullable<
    Parameters<typeof useComposerCommandMenu>[0]["selectedProviderStatus"]
  >;
  let menu: ReturnType<typeof useComposerCommandMenu> | undefined;
  function Probe() {
    menu = useComposerCommandMenu({
      draftMessage: "/review",
      ownerKey: "draft",
      environmentId: null,
      projectCwd: null,
      selectedProviderStatus: provider,
      hasThread: true,
      hasCompactableConversation: false,
      onChangeDraftMessage: vi.fn(),
      onOpenModelPicker: vi.fn(),
    });
    return null;
  }

  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));

  expect(menu?.items[0]?.id).toBe("skill:review");
  act(() => root.unmount());
});

it("selects a new thread in a project with no sessions from Pina's @ picker", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const environmentId = EnvironmentId.make("local");
  const project = {
    environmentId,
    id: ProjectId.make("shop-id"),
    title: "Storefront",
    workspaceRoot: "/src/shop",
    scripts: [],
    defaultModelSelection: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
  };
  const onChangeDraftMessage = vi.fn();
  let menu: ReturnType<typeof useComposerCommandMenu> | undefined;
  function Probe() {
    menu = useComposerCommandMenu({
      draftMessage: "Please investigate @",
      ownerKey: "pina",
      environmentId,
      currentThreadId: ThreadId.make("pina-assistant-scratch-0"),
      projects: [
        project,
        { ...project, id: ProjectId.make("archived"), archivedAt: project.updatedAt },
        { ...project, environmentId: EnvironmentId.make("unlinked") },
      ],
      projectCwd: null,
      selectedProviderStatus: null,
      hasThread: true,
      hasCompactableConversation: false,
      onChangeDraftMessage,
      onOpenModelPicker: vi.fn(),
    });
    return null;
  }

  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  expect(menu?.items).toHaveLength(1);
  const item = menu?.items[0];
  if (!item || item.type !== "project") throw new Error("Expected a project target");
  expect(item.label).toBe("New thread in Storefront");
  await act(async () => menu?.onSelect(item));
  expect(onChangeDraftMessage).toHaveBeenCalledWith(
    "Please investigate New thread in Storefront (projectId: shop-id, environmentId: local) ",
  );
  act(() => root.unmount());
});
