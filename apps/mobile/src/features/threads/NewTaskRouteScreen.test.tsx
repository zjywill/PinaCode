import type { ReactNode } from "react";
import { act } from "react";
import * as React from "react";
import { createRoot } from "react-dom/client";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { retargetSavedNewTaskDraft } from "../../state/use-composer-drafts";
import type { IncomingShareDraft } from "../sharing/incoming-share-model";

const environmentId = EnvironmentId.make("env-1");
const secondEnvironmentId = EnvironmentId.make("env-2");
const readOnlyEnvironmentId = EnvironmentId.make("env-view");

function project(id: string, workspaceRoot: string): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(id),
    title: id,
    workspaceRoot,
    repositoryIdentity: null,
    defaultModelSelection: null,
    defaultThreadEnvMode: "worktree",
    scripts: [],
    createdAt: "2026-10-26T00:00:00Z",
    updatedAt: "2026-10-26T00:00:00Z",
  };
}

const regular = project("app", "/repo/app");
const scratch = project("scratch", "/scratch");

const harness = vi.hoisted(() => ({
  setProject: vi.fn(),
  openScratch: vi.fn(),
  openPina: vi.fn(),
  discardShare: vi.fn(),
  getShare: vi.fn<(id: string) => IncomingShareDraft | null>(() => null),
  importPhase: vi.fn(),
  selectDetail: vi.fn(),
  navigation: {
    goBack: vi.fn(),
    getState: () => ({
      routeNames: ["Thread", "NewTaskProject"],
      index: 1,
      routes: [{ name: "Thread", params: { draft: {} } }, { name: "NewTaskProject" }],
    }),
    getParent: () => undefined,
    canGoBack: () => true,
    isFocused: () => true,
    dispatch: vi.fn(),
    navigate: vi.fn(),
  },
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: (props: {
    accessibilityLabel: string;
    disabled?: boolean;
    onPress: () => void;
    children?: ReactNode;
  }) => (
    <button aria-label={props.accessibilityLabel} disabled={props.disabled} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("gt-react-native", () => ({
  msg: (text: string) => text,
  T: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useGT: () => (text: string) => text,
  useMessages: () => (text: string) => text,
}));
vi.mock("@react-navigation/native", () => ({
  StackActions: { push: (name: string) => ({ type: "PUSH", name }) },
  useFocusEffect: (effect: () => () => void) => React.useEffect(effect, [effect]),
  useIsFocused: () => true,
  useNavigation: () => harness.navigation,
  useRoute: () => ({ key: "share-picker" }),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => false }));
vi.mock("../../components/ui/NavigationRow", () => ({
  NavigationRow: (props: {
    title: string;
    subtitle?: string;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button
      aria-label={[props.title, props.subtitle].filter(Boolean).join(", ")}
      disabled={props.disabled === true}
      onClick={props.onPress}
    >
      {props.title}
    </button>
  ),
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/AppBar", () => ({
  AppBar: ({
    actions,
  }: {
    actions: ReadonlyArray<{ accessibilityLabel: string; onPress: () => void }>;
  }) => (
    <>
      {actions.map((action) => (
        <button
          key={action.accessibilityLabel}
          aria-label={action.accessibilityLabel}
          onClick={action.onPress}
        />
      ))}
    </>
  ),
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({
  ScreenScrollView: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../../components/PinaAvatar", () => ({ PinaAvatar: () => null }));
vi.mock("../connection/environmentStatusText", () => ({ runtimeConnectionErrorText: () => null }));
vi.mock("../../state/entities", () => ({
  useProjects: () => [regular, scratch],
  useServerConfigs: () =>
    new Map(
      [environmentId, secondEnvironmentId, readOnlyEnvironmentId].map((id) => [
        id,
        {
          scratchWorkspaceRoot: "/scratch",
          environment: { capabilities: { pinaAssistant: true } },
        },
      ]),
    ),
}));
vi.mock("../../state/projects", () => ({ projectEnvironment: { openScratch: {} } }));
vi.mock("../../state/threads", () => ({ threadEnvironment: { openPina: "openPina" } }));
vi.mock("../../state/session", () => ({
  useEnvironmentsWithScope: () => new Set([environmentId, secondEnvironmentId]),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === "openPina" ? harness.openPina : harness.openScratch,
}));
vi.mock("../../state/use-composer-drafts", () => ({ retargetSavedNewTaskDraft: vi.fn() }));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteConnectionStatus: () => ({
    connectedEnvironments: [
      { environmentId, environmentLabel: "Laptop", connectionState: "connected" },
      {
        environmentId: secondEnvironmentId,
        environmentLabel: "Build Mac",
        connectionState: "connected",
      },
      {
        environmentId: readOnlyEnvironmentId,
        environmentLabel: "Read only",
        connectionState: "connected",
      },
    ],
  }),
}));
vi.mock("../../state/workspace", () => ({
  useWorkspaceState: () => ({ state: { hasReadyEnvironment: true } }),
}));
vi.mock("../sharing/IncomingShareProvider", () => ({
  useIncomingShare: () => ({
    getShare: harness.getShare,
    discardShare: harness.discardShare,
    releaseShareReservation: vi.fn(),
  }),
  incomingShareImports: { inFlightAtom: vi.fn(), phaseAtom: harness.importPhase },
}));
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => harness.selectDetail,
}));
vi.mock("./new-task-flow-provider", () => ({
  useNewTaskFlow: () => ({
    projectScopes: [
      {
        key: "app",
        title: "app",
        representative: regular,
        projects: [regular],
        projectRefs: [],
        pinned: false,
        archived: false,
      },
    ],
    selectedEnvironmentId: environmentId,
    setProject: harness.setProject,
  }),
}));

import { NewTaskRouteScreen } from "./NewTaskRouteScreen";

it("keeps the project picked while No project was still opening", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const opening = Promise.withResolvers<unknown>();
  harness.openScratch.mockReturnValue(opening.promise);

  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  act(() => root.render(<NewTaskRouteScreen route={{ params: undefined } as never} />));
  const row = (label: string) => container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;

  act(() => row("No project").click());
  await act(async () => row("app").click());
  await act(async () => opening.resolve({ _tag: "Success", value: scratch }));

  expect(harness.setProject.mock.calls).toEqual([[regular]]);
  expect(harness.navigation.goBack).toHaveBeenCalledTimes(1);
});

function renderWithSavedDraft() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const opening = Promise.withResolvers<unknown>();
  const retargeting = Promise.withResolvers<boolean>();
  harness.openScratch.mockReturnValue(opening.promise);
  vi.mocked(retargetSavedNewTaskDraft)
    .mockReset()
    .mockImplementation((_draftId, target) =>
      target.projectId === scratch.id ? retargeting.promise : Promise.resolve(true),
    );
  harness.selectDetail.mockClear();

  const container = document.createElement("div");
  const root = createRoot(container);
  const route = { params: { draftId: "existing-draft" } } as never;
  act(() => root.render(<NewTaskRouteScreen key="first" route={route} />));
  return {
    opening,
    retargeting,
    root,
    route,
    row: (label: string) => container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!,
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
}

const appDraftSelection = [
  [
    {
      name: "Thread",
      params: { draft: { environmentId, projectId: regular.id, draftId: "existing-draft" } },
    },
  ],
];

it("keeps the picked project after backing out and reopening while No project is pending", async () => {
  using screen = renderWithSavedDraft();

  act(() => screen.row("No project").click());
  act(() => screen.root.render(null));
  act(() => screen.root.render(<NewTaskRouteScreen key="second" route={screen.route} />));
  await act(async () => screen.row("app").click());
  await act(async () => {
    screen.opening.resolve({ _tag: "Success", value: scratch });
    screen.retargeting.resolve(true);
  });

  expect(harness.selectDetail.mock.calls).toEqual(appDraftSelection);
});

it("cancels the No project draft retarget when another project is picked", async () => {
  using screen = renderWithSavedDraft();

  act(() => screen.row("No project").click());
  await act(async () => screen.opening.resolve({ _tag: "Success", value: scratch }));
  const scratchSignal = vi
    .mocked(retargetSavedNewTaskDraft)
    .mock.calls.find(([, target]) => target.projectId === scratch.id)?.[2];
  expect(scratchSignal?.aborted).toBe(false);
  await act(async () => screen.row("app").click());
  expect(scratchSignal?.aborted).toBe(true);
  await act(async () => screen.retargeting.resolve(true));

  expect(harness.selectDetail.mock.calls).toEqual(appDraftSelection);
});

function renderShare(destination?: IncomingShareDraft["destination"]) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const share: IncomingShareDraft = {
    id: "share-link",
    schemaVersion: 1,
    createdAt: "2026-11-28T00:00:00Z",
    text: "https://github.com/acme/example/issues/1",
    attachments: [],
    warnings: [],
    ...(destination ? { destination } : {}),
  };
  harness.getShare.mockReturnValue(share);
  harness.openPina.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { threadId: "pina-assistant-scratch-0" },
  });
  harness.importPhase.mockClear();
  harness.discardShare.mockReset().mockResolvedValue(undefined);
  harness.navigation.goBack.mockClear();
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(<NewTaskRouteScreen route={{ params: { incomingShareId: share.id } } as never} />),
  );
  return {
    share,
    row: (label: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`),
    [Symbol.dispose]: () => {
      act(() => root.unmount());
      harness.getShare.mockReturnValue(null);
    },
  };
}

it("prepares the Pina draft in the selected writable environment", async () => {
  using screen = renderShare();
  expect(screen.row("Ask Pina, Read only")).toBeNull();
  expect(harness.openPina).not.toHaveBeenCalled();
  expect(harness.importPhase).not.toHaveBeenCalled();

  await act(async () => screen.row("Ask Pina, Build Mac")?.click());

  expect(harness.openPina).toHaveBeenCalledExactlyOnceWith({
    environmentId: secondEnvironmentId,
    input: {},
  });
  expect(harness.importPhase).toHaveBeenLastCalledWith({
    flowKey: "share-picker",
    routeKey: "share-picker",
    draftKey: "env-2:pina-assistant-scratch-0",
    destination: { environmentId: secondEnvironmentId, threadId: "pina-assistant-scratch-0" },
    shareId: screen.share.id,
  });
});

it("resumes a reserved share in its original Pina draft", () => {
  const destination = { environmentId: secondEnvironmentId, threadId: "pina-assistant-scratch-2" };
  using screen = renderShare(destination);
  expect(screen.row("Ask Pina, Laptop")).toBeNull();
  expect(harness.openPina).not.toHaveBeenCalled();
  expect(harness.importPhase).toHaveBeenLastCalledWith(
    expect.objectContaining({
      destination,
      draftKey: "env-2:pina-assistant-scratch-2",
    }),
  );
});

it("discards a cancelled share before opening a conversation or importing it", async () => {
  using screen = renderShare();
  await act(async () => screen.row("Cancel import")?.click());
  expect(harness.discardShare).toHaveBeenCalledExactlyOnceWith(screen.share);
  expect(harness.navigation.goBack).toHaveBeenCalledOnce();
  expect(harness.openPina).not.toHaveBeenCalled();
  expect(harness.importPhase).not.toHaveBeenCalled();
});
