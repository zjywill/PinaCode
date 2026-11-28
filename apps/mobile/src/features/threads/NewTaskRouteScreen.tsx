import { isDraftThreadRoute } from "./thread-route-state";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  PINA_ASSISTANT_NAME,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react-native";
import * as Dialog from "../../components/ui/Dialog";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { NavigationRow } from "../../components/ui/NavigationRow";
import { AppBar } from "../../components/ui/AppBar";
import {
  StackActions,
  useFocusEffect,
  useIsFocused,
  useNavigation,
  useRoute,
  type StaticScreenProps,
} from "@react-navigation/native";
import { SymbolView } from "../../components/ui/AppSymbol";
import { pickableProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cn } from "../../lib/cn";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { runtimeConnectionErrorText } from "../connection/environmentStatusText";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { AppText as Text } from "../../components/ui/AppText";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { PinaAvatar } from "../../components/PinaAvatar";
import { useProjects, useServerConfigs } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { threadEnvironment } from "../../state/threads";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { retargetSavedNewTaskDraft } from "../../state/use-composer-drafts";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import type { WorkspaceState } from "../../state/workspaceModel";
import type { MessageResolver } from "../../i18n/messages";
import { useWorkspaceState } from "../../state/workspace";

import {
  handIncomingShareToDraft,
  incomingShareImports,
  useIncomingShare,
} from "../sharing/IncomingShareProvider";
import { idleShareFlagAtom, idleShareImportPhaseAtom } from "./incomingShareImport";
import { useNewTaskFlow } from "./new-task-flow-provider";
import {
  filterProjectScopes,
  getProjectScopeSelectionTarget,
  resolveNewTaskScratchOption,
} from "./new-task-project-selection";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";

type NewTaskRouteParams = {
  readonly incomingShareId?: string | string[];
  /** An existing draft whose project is gone; the chosen project takes it over. */
  readonly draftId?: string | string[];
  readonly prompt?: string | string[];
  readonly repo?: string | string[];
  readonly pr?: string | string[];
  readonly provider?: string | string[];
  readonly model?: string | string[];
};

const NO_ENVIRONMENTS = [] as const;

function deriveProjectEmptyState(
  catalogState: WorkspaceState,
  resolve: MessageResolver,
): {
  readonly title: string;
  readonly detail: string;
  readonly loading: boolean;
} {
  if (catalogState.isLoadingConnections) {
    return {
      title: resolve(msg("Loading environments")),
      detail: resolve(msg("Checking saved environments on this device.")),
      loading: true,
    };
  }

  if (!catalogState.hasConnections) {
    return {
      title: resolve(msg("No environments connected")),
      detail: resolve(msg("Add an environment before creating a task.")),
      loading: false,
    };
  }

  if (
    (catalogState.connectionState === "available" ||
      catalogState.connectionState === "offline" ||
      catalogState.connectionState === "error" ||
      catalogState.connectionState === "unsupported") &&
    !catalogState.hasLoadedShellSnapshot
  ) {
    return {
      title:
        catalogState.connectionState === "unsupported"
          ? resolve(msg("Client not supported"))
          : resolve(msg("Environment unavailable")),
      detail:
        runtimeConnectionErrorText(catalogState, resolve) ??
        resolve(
          msg(
            "The saved environment is offline. Check the URL or start the environment, then retry.",
          ),
        ),
      loading: false,
    };
  }

  if (
    catalogState.hasConnectingEnvironment &&
    !catalogState.hasLoadedShellSnapshot &&
    catalogState.connectionError === null
  ) {
    return {
      title: resolve(msg("Connecting to environment")),
      detail: resolve(msg("Loading projects from the saved environment.")),
      loading: true,
    };
  }

  return {
    title: resolve(msg("No projects found")),
    detail: resolve(msg("The connected environment did not report any projects.")),
    loading: false,
  };
}

function NewTaskHeader(props: {
  readonly title: string;
  readonly canAddProject: boolean;
  readonly onCancelImport?: (() => void) | undefined;
  readonly searchText: string;
  readonly onSearchTextChange: (text: string) => void;
}) {
  const gt = useGT();
  const navigation = useNavigation();
  const goBack = () => {
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.getParent()?.goBack();
  };
  return (
    <>
      <AppBar
        title={props.title}
        hideBottomBorder
        onBack={goBack}
        actions={
          props.onCancelImport
            ? [
                {
                  accessibilityLabel: gt("Cancel import"),
                  icon: "xmark",
                  onPress: props.onCancelImport,
                },
              ]
            : props.canAddProject
              ? [
                  {
                    accessibilityLabel: gt("Add project"),
                    icon: "plus",
                    onPress: () => navigation.dispatch(StackActions.push("AddProject")),
                  },
                ]
              : []
        }
        search={{
          value: props.searchText,
          onChangeText: props.onSearchTextChange,
          placeholder: gt("Search projects"),
        }}
      />
    </>
  );
}

export function NewTaskRouteScreen({ route }: StaticScreenProps<NewTaskRouteParams | undefined>) {
  const gt = useGT();
  const m = useMessages();
  const projects = useProjects();
  const [searchText, setSearchText] = useState("");
  const { projectScopes, selectedEnvironmentId, setProject } = useNewTaskFlow();
  const { state: catalogState } = useWorkspaceState();
  const navigation = useNavigation();
  const routeKey = useRoute().key;
  const selectDetail = useSelectWorkspaceDetail();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { getShare, discardShare, releaseShareReservation } = useIncomingShare();
  const routeShareId = Array.isArray(route.params?.incomingShareId)
    ? route.params.incomingShareId[0]
    : route.params?.incomingShareId;
  const incomingShare = routeShareId ? getShare(routeShareId) : null;
  const routeDraftId = Array.isArray(route.params?.draftId)
    ? route.params.draftId[0]
    : route.params?.draftId;
  const screenTitle = incomingShare ? gt("Share to") : gt("Choose project");
  const projectEmptyState = deriveProjectEmptyState(catalogState, m);
  const serverConfigs = useServerConfigs();
  const listScopes = pickableProjectGroups(projectScopes).filter(
    (scope) =>
      !scope.projects.every((project) =>
        isScratchProject(project, serverConfigs.get(project.environmentId)?.scratchWorkspaceRoot),
      ),
  );
  const visibleScopes = filterProjectScopes(listScopes, searchText);
  const resumedDestinationKeyRef = useRef<string | null>(null);
  const reservation = incomingShare?.destination;
  const reservedProject = reservation && "projectId" in reservation ? reservation : null;
  const reservedDestinationProject = reservedProject
    ? (projects.find(
        (project) =>
          project.environmentId === reservedProject.environmentId &&
          project.id === reservedProject.projectId,
      ) ?? null)
    : null;
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const connectedEnvironmentIds = new Set(
    connectedEnvironments
      .filter((environment) => environment.connectionState === "connected")
      .map((environment) => environment.environmentId),
  );
  const permittedPinaEnvironments = useEnvironmentsWithScope(
    routeShareId ? connectedEnvironments : NO_ENVIRONMENTS,
    AuthOrchestrationOperateScope,
  );
  const pinaEnvironments = connectedEnvironments.filter(
    ({ environmentId, connectionState }) =>
      connectionState === "connected" &&
      permittedPinaEnvironments.has(environmentId) &&
      serverConfigs.get(environmentId)?.environment.capabilities.pinaAssistant === true,
  );
  const openPina = useAtomCommand(threadEnvironment.openPina, { reportFailure: false });
  const pendingPinaRef = useRef<AbortController | null>(null);
  const [openingPina, setOpeningPina] = useState(false);
  const [discardingShare, setDiscardingShare] = useState(false);
  const [selectedPina, setSelectedPina] = useState<ScopedThreadRef | null>(null);
  const reservedPina =
    reservation && "threadId" in reservation
      ? {
          environmentId: EnvironmentId.make(reservation.environmentId),
          threadId: ThreadId.make(reservation.threadId),
        }
      : null;
  const pinaTarget = reservedPina ?? selectedPina;
  const canResumePina = pinaEnvironments.some(
    (environment) => environment.environmentId === pinaTarget?.environmentId,
  );
  const pinaImportTarget =
    isFocused && routeShareId && incomingShare && pinaTarget && canResumePina
      ? {
          flowKey: routeKey,
          routeKey,
          draftKey: scopedThreadKey(pinaTarget.environmentId, pinaTarget.threadId),
          destination: pinaTarget,
          shareId: routeShareId,
        }
      : null;
  useAtomValue(
    pinaImportTarget === null
      ? idleShareImportPhaseAtom
      : incomingShareImports.phaseAtom(pinaImportTarget),
  );
  const isImportingPina = useAtomValue(
    routeShareId ? incomingShareImports.inFlightAtom(routeKey) : idleShareFlagAtom,
  );
  const choosingShareTarget = openingPina || isImportingPina || discardingShare;
  const openScratch = useAtomCommand(projectEnvironment.openScratch, {
    reportFailure: false,
  });
  const scratchOption =
    reservedDestinationProject === null && reservedPina === null
      ? resolveNewTaskScratchOption({
          environments: connectedEnvironments,
          serverConfigs,
          selectedEnvironmentId,
        })
      : null;
  const canStartScratch = scratchOption?.ready === true && !choosingShareTarget;
  const pendingScratchRef = useRef<AbortController | null>(null);
  const cancelPendingScratch = useCallback(() => {
    pendingScratchRef.current?.abort();
    pendingScratchRef.current = null;
  }, []);
  useFocusEffect(useCallback(() => cancelPendingScratch, [cancelPendingScratch]));
  useFocusEffect(
    useCallback(
      () => () => {
        pendingPinaRef.current?.abort();
      },
      [],
    ),
  );

  async function choosePina(environmentId: EnvironmentId): Promise<void> {
    if (!incomingShare || pendingPinaRef.current || choosingShareTarget || reservedPina) return;
    cancelPendingScratch();
    const request = new AbortController();
    pendingPinaRef.current = request;
    setOpeningPina(true);
    const result = await openPina({ environmentId, input: {} });
    pendingPinaRef.current = null;
    setOpeningPina(false);
    if (request.signal.aborted) return;
    if (result._tag === "Success") {
      setSelectedPina({ environmentId, threadId: result.value.threadId });
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(PINA_ASSISTANT_NAME, errorDisplayMessage(error, m) ?? String(error));
    }
  }

  async function cancelImport() {
    if (!incomingShare || incomingShare.destination || choosingShareTarget) return;
    cancelPendingScratch();
    setDiscardingShare(true);
    try {
      await discardShare(incomingShare);
      if (navigation.isFocused()) navigation.goBack();
    } catch (error) {
      Dialog.alert(
        gt("Could not cancel import"),
        errorDisplayMessage(error, m) ?? gt("The shared content could not be restored safely."),
      );
    }
    setDiscardingShare(false);
  }

  async function selectProject(project: EnvironmentProject, signal?: AbortSignal): Promise<void> {
    if (choosingShareTarget || pendingPinaRef.current || reservedPina) return;
    if (incomingShare && reservedProject && !reservedDestinationProject) {
      try {
        await releaseShareReservation(incomingShare.id, reservedProject);
      } catch (error) {
        if (signal?.aborted) return;
        Dialog.alert(
          gt("Could not change project"),
          errorDisplayMessage(error, m) ??
            gt("The shared content reservation could not be updated."),
        );
        return;
      }
      if (signal?.aborted) return;
    }
    const root = navigation.getState()?.routeNames.includes("NewTaskProject")
      ? navigation
      : navigation.getParent();
    const rootState = root?.getState();
    const threadRoute = rootState?.routes[rootState.index - 1];
    if (
      routeDraftId === undefined &&
      isDraftThreadRoute(threadRoute) &&
      threadRoute &&
      (!incomingShare || handIncomingShareToDraft(threadRoute, incomingShare.id))
    ) {
      setProject(project);
      root?.goBack();
      return;
    }
    // Restamp only on choice, so backing out leaves the draft as it was.
    const retargeted =
      routeDraftId === undefined
        ? false
        : await retargetSavedNewTaskDraft(
            routeDraftId,
            { environmentId: project.environmentId, projectId: project.id },
            signal,
          ).then(
            (found) => found,
            () => null,
          );
    if (signal?.aborted) return;
    if (retargeted === null) {
      Dialog.alert(
        gt("Could not change project"),
        gt("Saved drafts could not be loaded. Try again."),
      );
      return;
    }
    const draftId = retargeted ? routeDraftId : undefined;
    selectDetail({
      name: "Thread",
      params: {
        draft: {
          environmentId: String(project.environmentId),
          projectId: String(project.id),
          draftId,
          incomingShareId: incomingShare?.id,
        },
      },
    });
  }

  function chooseProject(project: EnvironmentProject): void {
    cancelPendingScratch();
    void selectProject(project);
  }

  async function startScratch(): Promise<void> {
    if (!canStartScratch || !scratchOption || pendingScratchRef.current) return;
    const environmentId = scratchOption.environmentId;
    const request = new AbortController();
    pendingScratchRef.current = request;
    const result = await openScratch({ environmentId, input: {} });
    if (request.signal.aborted) return;
    if (result._tag === "Failure") {
      pendingScratchRef.current = null;
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Dialog.alert(
          gt("Could not start without a project"),
          errorDisplayMessage(error, m) ??
            gt("The folder for threads without a project could not be created."),
        );
      }
      return;
    }
    await selectProject(result.value, request.signal);
    if (pendingScratchRef.current === request) pendingScratchRef.current = null;
  }

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- navigates to the incoming share's reserved destination draft once its project loads and the screen is focused
  useEffect(() => {
    if (!incomingShare || !reservedProject) {
      resumedDestinationKeyRef.current = null;
      return;
    }
    if (!isFocused) {
      // Reset on return so reserved-draft resume can retry without leaving project rows disabled.
      resumedDestinationKeyRef.current = null;
      return;
    }
    const destinationKey = `${incomingShare.id}:${reservedProject.environmentId}:${reservedProject.projectId}`;
    if (resumedDestinationKeyRef.current === destinationKey) {
      return;
    }
    if (!reservedDestinationProject) {
      return;
    }
    resumedDestinationKeyRef.current = destinationKey;
    selectDetail({
      name: "Thread",
      params: {
        draft: {
          environmentId: reservedDestinationProject.environmentId,
          projectId: reservedDestinationProject.id,
          title: reservedDestinationProject.title,
          incomingShareId: incomingShare.id,
        },
      },
    });
  }, [incomingShare, isFocused, reservedDestinationProject, reservedProject, selectDetail]);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NewTaskHeader
        title={screenTitle}
        canAddProject={catalogState.hasReadyEnvironment && !choosingShareTarget}
        onCancelImport={
          incomingShare && !incomingShare.destination && !choosingShareTarget
            ? () => void cancelImport()
            : undefined
        }
        searchText={searchText}
        onSearchTextChange={setSearchText}
      />

      <ScreenContent>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          className="flex-1"
          contentContainerStyle={{
            gap: Platform.OS === "android" ? 8 : 12,
            paddingBottom: Math.max(insets.bottom, 18) + 18,
            paddingHorizontal: Platform.OS === "android" ? 16 : 20,
            paddingTop: Platform.OS === "android" ? 16 : 8,
            ...(Platform.OS === "android" && visibleScopes.length === 0
              ? { flexGrow: 1, justifyContent: "center" as const }
              : {}),
          }}
        >
          {incomingShare &&
          !reservedDestinationProject &&
          !reservedPina &&
          pinaEnvironments.length > 0 ? (
            <View collapsable={false} className="overflow-hidden rounded-[24px] bg-grouped-card">
              {pinaEnvironments.map(({ environmentId, environmentLabel }, index) => (
                <NavigationRow
                  key={environmentId}
                  className={cn("bg-grouped-card", index > 0 && "border-t border-border-subtle")}
                  title={gt("Ask Pina")}
                  subtitle={environmentLabel}
                  leading={<PinaAvatar size={24} />}
                  disabled={choosingShareTarget}
                  onPress={() => void choosePina(environmentId)}
                />
              ))}
            </View>
          ) : null}
          {incomingShare && (openingPina || isImportingPina || reservedPina) ? (
            <View className="items-center gap-2 py-3">
              {(openingPina || isImportingPina) && (
                <AppActivityIndicator colorClassName="accent-icon-muted" />
              )}
              <Text textRole="footnote" className="text-foreground-muted">
                {reservedPina && !canResumePina
                  ? gt("Waiting for the selected environment")
                  : gt("Importing shared content…")}
              </Text>
            </View>
          ) : null}
          {scratchOption !== null && listScopes.length > 0 ? (
            Platform.OS === "android" ? (
              <View collapsable={false} className="overflow-hidden rounded-[28px] bg-grouped-card">
                <NavigationRow
                  className="bg-grouped-card"
                  title={gt("No project")}
                  subtitle={gt("Start a task without a project")}
                  disabled={!canStartScratch}
                  onPress={() => void startScratch()}
                  leading={
                    <SymbolView
                      name="text.bubble"
                      size={22}
                      tintColorClassName="accent-icon-muted"
                      type="monochrome"
                    />
                  }
                />
              </View>
            ) : (
              <View collapsable={false} className="overflow-hidden rounded-[24px] bg-grouped-card">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={gt("No project")}
                  disabled={!canStartScratch}
                  onPress={() => void startScratch()}
                  className={cn(
                    "flex-row items-center gap-3 bg-grouped-card px-4 py-3.5",
                    !canStartScratch && "opacity-45",
                  )}
                >
                  <View className="h-7 w-7 items-center justify-center">
                    <SymbolView
                      name="text.bubble"
                      size={18}
                      tintColorClassName="accent-icon-muted"
                      type="monochrome"
                    />
                  </View>
                  <View className="min-w-0 flex-1">
                    <Text className="text-base font-t3-bold leading-snug">
                      <T>No project</T>
                    </Text>
                    <Text className="text-xs leading-snug text-foreground-muted" numberOfLines={1}>
                      <T>Start a task without a project</T>
                    </Text>
                  </View>
                  <SymbolView
                    name="chevron.right"
                    size={14}
                    tintColorClassName="accent-chevron"
                    type="monochrome"
                  />
                </Pressable>
              </View>
            )
          ) : null}
          {listScopes.length === 0 ? (
            <View
              collapsable={false}
              className={cn(
                "items-center gap-3 px-6 py-8",
                Platform.OS !== "android" && "rounded-[24px] bg-grouped-card",
              )}
            >
              {projectEmptyState.loading ? (
                <AppActivityIndicator colorClassName="accent-icon-muted" />
              ) : null}
              <Text className="text-center text-lg font-t3-bold text-foreground">
                {projectEmptyState.title}
              </Text>
              <Text className="text-center text-sm leading-normal text-foreground-muted">
                {projectEmptyState.detail}
              </Text>
              {Platform.OS === "android" ? (
                <>
                  <View>
                    <Button
                      label={
                        catalogState.hasReadyEnvironment
                          ? gt("Add new project")
                          : gt("Add environment")
                      }
                      tone="primary"
                      onPress={() =>
                        catalogState.hasReadyEnvironment
                          ? navigation.dispatch(StackActions.push("AddProject"))
                          : navigation.navigate("ConnectionsNew")
                      }
                    />
                  </View>
                  {canStartScratch ? (
                    <View>
                      <Button
                        label={gt("Start without a project")}
                        tone="secondary"
                        onPress={() => void startScratch()}
                      />
                    </View>
                  ) : null}
                </>
              ) : !catalogState.hasReadyEnvironment ? (
                <View className="mt-1">
                  <Button
                    label={gt("Add environment")}
                    tone="primary"
                    onPress={() => navigation.navigate("ConnectionsNew")}
                  />
                </View>
              ) : (
                <>
                  <View className="mt-1">
                    <Button
                      label={gt("Add new project")}
                      tone="primary"
                      onPress={() => navigation.dispatch(StackActions.push("AddProject"))}
                    />
                  </View>
                  {canStartScratch ? (
                    <View>
                      <Button
                        label={gt("Start without a project")}
                        tone="secondary"
                        onPress={() => void startScratch()}
                      />
                    </View>
                  ) : null}
                </>
              )}
            </View>
          ) : visibleScopes.length === 0 ? (
            <View className="items-center gap-2 px-6 py-8">
              <Text className="text-center text-lg font-t3-bold text-foreground">
                <T>No matching projects</T>
              </Text>
              <Text className="text-center text-sm leading-normal text-foreground-muted">
                <T>Try a different project name or workspace path.</T>
              </Text>
            </View>
          ) : (
            <View
              collapsable={false}
              className={
                Platform.OS === "android"
                  ? "overflow-hidden rounded-[28px] bg-grouped-card"
                  : "overflow-hidden rounded-[24px] bg-grouped-card"
              }
            >
              {visibleScopes.map((scope, scopeIndex) => {
                const hasMultipleProjects = scope.projects.length > 1;
                const selectionTarget = getProjectScopeSelectionTarget(
                  scope,
                  selectedEnvironmentId,
                  connectedEnvironmentIds,
                );
                if (Platform.OS === "android") {
                  return (
                    <NavigationRow
                      className="bg-grouped-card"
                      key={scope.key}
                      title={scope.title}
                      subtitle={
                        hasMultipleProjects
                          ? gt("{count, plural, other {{count} workspaces}}", {
                              count: scope.projects.length,
                            })
                          : selectionTarget.workspaceRoot
                      }
                      subtitleNumberOfLines={1}
                      subtitleEllipsizeMode="middle"
                      disabled={
                        reservedDestinationProject !== null ||
                        reservedPina !== null ||
                        choosingShareTarget
                      }
                      onPress={() => chooseProject(selectionTarget)}
                      leading={
                        <ProjectFavicon
                          environmentId={scope.representative.environmentId}
                          faviconPath={scope.representative.faviconPath}
                          projectIcon={scope.representative.projectIcon}
                          size={24}
                          projectTitle={scope.representative.title}
                          workspaceRoot={scope.representative.workspaceRoot}
                        />
                      }
                    />
                  );
                }
                return (
                  <View
                    key={scope.key}
                    className={cn(scopeIndex > 0 && "border-t border-border-subtle")}
                  >
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={scope.title}
                      disabled={
                        reservedDestinationProject !== null ||
                        reservedPina !== null ||
                        choosingShareTarget
                      }
                      onPress={() => chooseProject(selectionTarget)}
                      className="flex-row items-center gap-3 bg-grouped-card px-4 py-3.5"
                    >
                      <View className="h-7 w-7 items-center justify-center">
                        <ProjectFavicon
                          environmentId={scope.representative.environmentId}
                          faviconPath={scope.representative.faviconPath}
                          projectIcon={scope.representative.projectIcon}
                          size={20}
                          projectTitle={scope.representative.title}
                          workspaceRoot={scope.representative.workspaceRoot}
                        />
                      </View>
                      <View className="min-w-0 flex-1">
                        <Text className={cn("text-base leading-snug", "font-t3-bold")}>
                          {scope.title}
                        </Text>
                        <Text
                          className="text-xs leading-snug text-foreground-muted"
                          ellipsizeMode="middle"
                          numberOfLines={1}
                        >
                          {hasMultipleProjects
                            ? gt("{count, plural, other {{count} workspaces}}", {
                                count: scope.projects.length,
                              })
                            : selectionTarget.workspaceRoot}
                        </Text>
                      </View>
                      <SymbolView
                        name="chevron.right"
                        size={14}
                        tintColorClassName="accent-chevron"
                        type="monochrome"
                      />
                    </Pressable>
                  </View>
                );
              })}
            </View>
          )}
        </ScrollView>
      </ScreenContent>
    </View>
  );
}
