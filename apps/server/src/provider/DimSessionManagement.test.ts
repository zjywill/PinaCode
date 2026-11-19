import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  type AcpRegistryListSessionsResult,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { makeDimSessionManagement, type DimConnection } from "@t3tools/provider-dim/server";

import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";

import * as AcpRegistrySessions from "./AcpRegistrySessions.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const DIM_DRIVER = ProviderDriverKind.make("dim");
const DIM_INSTANCE_ID = ProviderInstanceId.make("dim");
const PROJECT_ID = ProjectId.make("project-dim");
const WORKSPACE_ROOT = "/workspace/dim";

const dimConnection = (catalog: unknown): DimConnection => ({
  hello: {
    instanceId: "dim-test",
    serverVersion: "0.0.0",
    protocolVersion: 4,
    daemonProfile: { kind: "configured" },
  },
  request: (method) =>
    method === "session.catalog"
      ? Effect.succeed(catalog)
      : Effect.die(`unexpected Dim request ${method}`),
  notices: Stream.never,
  closed: Effect.never,
});

const dimInstance = (): ProviderInstance =>
  ({
    driverKind: DIM_DRIVER,
    snapshot: {
      getSnapshot: Effect.succeed({
        nativeSessions: { canList: true, canLoad: true, canResume: true },
      }),
    },
    acpSessionManagement: makeDimSessionManagement({
      connect: () =>
        Effect.succeed(
          dimConnection({
            sessions: [
              {
                sessionId: "dim-session-1",
                cwd: WORKSPACE_ROOT,
                title: "Earlier work",
                updatedAt: 1_700_000_000_000,
              },
            ],
            nextCursor: null,
          }),
        ),
    }),
  }) as unknown as ProviderInstance;

const project = {
  id: PROJECT_ID,
  title: "Dim project",
  workspaceRoot: WORKSPACE_ROOT,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
};

const moduleLayers = Layer.mergeAll(
  Layer.mock(ProjectService.ProjectService)({
    getById: () => Effect.succeedSome(project),
  }),
  Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
    getInstance: () => Effect.succeed(dimInstance()),
  }),
  Layer.mock(ProviderRegistry.ProviderRegistry)({
    getProviders: Effect.succeed([
      { instanceId: DIM_INSTANCE_ID, models: [{ slug: "default", isDefault: true }] },
    ] as never),
  }),
  Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: () => Effect.succeed(null),
  }),
  Layer.mock(AgentSessionImporter.AgentSessionImporter)({
    importNativeHistory: () => Effect.succeed(0),
  }),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({}),
  Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator)({
    withSessionMutation: (effect) => effect,
  }),
  SqlitePersistence.layerMemory,
  Layer.succeed(
    SecureRandom.SecureRandom,
    SecureRandom.make((size) => new Uint8Array(size)),
  ),
);

describe("Dim session management", () => {
  it.effect("lists Dim sessions for the project workspace", () =>
    Effect.gen(function* () {
      const sessions = yield* AcpRegistrySessions.AcpRegistrySessions;
      const { instance, manager } = yield* sessions.sessionManager(DIM_INSTANCE_ID);
      assert.strictEqual(instance.driverKind, DIM_DRIVER);
      const listed: AcpRegistryListSessionsResult = yield* manager.listSessions({
        cwd: WORKSPACE_ROOT,
      });
      assert.deepEqual(
        listed.sessions.map((session) => [session.sessionId, session.title]),
        [["dim-session-1", "Earlier work"]],
      );
      assert.isTrue(listed.canLoad);
      assert.isTrue(listed.canResume);
      assert.isFalse(listed.canDelete);
      const logout = yield* manager.logout(WORKSPACE_ROOT).pipe(Effect.flip);
      assert.strictEqual(logout.reason, "logout_unsupported");
    }).pipe(Effect.provide(AcpRegistrySessions.layer.pipe(Layer.provideMerge(moduleLayers)))),
  );

  it.effect("imports a Dim session into a native thread", () =>
    Effect.gen(function* () {
      const launched: Array<ThreadLaunchService.ThreadLaunchInput> = [];
      const importedHistory: Array<string> = [];
      const launchLayer = Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        launch: (input) => {
          launched.push(input);
          return Effect.succeed({} as ThreadLaunchService.ThreadLaunchResult);
        },
      });
      const startupLayer = Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
        enqueueCommand: (effect) => effect,
      });
      const importerLayer = Layer.mock(AgentSessionImporter.AgentSessionImporter)({
        importNativeHistory: ({ threadId }) => {
          importedHistory.push(threadId);
          return Effect.succeed(0);
        },
      });
      const services = AcpRegistrySessions.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(moduleLayers, launchLayer, startupLayer, importerLayer)),
      );
      const imported = yield* Effect.gen(function* () {
        const sessions = yield* AcpRegistrySessions.AcpRegistrySessions;
        return yield* sessions.importSession({
          instanceId: DIM_INSTANCE_ID,
          projectId: PROJECT_ID,
          sessionId: "dim-session-1",
        });
      }).pipe(Effect.provide(services));
      assert.strictEqual(launched.length, 1);
      assert.deepEqual(launched[0]?.importedNativeThread?.ref, {
        driver: DIM_DRIVER,
        nativeId: "dim-session-1",
        strength: "strong",
      });
      assert.deepEqual(importedHistory, [imported.threadId]);
      assert.isTrue(imported.imported);
    }),
  );
});
