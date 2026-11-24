import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useGT, useMessages, msg } from "gt-react-native";
import { mobilePreferencesAtom } from "../../state/preferences";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { useState } from "react";
import { Pressable, View } from "react-native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { PINA_ASSISTANT_NAME, isPinaThread, type EnvironmentId } from "@t3tools/contracts";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  formatComposerContextReference,
  threadContextRecord,
} from "@t3tools/shared/composerContextReferences";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useEnvironmentServerConfig, useServerConfigs } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  getComposerDraftSnapshot,
  insertComposerDraftContext,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
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
  const available = environments.filter(
    (env) =>
      env.connectionState === "connected" &&
      configs.get(env.environmentId)?.environment.capabilities.pinaAssistant,
  );
  const target = preferred ?? saved?.threadListFilters?.environmentId;
  if (target) return available.some((env) => env.environmentId === target) ? target : null;
  return (
    available.find((env) => env.environmentId === saved?.lastThreadProject?.environmentId)
      ?.environmentId ??
    available[0]?.environmentId ??
    null
  );
}

export function useOpenPina(props: {
  readonly environmentId: EnvironmentId | null;
  readonly source:
    | Pick<EnvironmentThreadShell, "id" | "title" | "environmentId">
    | null
    | undefined;
}) {
  const environmentId = props.environmentId;
  const config = useEnvironmentServerConfig(environmentId);
  const canOperate = useAtomValue(threadEnvironment.openPina.permissionAtom(environmentId));
  const ensure = useAtomCommand(threadEnvironment.openPina, { reportFailure: false });
  const selectDetail = useSelectWorkspaceDetail();
  const [opening, setOpening] = useState(false);
  if (!environmentId || !config?.environment.capabilities.pinaAssistant || !canOperate) {
    return null;
  }
  const open = async () => {
    setOpening(true);
    try {
      const result = await ensure({ environmentId, input: {} });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) throw squashAtomCommandFailure(result);
        return;
      }
      const { threadId } = result.value;
      const source = props.source;
      if (source?.environmentId === environmentId && !isPinaThread(source.id)) {
        await waitForComposerDraftsLoaded();
        const key = scopedThreadKey(environmentId, threadId);
        const draft = getComposerDraftSnapshot(key);
        const record = threadContextRecord({ environmentId, threadId: source.id }, source.title);
        const records = draft.context?.records ?? [];
        const previous = records[0];
        if (!records.some((entry) => entry.contextId === record.contextId)) {
          const replacePrevious =
            previous?.kind === "thread" &&
            records.length === 1 &&
            draft.attachments.length === 0 &&
            draft.text.trim() === formatComposerContextReference(previous);
          insertComposerDraftContext(
            key,
            {
              text: formatComposerContextReference(record),
              context: { version: 1, records: [record] },
            },
            {
              text: draft.text,
              start: replacePrevious ? 0 : draft.text.length,
              end: draft.text.length,
            },
          );
        }
      }
      selectDetail({ name: "Thread", params: { environmentId, threadId } });
    } catch (error) {
      Dialog.alert(PINA_ASSISTANT_NAME, errorDisplayMessage(error, m) ?? String(error));
    } finally {
      setOpening(false);
    }
  };
  return { environmentId, opening, open };
}

export function usePinaRow(props: {
  readonly environmentId: EnvironmentId | null;
  readonly source: EnvironmentThreadShell | undefined;
  readonly thread?: EnvironmentThreadShell | undefined;
  readonly environmentLabel?: string | null | undefined;
  readonly now: string;
  readonly horizontalMargin?: boolean | undefined;
}) {
  const pina = useOpenPina({ environmentId: props.environmentId, source: props.source });
  const gt = useGT();
  const resolve = useMessages();
  if (!pina) return null;
  const selected =
    props.source?.environmentId === pina.environmentId && isPinaThread(props.source.id);
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
