import { ProviderDriverKind, TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
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
import { makeDimDaemon } from "./daemon.ts";
import { makeDimSessionManagement } from "./sessionManagement.ts";
import { checkDimProviderStatus, makePendingDimProvider } from "./status.ts";

const DRIVER_KIND = ProviderDriverKind.make("dim");
const decodeDimSettings = Schema.decodeSync(DimSettings);

export type DimDriverEnv =
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path;

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
  metadata: { displayName: "Dim", supportsMultipleInstances: true },
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
    const maintenance: ProviderMaintenanceCapabilities =
      makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER_KIND,
        packageName: "dimcode-alpha",
        manualCommand: "npm install -g dimcode-alpha@alpha",
      });
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<DimSettings>>({
      resolveMaintenance: () => Effect.succeed(maintenance),
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
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
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
    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      refreshModels: () => snapshot.refresh.pipe(Effect.asVoid),
      orchestrationAdapter: adapter,
      // The server's session list/import RPCs dispatch on this, whatever the driver.
      acpSessionManagement: makeDimSessionManagement(daemon),
      textGeneration: unsupportedTextGeneration(),
    } satisfies ProviderInstance;
  }),
};

export { DIM_PROVIDER };
