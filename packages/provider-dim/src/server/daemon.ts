// @effect-diagnostics nodeBuiltinImport:off -- the daemon must outlive this process, which Effect's scoped spawner does not model.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

import type { DimSettings } from "../settings.ts";
import type { DimHelloResult } from "./protocol.ts";
import {
  connectDim,
  DimMissingFeaturesError,
  DimProtocolVersionError,
  DimRpcError,
  DimTransportError,
  dimEndpointExists,
  type DimConnection,
} from "./transport.ts";

const DAEMON_START_TIMEOUT_MS = 10_000;
const DAEMON_PROBE_INTERVAL = "100 millis";

export class DimDaemonError extends Schema.TaggedError<DimDaemonError>()("DimDaemonError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

const isDimDaemonError = Schema.is(DimDaemonError);

export type DimDaemonFailure =
  | DimDaemonError
  | DimTransportError
  | DimRpcError
  | DimProtocolVersionError
  | DimMissingFeaturesError;

export interface DimDaemon {
  readonly endpoint: string;
  readonly nativeHome: string;
  readonly productHome: string;
  /** Connects, starting the daemon when no one answers and no socket override is set. */
  readonly ensure: () => Effect.Effect<DimHelloResult, DimDaemonFailure>;
  readonly connect: (
    clientName: string,
  ) => Effect.Effect<DimConnection, DimDaemonFailure, Scope.Scope>;
}

export interface DimDaemonOptions {
  readonly settings: DimSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
}

function windowsPipeName(nativeHome: string): string {
  let canonical = NodePath.resolve(nativeHome);
  try {
    canonical = NodePath.toNamespacedPath(NodeFS.realpathSync.native(nativeHome));
  } catch {
    // The native home may not exist yet; the CLI creates it before spawning.
  }
  const key = NodeCrypto.createHash("sha256").update(`dimcode:${canonical}`).digest("hex");
  return String.raw`\\.\pipe\dim-rust-${key.slice(0, 32)}`;
}

function ensureDirectory(path: string): void {
  NodeFS.mkdirSync(path, { recursive: true, mode: 0o700 });
}

/** Dim refuses a socket in a directory another user can read. */
function assertPrivateDirectory(path: string, platform: NodeJS.Platform): void {
  if (platform === "win32") return;
  const stat = NodeFS.statSync(path, { throwIfNoEntry: false });
  if (stat === undefined) {
    throw new DimDaemonError({ detail: `Dim directory ${path} does not exist` });
  }
  if (!stat.isDirectory()) {
    throw new DimDaemonError({ detail: `Dim path ${path} is not a directory` });
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new DimDaemonError({ detail: `Dim directory ${path} must be private (0700)` });
  }
  if (typeof process.geteuid === "function" && stat.uid !== process.geteuid()) {
    throw new DimDaemonError({ detail: `Dim directory ${path} must be owned by this user` });
  }
}

const probe = (endpoint: string): Effect.Effect<DimHelloResult, DimDaemonFailure> =>
  Effect.scoped(
    connectDim({ endpoint, clientName: "T3 Code status" }).pipe(Effect.map((c) => c.hello)),
  );

export const makeDimDaemon = Effect.fn("DimDaemon.make")(function* (options: DimDaemonOptions) {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  const settings = options.settings;
  const configuredHome = settings.productHome.trim();
  const environmentHome = options.environment["DIMCODE_HOME"]?.trim() ?? "";
  const productHome =
    configuredHome !== ""
      ? expandHomePath(configuredHome, home)
      : environmentHome !== ""
        ? expandHomePath(environmentHome, home)
        : path.join(home, ".dimcode-alpha");
  const nativeHome = path.join(productHome, "rust");
  const override = settings.socketPath.trim();
  const connectOnly = override !== "";
  const endpoint = connectOnly
    ? expandHomePath(override, home)
    : platform === "win32"
      ? windowsPipeName(nativeHome)
      : path.join(nativeHome, "daemon.sock");
  const modelConfigPath = settings.modelConfigPath.trim();
  const binaryPath = expandHomePath(settings.binaryPath || "dima", home);
  const guard = yield* Semaphore.make(1);
  // A spawn error means this binary cannot start; a nonzero exit may be a losing daemon.
  let spawnError: string | null = null;
  let exitStatus: string | null = null;
  const daemonArgs = [
    "app-server",
    platform === "win32" ? "--pipe" : "--unix",
    endpoint,
    "--no-ws",
    "--home",
    nativeHome,
    ...(modelConfigPath !== ""
      ? ["--model-config", expandHomePath(modelConfigPath, home)]
      : ["--product-home", productHome]),
  ];
  const launch = yield* resolveSpawnCommand(binaryPath, daemonArgs, {
    env: options.environment,
  });

  const spawnDaemon = Effect.try({
    try: () => {
      ensureDirectory(productHome);
      ensureDirectory(nativeHome);
      assertPrivateDirectory(nativeHome, platform);
      // Keep mise from downloading a missing tool while the daemon starts.
      const env: NodeJS.ProcessEnv = { ...options.environment, MISE_OFFLINE: "1" };
      for (const name of Object.keys(env)) {
        if (name.startsWith("DIM_")) delete env[name];
      }
      const logPath = path.join(nativeHome, "daemon.log");
      const log = NodeFS.openSync(logPath, "a", 0o600);
      try {
        const child = NodeChildProcess.spawn(launch.command, launch.args, {
          cwd: options.cwd,
          env,
          shell: launch.shell,
          detached: platform !== "win32",
          stdio: ["ignore", "ignore", log],
          windowsHide: true,
        });
        child.on("error", (cause) => {
          spawnError = `${binaryPath}: ${cause.message}`;
        });
        child.on("exit", (code) => {
          if (code !== null && code !== 0) {
            exitStatus = `${binaryPath} app-server exited with code ${code}`;
          }
        });
        child.unref();
      } finally {
        NodeFS.closeSync(log);
      }
    },
    catch: (cause) =>
      isDimDaemonError(cause)
        ? cause
        : new DimDaemonError({ detail: `Cannot start Dim: ${String(cause)}`, cause }),
  });

  const ensureOnce = Effect.gen(function* () {
    const existing = yield* probe(endpoint).pipe(Effect.result);
    if (existing._tag === "Success") return existing.success;
    if (
      existing.failure._tag === "DimProtocolVersionError" ||
      existing.failure._tag === "DimMissingFeaturesError"
    ) {
      return yield* existing.failure;
    }
    if (connectOnly) {
      return yield* new DimDaemonError({
        detail: dimEndpointExists(endpoint, platform)
          ? `Dim is not answering at ${endpoint}. Start Dim (dima) and try again.`
          : `Dim is not running at ${endpoint}. Start Dim (dima) and try again.`,
      });
    }
    spawnError = null;
    exitStatus = null;
    yield* spawnDaemon;
    let last: DimDaemonFailure | null = null;
    for (let attempt = 0; attempt < DAEMON_START_TIMEOUT_MS / 100; attempt += 1) {
      const result = yield* probe(endpoint).pipe(Effect.result);
      if (result._tag === "Success") return result.success;
      last = result.failure;
      if (spawnError !== null) {
        return yield* new DimDaemonError({ detail: spawnError, cause: last });
      }
      yield* Effect.sleep(DAEMON_PROBE_INTERVAL);
    }
    return yield* new DimDaemonError({
      detail:
        exitStatus ??
        `Dim daemon did not start at ${endpoint}. Run \`${binaryPath} app-server\` in a terminal to see why.`,
      cause: last,
    });
  });

  const ensure = () => guard.withPermit(ensureOnce);

  return {
    endpoint,
    nativeHome,
    productHome,
    ensure,
    connect: Effect.fn("DimDaemon.connect")(function* (clientName: string) {
      yield* ensure();
      return yield* connectDim({ endpoint, clientName });
    }),
  } satisfies DimDaemon;
});
