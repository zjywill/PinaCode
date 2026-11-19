// @effect-diagnostics nodeBuiltinImport:off -- NDJSON over a unix socket has no platform abstraction here.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";

import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  DIM_MAX_FRAME_BYTES,
  DIM_PROTOCOL_VERSION,
  DIM_REQUIRED_FEATURES,
  type DimHelloResult,
  type DimNotice,
  isRecord,
  recordField,
  recordNumber,
  recordString,
} from "./protocol.ts";

export class DimTransportError extends Schema.TaggedError<DimTransportError>()(
  "DimTransportError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Dim transport error: ${this.detail}`;
  }
}

export class DimRpcError extends Schema.TaggedError<DimRpcError>()("DimRpcError", {
  method: Schema.String,
  code: Schema.Number,
  appError: Schema.optional(Schema.String),
  detail: Schema.String,
}) {
  override get message(): string {
    return `Dim ${this.method} failed (${this.code}${this.appError ? ` ${this.appError}` : ""}): ${this.detail}`;
  }
}

export class DimProtocolVersionError extends Schema.TaggedError<DimProtocolVersionError>()(
  "DimProtocolVersionError",
  {
    found: Schema.Number,
    required: Schema.Number,
  },
) {
  override get message(): string {
    return `Dim App Server speaks protocol v${this.found}; this provider requires v${this.required}. Update Dim, or stop the older daemon with \`dima daemon stop\`.`;
  }
}

export class DimMissingFeaturesError extends Schema.TaggedError<DimMissingFeaturesError>()(
  "DimMissingFeaturesError",
  {
    missing: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Dim App Server is missing required features: ${this.missing.join(", ")}. Update Dim.`;
  }
}

export type DimConnectionError =
  | DimTransportError
  | DimRpcError
  | DimProtocolVersionError
  | DimMissingFeaturesError;

export interface DimRequestOptions {
  readonly timeout?: Duration.Input;
}

/** One open Dim connection. Requests correlate by id; notices arrive in `notices` order. */
export interface DimConnection {
  readonly hello: DimHelloResult;
  readonly request: (
    method: string,
    params?: Record<string, unknown>,
    options?: DimRequestOptions,
  ) => Effect.Effect<unknown, DimRpcError | DimTransportError>;
  readonly notices: Stream.Stream<DimNotice>;
  /** Completes when the socket closes, for any reason. */
  readonly closed: Effect.Effect<void>;
}

const DEFAULT_REQUEST_TIMEOUT = Duration.seconds(30);
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isDimTransportError = Schema.is(DimTransportError);

function rpcError(method: string, error: unknown): DimRpcError {
  const code = recordNumber(error, "code") ?? -32603;
  const detail = recordString(error, "message") ?? "Unknown Dim error";
  const appError = recordString(recordField(error, "data"), "appError");
  return new DimRpcError({
    method,
    code,
    ...(appError === undefined ? {} : { appError }),
    detail,
  });
}

function decodeHello(result: unknown): DimHelloResult {
  const instanceId = recordString(result, "instanceId");
  const serverVersion = recordString(result, "serverVersion");
  const protocolVersion = recordNumber(result, "protocolVersion");
  const profile = recordField(result, "daemonProfile");
  const kind = recordString(profile, "kind");
  const features = recordField(result, "features");
  if (
    instanceId === undefined ||
    serverVersion === undefined ||
    protocolVersion === undefined ||
    (kind !== "mock" && kind !== "configured" && kind !== "product")
  ) {
    throw new DimTransportError({ detail: "Dim hello returned an unexpected result" });
  }
  return {
    instanceId,
    serverVersion,
    ...(recordString(result, "buildId") === undefined
      ? {}
      : { buildId: recordString(result, "buildId")! }),
    protocolVersion,
    daemonProfile: { kind },
    ...(Array.isArray(features)
      ? { features: features.filter((entry): entry is string => typeof entry === "string") }
      : {}),
  };
}

function checkHello(hello: DimHelloResult): DimConnectionError | null {
  if (hello.protocolVersion !== DIM_PROTOCOL_VERSION) {
    return new DimProtocolVersionError({
      found: hello.protocolVersion,
      required: DIM_PROTOCOL_VERSION,
    });
  }
  const offered = new Set(hello.features ?? []);
  const missing = DIM_REQUIRED_FEATURES.filter((feature) => !offered.has(feature));
  return missing.length === 0 ? null : new DimMissingFeaturesError({ missing });
}

interface PendingRequest {
  readonly method: string;
  readonly deferred: Deferred.Deferred<unknown, DimRpcError | DimTransportError>;
}

/**
 * Opens `endpoint`, greets the daemon at protocol v4, and returns the connection.
 * The caller's scope owns the socket; closing it ends `notices`.
 */
export const connectDim: (
  input: {
    readonly endpoint: string;
    readonly clientName: string;
  },
  options?: { readonly requestTimeout?: Duration.Input },
) => Effect.Effect<DimConnection, DimConnectionError, Scope.Scope> = Effect.fn(
  "DimConnection.connect",
)(function* (
  input: {
    readonly endpoint: string;
    readonly clientName: string;
  },
  options?: { readonly requestTimeout?: Duration.Input },
) {
  const pending = new Map<number, PendingRequest>();
  const notices = yield* Queue.unbounded<DimNotice, Cause.Done>();
  const closed = yield* Deferred.make<void>();
  let nextId = 1;
  let buffer = "";
  let isClosed = false;

  const socket = yield* Effect.acquireRelease(
    Effect.callback<NodeNet.Socket, DimTransportError>((resume) => {
      const created = NodeNet.createConnection({ path: input.endpoint });
      created.setEncoding("utf8");
      created.once("error", (cause) => {
        resume(Effect.fail(new DimTransportError({ detail: String(cause), cause })));
      });
      created.once("connect", () => {
        resume(Effect.succeed(created));
      });
      return Effect.sync(() => {
        created.destroy();
      });
    }),
    (created) => Effect.sync(() => created.destroy()),
  );

  const failAll = (error: DimTransportError) => {
    if (isClosed) return;
    isClosed = true;
    for (const request of pending.values()) {
      Deferred.doneUnsafe(request.deferred, Effect.fail(error));
    }
    pending.clear();
    Queue.endUnsafe(notices);
    Deferred.doneUnsafe(closed, Effect.void);
  };

  const handleFrame = (frame: unknown) => {
    if (!isRecord(frame)) return;
    const id = recordNumber(frame, "id");
    const method = recordString(frame, "method");
    if (id !== undefined && method === undefined) {
      const request = pending.get(id);
      if (request === undefined) return;
      pending.delete(id);
      if (frame["error"] !== undefined) {
        Deferred.doneUnsafe(
          request.deferred,
          Effect.fail(rpcError(request.method, frame["error"])),
        );
      } else {
        Deferred.doneUnsafe(request.deferred, Effect.succeed(frame["result"] ?? null));
      }
      return;
    }
    if (method !== undefined) {
      Queue.offerUnsafe(notices, { method, params: frame["params"] });
    }
  };

  const handleLine = (line: string) => {
    if (line.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    handleFrame(parsed);
  };

  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      handleLine(line.endsWith("\r") ? line.slice(0, -1) : line);
      if (isClosed) return;
      newline = buffer.indexOf("\n");
    }
    if (Buffer.byteLength(buffer, "utf8") > DIM_MAX_FRAME_BYTES) {
      failAll(new DimTransportError({ detail: "Dim sent a frame above the 16 MiB limit" }));
      socket.destroy();
    }
  });
  socket.on("error", (cause) => {
    failAll(new DimTransportError({ detail: String(cause), cause }));
  });
  socket.on("close", () => {
    failAll(new DimTransportError({ detail: "Dim connection closed" }));
  });

  const request: DimConnection["request"] = Effect.fn("DimConnection.request")(function* (
    method: string,
    params: Record<string, unknown> = {},
    requestOptions?: DimRequestOptions,
  ) {
    if (isClosed) {
      return yield* new DimTransportError({ detail: "Dim connection is closed" });
    }
    const id = nextId++;
    const deferred = yield* Deferred.make<unknown, DimRpcError | DimTransportError>();
    pending.set(id, { method, deferred });
    socket.write(`${encodeJsonLine({ jsonrpc: "2.0", id, method, params })}\n`);
    return yield* Effect.timeoutOrElse(Deferred.await(deferred), {
      duration: requestOptions?.timeout ?? options?.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT,
      orElse: () => Effect.fail(new DimTransportError({ detail: `Dim ${method} timed out` })),
    }).pipe(Effect.ensuring(Effect.sync(() => pending.delete(id))));
  });

  const helloRaw = yield* request("hello", {
    protocolVersion: DIM_PROTOCOL_VERSION,
    clientKind: "other",
    clientName: input.clientName,
  });
  const hello = yield* Effect.try({
    try: () => decodeHello(helloRaw),
    catch: (cause) =>
      isDimTransportError(cause)
        ? cause
        : new DimTransportError({ detail: "Dim hello returned an unexpected result", cause }),
  });
  const refusal = checkHello(hello);
  if (refusal !== null) {
    return yield* refusal;
  }

  return {
    hello,
    request,
    notices: Stream.fromQueue(notices),
    closed: Deferred.await(closed),
  } satisfies DimConnection;
});

/** Whether `endpoint` has a live Dim socket file (a connection may still be refused). */
export function dimEndpointExists(endpoint: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") return true;
  return NodeFS.existsSync(endpoint);
}
