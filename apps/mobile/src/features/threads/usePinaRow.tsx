import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useGT, useMessages, msg } from "gt-react-native";
import { mobilePreferencesAtom } from "../../state/preferences";
import { resolvePinaEnvironment } from "@t3tools/client-runtime/environment";
import { useEnvironmentsWithScope } from "../../state/session";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { useState } from "react";
import { useNavigation } from "@react-navigation/native";
import { Pressable, View } from "react-native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  AuthOrchestrationOperateScope,
  PINA_ASSISTANT_NAME,
  isNamedPinaConversation,
  isPinaThread,
  type EnvironmentId,
  type OpenPinaInput,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { PinaAvatar } from "../../components/PinaAvatar";
import { AppText as Text } from "../../components/ui/AppText";
import { IconButton } from "../../components/ui/IconButton";
import { Menu } from "../../components/ui/Menu";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentServerConfig, useServerConfigs } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { clearLegacyPinaSource } from "../../state/use-composer-drafts";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import {
  resolveThreadListV2RowStatus,
  resolveThreadListV2WokeAt,
  threadHasUnseenCompletion,
} from "./threadListV2";

import { STATUS_LABEL_BY_STATUS, DONE_STATUS_LABEL } from "./threadStatusLabels";

export function usePinaEnvironment(preferred?: EnvironmentId | null) {
  const environments = useWorkspaceEnvironments();
  const configs = useServerConfigs();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const saved = AsyncResult.isSuccess(preferences) ? preferences.value : undefined;
  const permitted = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const savedScope = saved?.threadListFilters?.environmentId;
  return resolvePinaEnvironment({
    requested:
      preferred ?? environments.find((env) => env.environmentId === savedScope)?.environmentId,
    preferred: environments.find(
      (env) => env.environmentId === saved?.lastThreadProject?.environmentId,
    )?.environmentId,
    connected: environments
      .filter((env) => env.connectionState === "connected")
      .map((env) => env.environmentId),
    permitted,
    configs,
  });
}

export function useOpenPina(
  environmentId: EnvironmentId | null,
  activeThread: ScopedThreadRef | null,
) {
  const config = useEnvironmentServerConfig(environmentId);
  const canOperate = useAtomValue(threadEnvironment.openPina.permissionAtom(environmentId));
  const ensure = useAtomCommand(threadEnvironment.openPina, { reportFailure: false });
  const selectDetail = useSelectWorkspaceDetail();
  const [opening, setOpening] = useState(false);
  if (!environmentId || !config?.environment.capabilities.pinaAssistant || !canOperate) {
    return null;
  }
  const openThread = (threadId: ThreadId) => {
    const target = { environmentId, threadId };
    clearLegacyPinaSource(target);
    selectDetail({ name: "Thread", params: target });
  };
  const openFromServer = (input: OpenPinaInput) => {
    setOpening(true);
    return ensure({ environmentId, input })
      .then((result) => {
        if (result._tag === "Success") {
          openThread(result.value.threadId);
        } else if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          Dialog.alert(PINA_ASSISTANT_NAME, errorDisplayMessage(error, m) ?? String(error));
        }
      })
      .finally(() => setOpening(false));
  };
  const open = () =>
    activeThread?.environmentId === environmentId && isPinaThread(activeThread.threadId)
      ? openThread(activeThread.threadId)
      : openFromServer({});
  return {
    environmentId,
    opening,
    supportsConversations: config.environment.capabilities.pinaConversations === true,
    open,
    openThread,
    create: (title: string) => openFromServer({ newConversation: { title, requestId: uuidv4() } }),
  };
}

export function usePinaRow(props: {
  readonly environmentId: EnvironmentId | null;
  readonly openThreadRef: ScopedThreadRef | null;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly conversations: readonly EnvironmentThreadShell[];
  readonly onArchive: (thread: EnvironmentThreadShell) => void;
  readonly onRename: (thread: EnvironmentThreadShell) => void;
  readonly environmentLabel?: string | null | undefined;
  readonly now: string;
  readonly horizontalMargin?: boolean | undefined;
}) {
  const pina = useOpenPina(props.environmentId, props.activeThreadRef);
  const gt = useGT();
  const resolve = useMessages();
  const navigation = useNavigation();
  if (!pina) return null;
  const selected =
    props.openThreadRef?.environmentId === pina.environmentId &&
    isPinaThread(props.openThreadRef.threadId);
  const current = selected
    ? props.conversations.find((thread) => thread.id === props.openThreadRef?.threadId)
    : undefined;
  const thread = selected
    ? current
    : props.conversations.find((conversation) => !isNamedPinaConversation(conversation.id));
  const title = current?.title ?? PINA_ASSISTANT_NAME;
  const status = thread ? resolveThreadListV2RowStatus(thread) : "ready";
  const woke = thread && !selected && resolveThreadListV2WokeAt(thread, { now: props.now });
  const statusIcon =
    STATUS_LABEL_BY_STATUS[status] ??
    (woke
      ? {
          icon: "bell.badge" as const,
          label: msg("Woke", { $context: "thread came back from snooze" }),
          iconTintClassName: "accent-foreground-muted",
        }
      : thread && !selected && threadHasUnseenCompletion(thread)
        ? DONE_STATUS_LABEL
        : null);
  const statusLabel = statusIcon?.label
    ? resolve(statusIcon.label)
    : status === "waiting"
      ? gt("Waiting", { $context: "thread status" })
      : status === "working"
        ? gt("Working", { $context: "thread status" })
        : null;
  return (
    <View className={`${props.horizontalMargin === false ? "" : "mx-2 "}flex-row items-center`}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[title, props.environmentLabel, statusLabel].filter(Boolean).join(", ")}
        disabled={pina.opening}
        accessibilityState={{
          disabled: pina.opening,
          selected,
        }}
        className={`min-h-14 min-w-0 flex-1 flex-row items-center gap-3 rounded-xl px-3 ${selected ? "bg-thread-selected" : "active:bg-thread-hover"}`}
        onPress={() => void pina.open()}
      >
        <PinaAvatar size={32} />
        <Text
          className={`min-w-0 flex-1 text-base font-semibold ${selected ? "text-thread-selected-foreground" : "text-drawer-foreground"}`}
          numberOfLines={1}
        >
          {title}
        </Text>
        {props.environmentLabel || statusIcon ? (
          <View className="flex-row items-center gap-2">
            {props.environmentLabel ? (
              <Text
                className={`text-xs ${selected ? "text-thread-selected-foreground-muted" : "text-drawer-foreground-muted"}`}
                numberOfLines={1}
              >
                {props.environmentLabel}
              </Text>
            ) : null}
            {statusIcon ? (
              <SymbolView
                name={statusIcon.icon}
                size={15}
                tintColorClassName={
                  selected ? "accent-thread-selected-foreground" : statusIcon.iconTintClassName
                }
              />
            ) : null}
          </View>
        ) : null}
      </Pressable>
      {pina.supportsConversations && (
        <Menu
          actions={[
            { id: "new", title: gt("New Pina conversation"), image: "plus" },
            ...props.conversations.map((item) => ({
              id: item.id,
              title: item.title,
              state: item.id === current?.id ? ("on" as const) : ("off" as const),
            })),
            ...(current && isNamedPinaConversation(current.id)
              ? [{ id: "rename", title: gt("Rename thread"), image: "pencil" }]
              : []),
            ...(current
              ? [{ id: "archive", title: gt("Archive conversation"), image: "archivebox" }]
              : []),
            { id: "history", title: gt("Archived conversations"), image: "archivebox" },
          ]}
          onPressAction={({ nativeEvent }) => {
            if (nativeEvent.event === "new") {
              Dialog.prompt({
                title: gt("New Pina conversation"),
                initialValue: "",
                confirmText: gt("Create"),
                onConfirm: (value) => {
                  const name = value.trim();
                  if (!name) return;
                  if (name.length > 120) {
                    Dialog.alert(
                      PINA_ASSISTANT_NAME,
                      gt("Conversation names can have up to 120 characters."),
                    );
                    return;
                  }
                  void pina.create(name);
                },
              });
            } else if (nativeEvent.event === "archive" && current) {
              props.onArchive(current);
            } else if (nativeEvent.event === "rename" && current) {
              props.onRename(current);
            } else if (nativeEvent.event === "history") {
              navigation.navigate("SettingsArchive");
            } else {
              const target = props.conversations.find((item) => item.id === nativeEvent.event);
              if (target) pina.openThread(target.id);
            }
          }}
        >
          <IconButton
            icon="chevron.down"
            accessibilityLabel={gt("Pina conversations")}
            disabled={pina.opening}
          />
        </Menu>
      )}
    </View>
  );
}
