import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { resolvePinaEnvironment, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  AuthOrchestrationOperateScope,
  PINA_ASSISTANT_NAME,
  isPinaThread,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  formatComposerContextReference,
  threadContextRecord,
} from "@t3tools/shared/composerContextReferences";
import { composerDraftHasUserContent, useComposerDraftStore } from "../composerDraftStore";
import { useServerConfigs } from "../state/entities";
import {
  useConnectedEnvironmentIds,
  useEnvironmentIdentities,
  usePrimaryEnvironmentId,
} from "../state/environments";
import { useEnvironmentsWithScope } from "../state/session";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { m } from "../i18n/messages";
import { toastManager } from "../components/ui/toast";

export function useOpenPina(
  source: Pick<EnvironmentThreadShell, "id" | "title" | "environmentId"> | null | undefined,
  preferred?: EnvironmentId | null,
) {
  const primary = usePrimaryEnvironmentId();
  const connected = useConnectedEnvironmentIds();
  const configs = useServerConfigs();
  const permitted = useEnvironmentsWithScope(
    useEnvironmentIdentities(),
    AuthOrchestrationOperateScope,
  );
  const environmentId = resolvePinaEnvironment({
    requested: source?.environmentId ?? preferred,
    preferred: primary,
    connected,
    configs,
    permitted,
  });
  const canOperate = useAtomValue(threadEnvironment.openPina.permissionAtom(environmentId));
  const ensure = useAtomCommand(threadEnvironment.openPina, { reportFailure: false });
  const navigate = useNavigate();
  if (environmentId === null || !canOperate) return null;
  const open = async () => {
    const result = await ensure({ environmentId, input: {} });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result))
        toastManager.add({
          type: "error",
          title: PINA_ASSISTANT_NAME,
          description: thrownErrorMessage(squashAtomCommandFailure(result), m) ?? undefined,
        });
      return;
    }
    const target = scopeThreadRef(environmentId, result.value.threadId);
    if (source && source.environmentId === environmentId && !isPinaThread(source.id)) {
      const store = useComposerDraftStore.getState();
      const existingDraft = store.getComposerDraft(target);
      const previous = existingDraft?.threadContexts[0];
      const record = threadContextRecord(
        scopeThreadRef(source.environmentId, source.id),
        source.title,
      );
      if (
        existingDraft &&
        previous &&
        existingDraft.threadContexts.length === 1 &&
        existingDraft.prompt.trim() === formatComposerContextReference(previous) &&
        !composerDraftHasUserContent({ ...existingDraft, prompt: "", threadContexts: [] })
      ) {
        store.setThreadContexts(target, [record]);
      } else {
        store.addThreadContexts(target, [record], { insertAtCaret: false });
      }
    }
    await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(target) });
  };
  return { environmentId, open };
}
