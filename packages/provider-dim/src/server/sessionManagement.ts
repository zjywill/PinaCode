import { AcpRegistryOperationError } from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import type { DimDaemonFailure } from "./daemon.ts";
import { readDimSessionPage } from "./sessions.ts";
import type { DimConnection } from "./transport.ts";

export function makeDimSessionManagement(daemon: {
  readonly connect: (
    clientName: string,
  ) => Effect.Effect<DimConnection, DimDaemonFailure, Scope.Scope>;
}): NonNullable<ProviderInstance["acpSessionManagement"]> {
  return {
    listSessions: (input) =>
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* daemon.connect("T3 Code session list");
          const page = yield* readDimSessionPage(
            (method, params) => connection.request(method, params),
            {
              cwd: input.cwd,
              ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            },
          );
          return {
            sessions: page.sessions.map((session) => ({
              sessionId: session.sessionId,
              cwd: session.cwd,
              additionalDirectories: [],
              title: session.title,
              updatedAt:
                session.updatedAtMs === null
                  ? null
                  : DateTime.formatIso(DateTime.makeUnsafe(session.updatedAtMs)),
              importedThreadId: null,
            })),
            nextCursor: page.nextCursor,
            canLoad: true,
            canResume: true,
            canDelete: false,
          };
        }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new AcpRegistryOperationError({
              reason: "probe_failed",
              message: "Could not list Dim sessions.",
              cause,
            }),
        ),
      ),
    logout: () =>
      Effect.fail(
        new AcpRegistryOperationError({
          reason: "logout_unsupported",
          message: "Dim has no account session to end from Pina Code.",
        }),
      ),
    deleteSession: () =>
      Effect.fail(
        new AcpRegistryOperationError({
          reason: "session_delete_unsupported",
          message: "Pina Code never deletes Dim sessions; delete it in Dim instead.",
        }),
      ),
    listProviders: () =>
      Effect.fail(
        new AcpRegistryOperationError({
          reason: "providers_unsupported",
          message: "Dim configures its providers in its own daemon.",
        }),
      ),
    setProvider: () =>
      Effect.fail(
        new AcpRegistryOperationError({
          reason: "providers_unsupported",
          message: "Dim configures its providers in its own daemon.",
        }),
      ),
    disableProvider: () =>
      Effect.fail(
        new AcpRegistryOperationError({
          reason: "providers_unsupported",
          message: "Dim configures its providers in its own daemon.",
        }),
      ),
  };
}
