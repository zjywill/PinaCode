import {
  ServerProviderSkill,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderState,
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
  providerModelsFromSettings,
  providerProbeEnvironment,
  resolveProviderProbeTimeoutMs,
  spawnAndCollect,
  type ServerProviderDraft as SnapshotDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

import type { DimSettings } from "../settings.ts";
import { readDimAuth, supportsDimAccount } from "./auth.ts";
import type { DimDaemon } from "./daemon.ts";
import type { DimConnection } from "./transport.ts";
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
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
  showInteractionModeToggle: false,
  reportsContextWindow: true,
  supportsConversationRollback: false,
} as const;

export const DIM_NATIVE_SESSIONS = {
  canList: true,
  canLoad: true,
  canResume: true,
  canDelete: false,
} as const;

const decodeJson = Schema.decodeUnknownOption(Schema.Unknown);
const decodeSkill = Schema.decodeUnknownOption(ServerProviderSkill);
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

const querySelectableModels = Effect.fn("DimProvider.querySelectableModels")(function* (
  request: DimConnection["request"],
) {
  const models: DimCatalogModel[] = [];
  let modelsIncomplete = false;
  let after: { providerId: string; modelId: string } | undefined;
  do {
    const page = yield* request("provider.models.query", {
      selectableOnly: true,
      limit: 100,
      ...(after === undefined ? {} : { after }),
    });
    const entries = recordArray(page, "models");
    if (!entries) return { models, modelsIncomplete: true };
    modelsIncomplete ||= (recordArray(page, "empty") ?? []).some(
      (entry) => recordString(recordField(entry, "reason"), "kind") === "unreadable",
    );
    for (const entry of entries) {
      const providerId = recordString(entry, "providerId");
      if (providerId === undefined) continue;
      const entryModel = dimModelFromCatalog({
        providerId,
        providerName: recordString(entry, "providerName") ?? providerId,
        model: recordField(entry, "model"),
      });
      if (entryModel !== undefined) models.push(entryModel);
    }
    const next = recordField(page, "next");
    if (next == null) break;
    const providerId = recordString(next, "providerId");
    const modelId = recordString(next, "modelId");
    if (
      providerId === undefined ||
      modelId === undefined ||
      (after?.providerId === providerId && after.modelId === modelId)
    ) {
      return { models, modelsIncomplete: true };
    }
    after = { providerId, modelId };
  } while (true);
  return { models, modelsIncomplete };
});

export const readDimWorkspaceSkills = Effect.fn("DimProvider.readWorkspaceSkills")(function* (
  connection: DimConnection,
  cwd: string,
) {
  const skills: ServerProviderSkill[] = [];
  if (!connection.hello.features?.includes("skills.catalog")) return skills;
  const catalog = yield* connection.request("skills.catalog", { cwd });
  for (const entry of recordArray(catalog, "entries") ?? []) {
    if (recordString(entry, "shadowedBy") !== undefined) continue;
    const userInvocable = recordField(entry, "userInvocable");
    const skill = decodeSkill({
      name: recordField(entry, "name"),
      path: recordField(entry, "filePath"),
      description: recordString(entry, "description")?.trim() || undefined,
      scope: recordString(entry, "source"),
      enabled: recordField(entry, "enabled"),
      ...(typeof userInvocable === "boolean" ? { userInvocable } : {}),
      ...(userInvocable === true && recordField(entry, "modelInvocable") === false
        ? { userInvocationOnly: true }
        : {}),
    });
    if (Option.isSome(skill)) skills.push(skill.value);
  }
  return skills;
});

const modelsFromProductCatalog = Effect.fn("DimProvider.modelsFromProductCatalog")(function* ({
  request,
  hello,
}: DimConnection) {
  const listed = yield* request("provider.list").pipe(Effect.orElseSucceed(() => undefined));
  const providers = recordArray(listed, "providers") ?? [];
  const enabled = providers.filter(
    (provider) => isRecord(provider) && recordField(provider, "enabled") === true,
  );
  const authenticated = enabled.some(
    (provider) => recordField(provider, "credentialConfigured") === true,
  );
  const auth: ServerProviderAuth = authenticated ? { status: "authenticated" } : UNKNOWN_AUTH;
  if (hello.features?.includes("provider.models.query")) {
    const catalog = yield* querySelectableModels(request).pipe(
      Effect.orElseSucceed(() => ({ models: [], modelsIncomplete: true })),
    );
    return { ...catalog, auth };
  }
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
  return { models, auth, modelsIncomplete: undefined };
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
  let modelsIncomplete: boolean | undefined = profile === "product" ? true : undefined;
  let canAuthenticate = false;
  let usageLimits = dimUsageLimitsForProfile(profile, checkedAt);

  if (profile === "product") {
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* input.daemon.connect("Pina Code Dim status");
        const { request, hello } = connection;
        const catalog = yield* modelsFromProductCatalog(connection);
        const account = supportsDimAccount(hello)
          ? yield* readDimAuth(request).pipe(Effect.orElseSucceed(() => undefined))
          : undefined;
        const usage = yield* readDimAccountUsage(request, checkedAt);
        return { catalog, account, usage };
      }),
    ).pipe(Effect.orElseSucceed(() => undefined));
    if (result !== undefined) {
      models = collectModels(result.catalog.models, contextWindows);
      modelsIncomplete = result.catalog.modelsIncomplete;
      auth = result.account ?? result.catalog.auth;
      canAuthenticate = result.account !== undefined;
      usageLimits = result.usage;
    }
  } else if (profile === "configured") {
    models = collectModels(yield* readConfiguredModels(input.settings), contextWindows);
  }

  yield* Ref.set(input.modelContextWindows, contextWindows);
  const status: ServerProviderState = models.length === 0 ? "warning" : "ready";
  return {
    ...base,
    checkedAt,
    installed: true,
    version: hello.success.serverVersion,
    ...(input.settings.socketPath.trim() === "" ? { installedVersion: version } : {}),
    status,
    auth,
    ...(modelsIncomplete === undefined ? {} : { modelsIncomplete }),
    setup: { canInstall: false, canAuthenticate },
    ...(usageLimits === undefined ? {} : { usageLimits }),
    ...(status === "warning"
      ? {
          message:
            modelsIncomplete === true
              ? "Could not verify the Dim model list. Refresh the model list to check again."
              : auth.status === "authenticated"
                ? "No models are available. Refresh the model list or configure a provider in Dim."
                : "No model configured in Dim. Sign in or configure a provider in Dim.",
        }
      : {}),
    models: providerModelsFromSettings(
      models.length > 0 || modelsIncomplete === undefined ? [dimDefaultModel(), ...models] : [],
      input.settings.customModels,
      null,
    ),
  } satisfies SnapshotDraft;
});
