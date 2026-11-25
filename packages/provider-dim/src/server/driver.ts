import { ProviderDriverKind, TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Digest from "effect/crypto/Digest";
import * as HttpClient from "effect/http/HttpClient";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  createProviderVersionAdvisory,
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makeProviderMaintenanceCapabilities,
  normalizeCommandPath,
  resolveDefaultNpmGlobalPrefix,
  resolveNpmGlobalPrefix,
  resolveProviderMaintenanceCapabilitiesEffect,
  type ProviderMaintenanceCapabilitiesResolver,
} from "@t3tools/provider-core/server/maintenanceResolver";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";

import { DimSettings } from "../settings.ts";
import { DIM_PROVIDER, makeDimAdapterV2 } from "./adapter.ts";
import { makeDimAuth, readDimAuth, refreshDimAccountModels, supportsDimAccount } from "./auth.ts";
import { makeDimDaemon } from "./daemon.ts";
import { makeDimSessionManagement } from "./sessionManagement.ts";
import {
  checkDimProviderStatus,
  makePendingDimProvider,
  readDimWorkspaceSkills,
} from "./status.ts";

const DRIVER_KIND = ProviderDriverKind.make("dim");
const decodeDimSettings = Schema.decodeSync(DimSettings);

export type DimDriverEnv =
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | SecureRandom.SecureRandom
  | Digest.Digest
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions;

function dimMaintenance(
  settings: DimSettings,
  env: NodeJS.ProcessEnv,
): ProviderMaintenanceCapabilitiesResolver {
  return {
    resolve: Effect.fn("Dim.resolveMaintenance")(function* (context) {
      const packageName = "dimcode-alpha";
      if (settings.socketPath.trim() !== "") {
        return {
          ...makeManualOnlyProviderMaintenanceCapabilities({ provider: DRIVER_KIND, packageName }),
          npmDistTag: "alpha",
        };
      }
      const prefix = context
        ? yield* resolveNpmGlobalPrefix(context, packageName)
        : settings.binaryPath.trim() === "dima"
          ? yield* resolveDefaultNpmGlobalPrefix(env)
          : null;
      const capabilities = prefix
        ? makeProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName,
            updateExecutable: "npm",
            updateArgs: ["install", "-g", "--prefix", prefix, packageName + "@alpha"],
            updateLockKey: "npm-global:" + normalizeCommandPath(prefix),
            env,
            platform: yield* HostProcess.Platform,
          })
        : makeManualOnlyProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName,
            ...(context && { installPath: context.realCommandPath }),
          });
      return { ...capabilities, npmDistTag: "alpha" };
    }),
  };
}

const unsupportedTextGeneration = (): ProviderTextGeneration => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "The Dim provider does not generate application text.",
      }),
    );
  return {
    generateTranscriptionPostProcessing: () => unsupported("generateTranscriptionPostProcessing"),
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
    generateReviewGuide: () => unsupported("generateReviewGuide"),
  };
};

export const DimDriver: ProviderDriver<DimSettings, DimDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Dim", supportsMultipleInstances: true, hasDefaultInstance: false },
  configSchema: DimSettings,
  defaultConfig: () => decodeDimSettings({}),
  create: Effect.fn("DimDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const host = yield* ProviderHost.ProviderHost;
    const home = yield* HostProcess.HomeDirectory;
    const processEnvironment = yield* mergeProviderInstanceEnvironment(environment);
    const effectiveConfig = {
      ...config,
      enabled,
      binaryPath: expandHomePath(config.binaryPath, home),
    } satisfies DimSettings;
    const daemon = yield* makeDimDaemon({
      settings: effectiveConfig,
      environment: processEnvironment,
      cwd: host.paths.cwd,
    }).pipe(Effect.provideService(Path.Path, path));
    const modelContextWindows = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    const adapter = yield* makeDimAdapterV2({
      instanceId,
      modelContextWindows,
      connections: {
        connect: ({ clientName }) => daemon.connect(clientName),
      },
    });
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const services = yield* Effect.context<
      | FileSystem.FileSystem
      | Path.Path
      | ChildProcessSpawner.ChildProcessSpawner
      | Digest.Digest
      | HttpClient.HttpClient
      | ProviderLatestVersions.ProviderLatestVersions
    >();
    const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
      resolveProviderMaintenanceCapabilitiesEffect(
        dimMaintenance(effectiveConfig, processEnvironment),
        { binaryPath: effectiveConfig.binaryPath, env: processEnvironment },
      ).pipe(Effect.provideContext(services)),
    );
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<DimSettings>>({
      resolveMaintenance,
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        Effect.succeed(stampIdentity(makePendingDimProvider(settings.provider))),
      checkProvider: checkDimProviderStatus({
        settings: effectiveConfig,
        environment: processEnvironment,
        daemon,
        modelContextWindows,
      }).pipe(
        Effect.map(stampIdentity),
        Effect.filterOrElse(
          (provider) => !provider.enabled || provider.installed,
          (provider) =>
            resolveMaintenance().pipe(
              Effect.map((maintenanceCapabilities) => ({
                ...provider,
                versionAdvisory: createProviderVersionAdvisory({
                  driver: DRIVER_KIND,
                  currentVersion: null,
                  maintenanceCapabilities,
                }),
              })),
            ),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
      enrichSnapshot: ({ snapshot, settings, publishSnapshot }) =>
        snapshot.installed
          ? resolveMaintenance().pipe(
              Effect.flatMap((maintenance) =>
                enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenance, settings),
              ),
              Effect.provideContext(services),
              Effect.flatMap(publishSnapshot),
            )
          : Effect.void,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build the Dim provider snapshot.",
            cause,
          }),
      ),
    );
    const auth = yield* makeDimAuth({
      instanceId,
      daemon,
      refresh: snapshot.refresh.pipe(Effect.asVoid),
    });
    const refreshModels = Effect.fn("DimDriver.refreshModels")(
      function* () {
        const connection = yield* daemon.connect("Pina Code Dim model refresh");
        if (!supportsDimAccount(connection.hello)) return;
        const auth = yield* readDimAuth(connection.request);
        if (auth?.status === "authenticated") yield* refreshDimAccountModels(connection.request);
      },
      Effect.scoped,
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Could not refresh the Dim model catalog.",
            cause,
          }),
      ),
    );
    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      auth,
      snapshot,
      snapshotForCwd: Effect.fn("DimDriver.snapshotForCwd")(
        function* (cwd: string) {
          const machineSnapshot = yield* snapshot.getSnapshot;
          if (!enabled) return machineSnapshot;
          const connection = yield* daemon.connect("Pina Code Dim workspace");
          const skills = yield* readDimWorkspaceSkills(connection, cwd);
          return { ...machineSnapshot, skills };
        },
        Effect.scoped,
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Could not list Dim skills for the workspace.",
              cause,
            }),
        ),
      ),
      refreshModels,
      orchestrationAdapter: adapter,
      // The server's session list/import RPCs dispatch on this, whatever the driver.
      acpSessionManagement: makeDimSessionManagement(daemon),
      textGeneration: unsupportedTextGeneration(),
    } satisfies ProviderInstance;
  }),
};

export { DIM_PROVIDER };
