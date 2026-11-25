import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { resolvePinaEnvironment, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  PINA_ASSISTANT_NAME,
  type EnvironmentId,
} from "@t3tools/contracts";
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

export function useOpenPina(preferred?: EnvironmentId | null) {
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
    await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(target) });
  };
  return { environmentId, open };
}
