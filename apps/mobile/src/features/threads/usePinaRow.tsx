import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useGT, useMessages, msg } from "gt-react-native";
import { mobilePreferencesAtom } from "../../state/preferences";
import { resolvePinaEnvironment } from "@t3tools/client-runtime/environment";
import { useEnvironmentsWithScope } from "../../state/session";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { useState } from "react";
import { Pressable, View } from "react-native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  AuthOrchestrationOperateScope,
  PINA_ASSISTANT_NAME,
  isPinaThread,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { useEnvironmentServerConfig, useServerConfigs } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
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

export function useOpenPina(environmentId: EnvironmentId | null) {
  const config = useEnvironmentServerConfig(environmentId);
  const canOperate = useAtomValue(threadEnvironment.openPina.permissionAtom(environmentId));
  const ensure = useAtomCommand(threadEnvironment.openPina, { reportFailure: false });
  const selectDetail = useSelectWorkspaceDetail();
  const [opening, setOpening] = useState(false);
  if (!environmentId || !config?.environment.capabilities.pinaAssistant || !canOperate) {
    return null;
  }
  const openThread = async () => {
    const result = await ensure({ environmentId, input: {} });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) throw squashAtomCommandFailure(result);
      return;
    }
    const { threadId } = result.value;
    selectDetail({ name: "Thread", params: { environmentId, threadId } });
  };
  const open = () => {
    setOpening(true);
    return openThread()
      .catch((error: unknown) => {
        Dialog.alert(PINA_ASSISTANT_NAME, errorDisplayMessage(error, m) ?? String(error));
      })
      .finally(() => setOpening(false));
  };
  return { environmentId, opening, open };
}

export function usePinaRow(props: {
  readonly environmentId: EnvironmentId | null;
  readonly openThreadRef: ScopedThreadRef | null;
  readonly thread?: EnvironmentThreadShell | undefined;
  readonly environmentLabel?: string | null | undefined;
  readonly now: string;
  readonly horizontalMargin?: boolean | undefined;
}) {
  const pina = useOpenPina(props.environmentId);
  const gt = useGT();
  const resolve = useMessages();
  if (!pina) return null;
  const selected =
    props.openThreadRef?.environmentId === pina.environmentId &&
    isPinaThread(props.openThreadRef.threadId);
  const status = props.thread ? resolveThreadListV2RowStatus(props.thread) : "ready";
  const woke =
    props.thread && !selected && resolveThreadListV2WokeAt(props.thread, { now: props.now });
  const statusIcon =
    STATUS_LABEL_BY_STATUS[status] ??
    (woke
      ? {
          icon: "bell.badge" as const,
          label: msg("Woke", { $context: "thread came back from snooze" }),
          iconTintClassName: "accent-foreground-muted",
        }
      : props.thread && !selected && threadHasUnseenCompletion(props.thread)
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
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[PINA_ASSISTANT_NAME, props.environmentLabel, statusLabel]
        .filter(Boolean)
        .join(", ")}
      disabled={pina.opening}
      accessibilityState={{
        disabled: pina.opening,
        selected,
      }}
      className={`${props.horizontalMargin === false ? "" : "mx-2 "}min-h-12 flex-row items-center gap-3 rounded-xl px-3 ${selected ? "bg-thread-selected" : "active:bg-thread-hover"}`}
      onPress={() => void pina.open()}
    >
      <SymbolView
        name="bubble.left.and.bubble.right"
        size={20}
        tintColorClassName={selected ? "accent-thread-selected-foreground" : "accent-icon-muted"}
      />
      <Text
        className={`min-w-0 flex-1 text-base font-semibold ${selected ? "text-thread-selected-foreground" : "text-drawer-foreground"}`}
        numberOfLines={1}
      >
        {PINA_ASSISTANT_NAME}
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
  );
}
