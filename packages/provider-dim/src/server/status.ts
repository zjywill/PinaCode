import type {
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderState,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  parseCliVersionResult,
  providerProbeEnvironment,
  resolveProviderProbeTimeoutMs,
  spawnAndCollect,
  type ServerProviderDraft as SnapshotDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

import type { DimSettings } from "../settings.ts";
import type { DimDaemon } from "./daemon.ts";
import type { DimConnectionError } from "./transport.ts";
import {
  dimDefaultModel,
  dimModelFromCatalog,
  dimModelsFromConfigFile,
  type DimCatalogModel,
} from "./events.ts";
import { isRecord, recordArray, recordField, recordString } from "./protocol.ts";
import { dimUsageLimitsForProfile, readDimAccountUsage } from "./usageLimits.ts";

export const DIM_PRESENTATION = {
  displayName: "Dim",
  supportedRuntimeModes: ["auto-accept-edits", "full-access"],
  showInteractionModeToggle: false,
  reportsContextWindow: true,
  supportsConversationRollback: false,
} as const;

export const DIM_NATIVE_SESSIONS = {
  canList: false,
  canLoad: true,
  canResume: true,
  canDelete: false,
} as const;

const decodeJson = Schema.decodeUnknownOption(Schema.Unknown);
const UNKNOWN_AUTH: ServerProviderAuth = { status: "unknown" };

function collectModels(
  models: ReadonlyArray<DimCatalogModel>,
  contextWindows: Map<string, number>,
): ReadonlyArray<ServerProviderModel> {
  for (const entry of models) {
    if (entry.contextWindow !== undefined)
      contextWindows.set(entry.model.slug, entry.contextWindow);
  }
  return models.map((entry) => entry.model);
}

export function makePendingDimProvider(settings: DimSettings): SnapshotDraft {
  return {
    displayName: DIM_PRESENTATION.displayName,
    supportedRuntimeModes: [...DIM_PRESENTATION.supportedRuntimeModes],
    showInteractionModeToggle: DIM_PRESENTATION.showInteractionModeToggle,
    reportsContextWindow: DIM_PRESENTATION.reportsContextWindow,
    supportsConversationRollback: DIM_PRESENTATION.supportsConversationRollback,
    enabled: settings.enabled,
    installed: false,
    version: null,
    status: settings.enabled ? "error" : "disabled",
    auth: UNKNOWN_AUTH,
    setup: { canAuthenticate: false, canInstall: false },
    checkedAt: DateTime.formatIso(DateTime.nowUnsafe()),
    models: [],
    nativeSessions: DIM_NATIVE_SESSIONS,
    slashCommands: [],
    skills: [],
  };
}

export interface DimProbeInput {
  readonly settings: DimSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly daemon: DimDaemon;
  readonly modelContextWindows: Ref.Ref<ReadonlyMap<string, number>>;
}

const probeBinaryVersion = Effect.fn("DimProvider.probeBinaryVersion")(function* (
  settings: DimSettings,
  environment: NodeJS.ProcessEnv,
) {
  const home = yield* HostProcess.HomeDirectory;
  const binaryPath = expandHomePath(settings.binaryPath || "dima", home);
  const spawnCommand = yield* resolveSpawnCommand(binaryPath, ["--version"], {
    env: providerProbeEnvironment(environment),
  });
  return yield* spawnAndCollect(
    binaryPath,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: providerProbeEnvironment(environment),
      shell: spawnCommand.shell,
    }),
  ).pipe(Effect.timeout(resolveProviderProbeTimeoutMs("dim", DEFAULT_TIMEOUT_MS, environment)));
}, Effect.scoped);

const modelsFromProductCatalog = Effect.fn("DimProvider.modelsFromProductCatalog")(function* (
  request: (
    method: string,
    params?: Record<string, unknown>,
  ) => Effect.Effect<unknown, DimConnectionError>,
) {
  const listed = yield* request("provider.list").pipe(Effect.orElseSucceed(() => undefined));
  const providers = recordArray(listed, "providers") ?? [];
  const enabled = providers.filter(
    (provider) => isRecord(provider) && recordField(provider, "enabled") === true,
  );
  const authenticated = enabled.some(
    (provider) => recordField(provider, "credentialConfigured") === true,
  );
  const models: DimCatalogModel[] = [];
  for (const provider of enabled) {
    const providerId = recordString(provider, "providerId");
    if (providerId === undefined) continue;
    const providerName = recordString(provider, "displayName") ?? providerId;
    const answer = yield* request("provider.catalog", { providerId }).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const catalog = recordField(answer, "catalog");
    for (const model of recordArray(catalog, "models") ?? []) {
      const converted = dimModelFromCatalog({ providerId, providerName, model });
      if (converted !== undefined) models.push(converted);
    }
  }
  return {
    models,
    auth: (authenticated ? { status: "authenticated" } : UNKNOWN_AUTH) satisfies ServerProviderAuth,
  };
});

const readConfiguredModels = Effect.fn("DimProvider.readConfiguredModels")(function* (
  settings: DimSettings,
) {
  if (settings.modelConfigPath.trim() === "") return [] as ReadonlyArray<DimCatalogModel>;
  const home = yield* HostProcess.HomeDirectory;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = expandHomePath(settings.modelConfigPath.trim(), home);
  const contents = yield* fileSystem.readFileString(path).pipe(Effect.orElseSucceed(() => ""));
  return dimModelsFromConfigFile(Option.getOrUndefined(decodeJson(contents)));
});

/** Reads the daemon, catalog, and version. A failure is the snapshot's status, never a defect. */
export const checkDimProviderStatus = Effect.fn("DimProvider.checkStatus")(function* (
  input: DimProbeInput,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const base = makePendingDimProvider(input.settings);
  if (!input.settings.enabled) {
    return { ...base, status: "disabled", checkedAt } satisfies SnapshotDraft;
  }

  const versionResult = yield* probeBinaryVersion(input.settings, input.environment).pipe(
    Effect.result,
  );
  const version =
    versionResult._tag === "Success" ? parseCliVersionResult(versionResult.success) : null;
  const binaryMissing =
    versionResult._tag === "Failure" && isCommandMissingCause(versionResult.failure);

  const hello = yield* input.daemon.ensure().pipe(Effect.result);
  if (hello._tag === "Failure") {
    return {
      ...base,
      checkedAt,
      installed: !binaryMissing,
      version,
      status: "error",
      message: hello.failure.message,
    } satisfies SnapshotDraft;
  }

  const contextWindows = new Map<string, number>();
  let models: ReadonlyArray<ServerProviderModel> = [];
  let auth: ServerProviderAuth = UNKNOWN_AUTH;
  const profile = hello.success.daemonProfile.kind;

  if (profile === "product") {
    const catalog = yield* Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* input.daemon.connect("T3 Code status");
        return yield* modelsFromProductCatalog((method, params) =>
          connection.request(method, params),
        );
      }),
    ).pipe(Effect.orElseSucceed(() => undefined));
    if (catalog !== undefined) {
      models = collectModels(catalog.models, contextWindows);
      auth = catalog.auth;
    }
  } else if (profile === "configured") {
    models = collectModels(yield* readConfiguredModels(input.settings), contextWindows);
  }

  // Subscription limits exist only where the product daemon reports the account.
  const usageLimits =
    profile === "product"
      ? yield* Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* input.daemon.connect("T3 Code usage");
            return yield* readDimAccountUsage(
              (method, params) => connection.request(method, params),
              checkedAt,
            );
          }),
        ).pipe(Effect.orElseSucceed(() => undefined))
      : dimUsageLimitsForProfile(profile, checkedAt);

  yield* Ref.set(input.modelContextWindows, contextWindows);
  const status: ServerProviderState = models.length === 0 ? "warning" : "ready";
  return {
    ...base,
    checkedAt,
    installed: true,
    version: hello.success.serverVersion,
    status,
    auth,
    ...(usageLimits === undefined ? {} : { usageLimits }),
    ...(status === "warning"
      ? { message: "No model configured in Dim. Sign in or configure a provider in Dim." }
      : {}),
    models: [dimDefaultModel(), ...models],
  } satisfies SnapshotDraft;
});
