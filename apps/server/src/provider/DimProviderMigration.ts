import {
  EventId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import {
  DIM_DEFAULT_PRODUCT_HOME,
  restrictLegacyDimRuntimeMode,
} from "@t3tools/provider-dim/settings";
import {
  dimLegacyModelSlug,
  readCustomModelEntries,
  toCustomModelSetting,
} from "@t3tools/shared/model";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import type * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

const dim = ProviderDriverKind.make("dim");

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function readFlag(args: ReadonlyArray<unknown>, flag: string) {
  for (const [index, argument] of args.entries()) {
    if (argument === flag) return string(args[index + 1]);
    if (typeof argument === "string" && argument.startsWith(flag + "=")) {
      return string(argument.slice(flag.length + 1));
    }
  }
}

function convert(instance: ProviderInstanceConfig) {
  if (instance.driver !== "acpRegistry") return;
  const config = record(instance.config);
  const command = string(config.commandPath);
  const usesDima = command !== undefined && /(?:^|[/\\])dima(?:\.exe)?$/i.test(command);
  const registry = config.source !== "local" && string(config.agentId) === "dimcode";
  const resetNativeSession = registry && !usesDima;
  const binaryPath = usesDima ? command : "dima";
  const args: ReadonlyArray<unknown> = Array.isArray(config.commandArgs) ? config.commandArgs : [];
  if (!registry && (config.source !== "local" || !usesDima || args[0] !== "acp")) return;

  // The Registry distribution is the stable CLI and uses a different session store.
  const productHome = resetNativeSession ? DIM_DEFAULT_PRODUCT_HOME : readFlag(args, "--home");
  const modelConfigPath = resetNativeSession ? undefined : readFlag(args, "--model-config");
  const customModels = readCustomModelEntries(config.customModels).map((entry) =>
    toCustomModelSetting({ ...entry, slug: dimLegacyModelSlug(entry.slug) }),
  );
  const { displayName, ...identity } = instance;
  return {
    resetNativeSession,
    instance: {
      ...identity,
      ...(displayName && displayName !== "DimCode Alpha" && !(registry && displayName === "DimCode")
        ? { displayName }
        : {}),
      driver: dim,
      enabled: resolveProviderInstanceEnabled(instance),
      config: {
        binaryPath,
        ...(productHome && { productHome }),
        ...(modelConfigPath && { modelConfigPath }),
        ...(customModels.length > 0 && { customModels }),
      },
    } satisfies ProviderInstanceConfig,
  };
}

export function migrateDimSettings(
  settings: ServerSettings,
  path: Path.Path,
  home: string,
  environmentHome?: string,
) {
  const instances = { ...settings.providerInstances };
  const targets = new Map<ProviderInstanceId, ProviderInstanceId>();
  const resetNativeSessions = new Set<ProviderInstanceId>();
  const effectiveLaunch = (instance: ProviderInstanceConfig) => {
    const config = record(instance.config);
    const env = instance.environment ?? [];
    const homeOverride = env.findLast((item) => item.name === "DIMCODE_HOME");
    const productHome = string(config.productHome);
    const normalizedPath = (value: string) => path.resolve(expandHomePath(value, home));
    if (
      !productHome &&
      homeOverride &&
      (homeOverride.valueRedacted || typeof homeOverride.value !== "string")
    ) {
      return undefined;
    }
    const binary = expandHomePath(string(config.binaryPath) ?? "dima", home);
    const modelConfig = string(config.modelConfigPath);
    return {
      binary: path.isAbsolute(binary) ? path.normalize(binary) : binary,
      productHome: normalizedPath(
        productHome ??
          string(homeOverride?.value) ??
          string(environmentHome) ??
          DIM_DEFAULT_PRODUCT_HOME,
      ),
      modelConfigPath: modelConfig ? normalizedPath(modelConfig) : null,
      socketPath: string(config.socketPath) ?? null,
      environment: env.filter((item) => item !== homeOverride),
    };
  };

  for (const [id, instance] of Object.entries(settings.providerInstances)) {
    const converted = convert(instance);
    if (!converted) continue;
    const migrated = converted.instance;
    const from = ProviderInstanceId.make(id);
    const launch = effectiveLaunch(migrated);
    const duplicate =
      launch && !launch.socketPath
        ? Object.entries(instances).find(
            ([candidate, native]) =>
              candidate !== id &&
              native.driver === dim &&
              !native.environment?.some((item) => item.valueRedacted) &&
              !migrated.environment?.some((item) => item.valueRedacted) &&
              Equal.equals(effectiveLaunch(native), launch),
          )
        : undefined;

    const target = duplicate ? ProviderInstanceId.make(duplicate[0]) : from;
    targets.set(from, target);
    if (converted.resetNativeSession) resetNativeSessions.add(from);
    if (duplicate) {
      const [, native] = duplicate;
      const nativeConfig = record(native.config);
      const legacyConfig = record(migrated.config);
      const productHome = string(nativeConfig.productHome) ?? string(legacyConfig.productHome);
      const customModels = new Map(
        readCustomModelEntries(legacyConfig.customModels).map((entry) => [entry.slug, entry]),
      );
      for (const entry of readCustomModelEntries(nativeConfig.customModels)) {
        customModels.set(entry.slug, entry);
      }
      instances[target] = {
        ...native,
        ...(!native.displayName && migrated.displayName && { displayName: migrated.displayName }),
        ...(!native.accentColor && migrated.accentColor && { accentColor: migrated.accentColor }),
        enabled: resolveProviderInstanceEnabled(native) || migrated.enabled === true,
        ...((productHome || customModels.size > 0) && {
          config: {
            ...nativeConfig,
            ...(productHome && { productHome }),
            ...(customModels.size > 0 && {
              customModels: [...customModels.values()].map(toCustomModelSetting),
            }),
          },
        }),
      };
      delete instances[from];
    } else {
      instances[from] = migrated;
    }
  }

  if (targets.size === 0) return { settings, targets, resetNativeSessions };

  const projectSettingsOverrides = Object.fromEntries(
    Object.entries(settings.projectSettingsOverrides).map(([projectId, override]) => {
      const overrides = override.providerInstances ? { ...override.providerInstances } : undefined;
      if (overrides) {
        for (const [from, to] of targets) {
          if (from === to || !overrides[from]) continue;
          overrides[to] ??= overrides[from];
          delete overrides[from];
        }
      }
      return [
        projectId,
        {
          ...override,
          ...(overrides && { providerInstances: overrides }),
          ...(override.defaultModelSelection && {
            defaultModelSelection: migrateSelection(override.defaultModelSelection, targets),
          }),
        },
      ];
    }),
  );

  const favoriteKeys = new Set<string>();
  const favorites =
    settings.favorites?.flatMap((favorite) => {
      const provider = targets.get(favorite.provider);
      const next =
        provider === undefined ? favorite : { provider, model: dimLegacyModelSlug(favorite.model) };
      const key = JSON.stringify([next.provider, next.model]);
      if (favoriteKeys.has(key)) return [];
      favoriteKeys.add(key);
      return [next];
    }) ?? null;

  const modelPreferences =
    settings.providerModelPreferences === null ? null : { ...settings.providerModelPreferences };
  if (modelPreferences) {
    for (const [from, to] of targets) {
      const previous = settings.providerModelPreferences?.[from];
      if (!previous) continue;
      const current = from === to ? undefined : modelPreferences[to];
      modelPreferences[to] = {
        hiddenModels: [
          ...new Set([
            ...(current?.hiddenModels ?? []),
            ...previous.hiddenModels.map(dimLegacyModelSlug),
          ]),
        ],
        modelOrder: [
          ...new Set([
            ...(current?.modelOrder ?? []),
            ...previous.modelOrder.map(dimLegacyModelSlug),
          ]),
        ],
      };
      if (from !== to) delete modelPreferences[from];
    }
  }

  return {
    targets,
    resetNativeSessions,
    settings: {
      ...settings,
      providerInstances: instances,
      projectSettingsOverrides,
      favorites,
      providerModelPreferences: modelPreferences,
      defaultModelSelection:
        settings.defaultModelSelection && migrateSelection(settings.defaultModelSelection, targets),
    } satisfies ServerSettings,
  };
}

function migrateSelection(
  selection: ModelSelection,
  targets: ReadonlyMap<ProviderInstanceId, ProviderInstanceId>,
): ModelSelection {
  const instanceId = targets.get(selection.instanceId);
  if (instanceId === undefined) return selection;
  const options = selection.options?.filter(
    (option) => option.id === "effort" || option.id === "mode",
  );
  const migrated = {
    instanceId,
    model: dimLegacyModelSlug(selection.model),
    ...(options?.length ? { options } : {}),
  };
  return Equal.equals(migrated, selection) ? selection : migrated;
}

export const migrateDimThreads = Effect.fn("DimProviderMigration.migrateThreads")(function* ({
  targets,
  resetNativeSessions,
}: Pick<ReturnType<typeof migrateDimSettings>, "targets" | "resetNativeSessions">) {
  if (targets.size === 0) return;
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const instanceIds = [...targets.keys()];
  const rows = yield* sql<{ readonly thread_id: string }>`
    SELECT thread_id
    FROM orchestration_v2_projection_threads
    WHERE provider_instance_id IN ${sql.in(instanceIds)} AND deleted_at IS NULL
    UNION
    SELECT binding.thread_id
    FROM orchestration_v2_projection_provider_threads AS binding
    INNER JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = binding.thread_id
    WHERE binding.driver = 'acpRegistry' AND binding.provider_instance_id IN ${sql.in(instanceIds)}
      AND binding.owner_node_id IS NULL AND thread.deleted_at IS NULL
  `.pipe(NodeSqliteClient.readOnly);

  for (const row of rows) {
    const threadId = ThreadId.make(row.thread_id);
    const thread = yield* projections.getThread(threadId);
    if (thread.deletedAt !== null) continue;
    const { providerThreads, runs } = yield* projections.getThreadRecords(
      threadId,
      ["providerThreads", "runs"],
      { runStatuses: ["queued"] },
    );
    const occurredAt = yield* DateTime.now;
    const events: OrchestrationV2DomainEvent[] = [];
    const base = () => ({
      id: EventId.make(
        `dim-migration:${threadId}:${DateTime.toEpochMillis(occurredAt)}:${events.length}`,
      ),
      threadId,
      occurredAt,
    });
    for (const binding of providerThreads) {
      const target = targets.get(binding.providerInstanceId);
      if (!target || binding.driver !== "acpRegistry" || binding.ownerNodeId !== null) continue;
      events.push({
        ...base(),
        driver: dim,
        providerInstanceId: target,
        type: "provider-thread.updated",
        payload: {
          ...binding,
          driver: dim,
          providerInstanceId: target,
          providerSessionId: null,
          nativeThreadRef: resetNativeSessions.has(binding.providerInstanceId)
            ? null
            : binding.nativeThreadRef && { ...binding.nativeThreadRef, driver: dim },
          nativeConversationHeadRef: null,
          status:
            binding.status === "active" || binding.status === "idle"
              ? "not_loaded"
              : binding.status,
        },
      });
    }
    for (const run of runs) {
      const modelSelection = migrateSelection(run.modelSelection, targets);
      if (modelSelection === run.modelSelection) continue;
      events.push({
        ...base(),
        runId: run.id,
        providerInstanceId: modelSelection.instanceId,
        type: "run.updated",
        payload: { ...run, modelSelection, providerInstanceId: modelSelection.instanceId },
      });
    }
    const migratedSelection = migrateSelection(thread.modelSelection, targets);
    const wasMigrated = targets.has(thread.modelSelection.instanceId);
    const runtimeMode = wasMigrated
      ? restrictLegacyDimRuntimeMode(thread.runtimeMode, migratedSelection)
      : thread.runtimeMode;
    const options = migratedSelection.options?.filter((option) => option.id !== "mode");
    const modelSelection =
      wasMigrated && options?.length !== migratedSelection.options?.length
        ? {
            instanceId: migratedSelection.instanceId,
            model: migratedSelection.model,
            ...(options?.length ? { options } : {}),
          }
        : migratedSelection;
    if (
      events.length === 0 &&
      modelSelection === thread.modelSelection &&
      runtimeMode === thread.runtimeMode
    )
      continue;
    // Provider-thread updates set the active binding. Restore the original selection after all of them.
    events.push({
      ...base(),
      providerInstanceId: modelSelection.instanceId,
      type: "thread.model-selection-updated",
      payload: {
        ...thread,
        modelSelection,
        providerInstanceId: modelSelection.instanceId,
        runtimeMode,
      },
    });
    yield* sink.write({ events });
  }
});
