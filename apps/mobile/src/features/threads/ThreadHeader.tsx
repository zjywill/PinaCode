import { useGT, useMessages } from "gt-react-native";

import { AppBar } from "../../components/ui/AppBar";
import type { AppBarAction, AppBarMenu } from "../../components/ui/AppBar.types";
import {
  useAdaptiveWorkspaceLayout,
  useWorkspacePaneState,
} from "../layout/AdaptiveWorkspaceLayout";
import type { ThreadInspectorMode } from "./thread-inspector-navigation";
import { useWorkspaceBackNavigation } from "../layout/workspace/useAndroidWorkspaceNavigation";
import {
  threadTerminalMenu,
  useThreadGitMenuDefinition,
  type ThreadGitControlsProps,
} from "./ThreadGitControls";

export function ThreadHeader(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly gitControls: ThreadGitControlsProps;
  readonly onReturnToThread?: () => void;
  readonly draft?: boolean;
  readonly hasThreadCwd: boolean;
  readonly inspectorMode: ThreadInspectorMode | null;
  readonly onOpenFilesInspector: () => void;
  readonly actions?: ReadonlyArray<AppBarAction> | undefined;
  readonly threadTools?: "menu" | "hidden";
}) {
  const gt = useGT();
  const m = useMessages();
  const goBack = useWorkspaceBackNavigation();
  const { toggleAuxiliaryPane, startNewTask } = useAdaptiveWorkspaceLayout();
  const { panes } = useWorkspacePaneState();
  const gitMenu = useThreadGitMenuDefinition(props.gitControls);
  const terminalMenu = threadTerminalMenu(props.gitControls, m);
  const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
  const filesAction: AppBarAction | null =
    props.hasThreadCwd && props.threadTools !== "hidden"
      ? {
          accessibilityLabel: filesVisible ? gt("Close files") : gt("Open files"),
          icon: "folder",
          selected: filesVisible,
          disabled: !props.gitControls.canOpenFiles,
          separateBackground: false,
          onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
        }
      : null;
  const workspaceMenus =
    props.threadTools === "hidden"
      ? []
      : [gitMenu, terminalMenu].filter((menu): menu is AppBarMenu => menu !== null);
  const groupTools = props.threadTools === "menu";
  const menus: ReadonlyArray<AppBarMenu> =
    groupTools && (workspaceMenus.length > 0 || filesAction)
      ? [
          {
            title: gt("Workspace"),
            icon: "ellipsis",
            items: [
              ...workspaceMenus.map((menu) => ({
                id: menu.title,
                title: menu.title,
                icon: typeof menu.icon === "string" ? menu.icon : menu.icon.ios,
                items: menu.items,
              })),
              ...(filesAction
                ? [
                    {
                      id: "files",
                      title: filesAction.accessibilityLabel,
                      icon: "folder",
                      selected: filesAction.selected,
                      disabled: filesAction.disabled,
                      onPress: filesAction.onPress,
                    },
                  ]
                : []),
            ],
          },
        ]
      : workspaceMenus;
  const actions =
    filesAction && !groupTools ? [...(props.actions ?? []), filesAction] : props.actions;

  return (
    <AppBar
      title={props.title}
      subtitle={props.subtitle}
      onBackToList={goBack}
      onCompose={props.draft ? undefined : startNewTask}
      backInSplitView={
        props.onReturnToThread
          ? {
              accessibilityLabel: gt("Return to chat"),
              icon: "chevron.left",
              onPress: props.onReturnToThread,
            }
          : undefined
      }
      actions={actions}
      menus={menus}
      hideBottomBorder
    />
  );
}
