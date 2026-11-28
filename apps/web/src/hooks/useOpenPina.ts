import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { resolvePinaEnvironment, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  PINA_ASSISTANT_NAME,
  isPinaThread,
  type EnvironmentId,
  type OpenPinaInput,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { readThreadShell, useServerConfigs } from "../state/entities";
import { useComposerDraftStore } from "../composerDraftStore";
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
import { randomUUID } from "../lib/utils";

export function useOpenPina(
  preferred: EnvironmentId | null | undefined,
  sourceThread: ScopedThreadRef | null,
) {
  const primary = usePrimaryEnvironmentId();
  const connected = useConnectedEnvironmentIds();
  const configs = useServerConfigs();
  const permitted = useEnvironmentsWithScope(
    useEnvironmentIdentities(),
    AuthOrchestrationOperateScope,
  );
  const environmentId = resolvePinaEnvironment({
    requested: preferred,
    preferred: primary,
    connected,
    configs,
    permitted,
  });
  const canOperate = useAtomValue(threadEnvironment.openPina.permissionAtom(environmentId));
  const ensure = useAtomCommand(threadEnvironment.openPina, { reportFailure: false });
  const navigate = useNavigate();
  if (environmentId === null || !canOperate) return null;
  const supportsConversations =
    configs.get(environmentId)?.environment.capabilities.pinaConversations === true;
  const openThread = async (threadId: ThreadId) => {
    const target = scopeThreadRef(environmentId, threadId);
    useComposerDraftStore.getState().setPinaSourceThread(
      target,
      sourceThread === null
        ? null
        : {
            ref: sourceThread,
            title: readThreadShell(sourceThread)?.title ?? sourceThread.threadId,
          },
    );
    await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(target) });
  };
  const openFromServer = async (input: OpenPinaInput) => {
    const result = await ensure({ environmentId, input });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result))
        toastManager.add({
          type: "error",
          title: PINA_ASSISTANT_NAME,
          description: thrownErrorMessage(squashAtomCommandFailure(result), m) ?? undefined,
        });
      return false;
    }
    await openThread(result.value.threadId);
    return true;
  };
  const open = async () => {
    if (sourceThread?.environmentId === environmentId && isPinaThread(sourceThread.threadId)) {
      await openThread(sourceThread.threadId);
    } else {
      await openFromServer({});
    }
  };
  return {
    environmentId,
    supportsConversations,
    open,
    openThread,
    create: (title: string) =>
      openFromServer({ newConversation: { title, requestId: randomUUID() } }),
  };
}
