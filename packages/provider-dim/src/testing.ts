// @effect-diagnostics nodeBuiltinImport:off -- replay transcripts carry JSON objects, not node APIs.
// @effect-diagnostics effectFnOpportunity:off -- replay helpers are session-local closures.
import { ProviderReplayEntry, type ProviderReplayTranscript } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  DIM_PROTOCOL_VERSION,
  DIM_REPLAY_ANY,
  recordField,
  recordString,
  type DimHelloResult,
  type DimNotice,
} from "./server/protocol.ts";
import {
  DimRpcError,
  DimTransportError,
  type DimConnection,
  type DimConnectionError,
  type DimRequestOptions,
} from "./server/transport.ts";
import type { DimConnectionFactory, DimConnectionFactoryError } from "./server/adapter.ts";

export { DimTransportError } from "./server/transport.ts";

export const DIM_REPLAY_PROTOCOL = "dim.ndjson-v1";
export const DIM_REPLAY_VERSION = "1";

export const DimReplayTranscript = Schema.Struct({
  provider: Schema.Literal("dim"),
  protocol: Schema.Literal(DIM_REPLAY_PROTOCOL),
  version: Schema.String,
  scenario: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  entries: Schema.Array(ProviderReplayEntry),
});
export type DimReplayTranscript = typeof DimReplayTranscript.Type;

const decodeTranscript = Schema.decodeUnknownSync(DimReplayTranscript);
const isDimRpcError = Schema.is(DimRpcError);

export function decodeDimReplayTranscript(
  transcript: ProviderReplayTranscript,
): DimReplayTranscript {
  return decodeTranscript(transcript);
}

/** Whether an actual value satisfies a recorded frame, with `<any>` standing for run-specific values. */
export function dimReplayMatches(expected: unknown, actual: unknown): boolean {
  if (expected === DIM_REPLAY_ANY) return true;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((entry, index) => dimReplayMatches(entry, actual[index]))
    );
  }
  if (typeof expected === "object" && expected !== null) {
    if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return false;
    const expectedRecord = expected as Record<string, unknown>;
    const actualRecord = actual as Record<string, unknown>;
    const keys = new Set([...Object.keys(expectedRecord), ...Object.keys(actualRecord)]);
    return [...keys].every((key) => dimReplayMatches(expectedRecord[key], actualRecord[key]));
  }
  return Object.is(expected, actual);
}

const RUN_SPECIFIC_KEYS = new Set(["submissionId", "cwd", "expectedCwd", "bindingId"]);

/** Masks ids and paths that differ between the recording and the replay workspace. */
export function normalizeDimRecordedValue(
  value: unknown,
  mask: (value: string) => boolean = () => false,
): unknown {
  if (Array.isArray(value)) return value.map((entry) => normalizeDimRecordedValue(entry, mask));
  if (typeof value !== "object" || value === null) {
    return typeof value === "string" && mask(value) ? DIM_REPLAY_ANY : value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      RUN_SPECIFIC_KEYS.has(key) ? DIM_REPLAY_ANY : normalizeDimRecordedValue(entry, mask),
    ]),
  );
}

export function dimErrorFrame(error: DimConnectionError): unknown {
  if (isDimRpcError(error)) {
    return {
      code: error.code,
      message: error.detail,
      ...(error.appError === undefined ? {} : { data: { appError: error.appError } }),
    };
  }
  return { code: -32000, message: error.message };
}

function rpcErrorFromFrame(method: string, frame: Record<string, unknown>): DimRpcError {
  const error = recordField(frame, "error");
  return new DimRpcError({
    method,
    code:
      typeof recordField(error, "code") === "number"
        ? (recordField(error, "code") as number)
        : -32603,
    ...(recordString(recordField(error, "data"), "appError") === undefined
      ? {}
      : { appError: recordString(recordField(error, "data"), "appError") }),
    detail: recordString(error, "message") ?? "Dim error",
  });
}

/**
 * Wraps a live connection and appends every outbound request and inbound frame to `entries`.
 * The proxy's notices preserve the live order, so a replay sees the same interleaving.
 */
export const recordDimConnection = Effect.fn("DimReplay.recordConnection")(function* (
  live: DimConnection,
  entries: Array<ProviderReplayEntry>,
  options: { readonly mask?: (value: string) => boolean } = {},
) {
  const notices = yield* Queue.unbounded<DimNotice, Cause.Done>();
  const closed = yield* Deferred.make<void>();
  let nextRecordedId = 1;
  yield* Stream.runForEach(live.notices, (notice) =>
    Effect.sync(() => {
      entries.push({
        type: "emit_inbound",
        frame: { method: notice.method, params: notice.params },
      });
      Queue.offerUnsafe(notices, notice);
    }),
  ).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        Queue.endUnsafe(notices);
        Deferred.doneUnsafe(closed, Effect.void);
        entries.push({ type: "runtime_exit", status: "success" });
      }),
    ),
    Effect.forkScoped,
  );
  const request: DimConnection["request"] = Effect.fn("DimReplay.recordRequest")(function* (
    method: string,
    params: Record<string, unknown> = {},
    requestOptions?: DimRequestOptions,
  ) {
    const recordedId = nextRecordedId++;
    entries.push({
      type: "expect_outbound",
      frame: {
        id: recordedId,
        method,
        params: normalizeDimRecordedValue(params, options.mask),
      },
    });
    const result = yield* live.request(method, params, requestOptions).pipe(Effect.result);
    if (result._tag === "Success") {
      entries.push({ type: "emit_inbound", frame: { id: recordedId, result: result.success } });
      return result.success;
    }
    entries.push({
      type: "emit_inbound",
      frame: { id: recordedId, error: dimErrorFrame(result.failure) },
    });
    return yield* result.failure;
  });
  return {
    hello: live.hello,
    request,
    notices: Stream.fromQueue(notices),
    closed: Deferred.await(closed),
  } satisfies DimConnection;
});

interface ReplayRequest {
  readonly connection: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly deferred: Deferred.Deferred<unknown, DimRpcError | DimTransportError>;
}

interface ReplayConnection {
  readonly id: number;
  readonly notices: Queue.Queue<DimNotice, Cause.Done>;
  readonly closed: Deferred.Deferred<void>;
}

function replayHello(result: unknown): DimHelloResult {
  const protocolVersion = recordField(result, "protocolVersion");
  const instanceId = recordString(result, "instanceId");
  const serverVersion = recordString(result, "serverVersion");
  const profile = recordField(result, "daemonProfile");
  const kind = recordString(profile, "kind");
  if (
    instanceId === undefined ||
    serverVersion === undefined ||
    typeof protocolVersion !== "number" ||
    (kind !== "mock" && kind !== "configured" && kind !== "product")
  ) {
    throw new DimTransportError({ detail: "Replay transcript has an invalid hello result" });
  }
  const features = recordField(result, "features");
  return {
    instanceId,
    serverVersion,
    protocolVersion,
    daemonProfile: { kind },
    ...(recordString(result, "buildId") === undefined
      ? {}
      : { buildId: recordString(result, "buildId")! }),
    ...(Array.isArray(features)
      ? { features: features.filter((entry): entry is string => typeof entry === "string") }
      : {}),
  };
}

/**
 * Replays a recorded Dim transcript: outbound expects must match the adapter's requests in order,
 * and inbound frames are delivered as responses or notices. The controller lives in the caller's scope.
 */
export const makeDimReplayConnectionFactory = Effect.fn("DimReplay.makeConnectionFactory")(
  function* (
    transcript: DimReplayTranscript,
  ): Effect.fn.Return<DimConnectionFactory, DimTransportError, Scope.Scope> {
    const entries = transcript.entries;
    const requests = yield* Queue.unbounded<ReplayRequest>();
    let cursor = 0;
    let active: ReplayConnection | null = null;
    let nextConnection = 1;
    let failed: DimTransportError | null = null;
    const bound = new Map<number, ReplayRequest>();

    const failAll = (error: DimTransportError) => {
      failed = error;
      if (active !== null) {
        Queue.endUnsafe(active.notices);
        Deferred.doneUnsafe(active.closed, Effect.void);
        active = null;
      }
    };

    yield* Effect.gen(function* () {
      while (cursor < entries.length) {
        if (failed !== null) return;
        const entry = entries[cursor]!;
        cursor += 1;
        if (entry.type === "expect_outbound") {
          const request = yield* Queue.take(requests);
          const frame = entry.frame;
          const method = recordString(frame, "method");
          const params = recordField(frame, "params") ?? {};
          if (
            method === undefined ||
            request.method !== method ||
            !dimReplayMatches(params, request.params)
          ) {
            failAll(
              new DimTransportError({
                detail: `Dim replay expected ${method ?? "<no method>"} but the adapter sent ${request.method}`,
              }),
            );
            Deferred.doneUnsafe(
              request.deferred,
              Effect.fail(new DimTransportError({ detail: "Replay stopped" })),
            );
            return;
          }
          const id = recordField(frame, "id");
          if (typeof id === "number") bound.set(id, request);
          continue;
        }
        if (entry.type === "emit_inbound") {
          const frame = entry.frame;
          if (typeof frame !== "object" || frame === null) continue;
          const record = frame as Record<string, unknown>;
          const id = record["id"];
          if (typeof id === "number") {
            const request = bound.get(id);
            bound.delete(id);
            if (request === undefined) continue;
            if (record["error"] !== undefined) {
              Deferred.doneUnsafe(
                request.deferred,
                Effect.fail(rpcErrorFromFrame(request.method, record)),
              );
            } else {
              Deferred.doneUnsafe(request.deferred, Effect.succeed(record["result"] ?? null));
            }
            continue;
          }
          if (active !== null) {
            Queue.offerUnsafe(active.notices, {
              method: recordString(record, "method") ?? "unknown",
              params: record["params"],
            });
          }
          continue;
        }
        // A runtime_exit is the recorder's marker for a scope close, not a timed event; the
        // replay connection ends its notices when the adapter's own scope closes instead.
        if (entry.type === "runtime_exit") continue;
      }
    }).pipe(Effect.forkScoped);

    const enqueue = Effect.fn("DimReplay.enqueue")(function* (
      method: string,
      params: Record<string, unknown>,
      _timeout?: unknown,
    ): Effect.fn.Return<unknown, DimRpcError | DimTransportError> {
      if (failed !== null) return yield* failed;
      if (active === null) {
        return yield* new DimTransportError({ detail: "Dim replay has no open connection" });
      }
      const deferred = yield* Deferred.make<unknown, DimRpcError | DimTransportError>();
      yield* Queue.offer(requests, {
        connection: active.id,
        method,
        params,
        deferred,
      });
      return yield* Deferred.await(deferred);
    });

    const connect = Effect.fn("DimReplay.connect")(function* (input: {
      readonly threadId?: unknown;
      readonly clientName: string;
    }) {
      if (failed !== null) return yield* failed;
      const notices = yield* Queue.unbounded<DimNotice, Cause.Done>();
      const closed = yield* Deferred.make<void>();
      const connection: ReplayConnection = { id: nextConnection++, notices, closed };
      active = connection;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          Queue.endUnsafe(notices);
          Deferred.doneUnsafe(closed, Effect.void);
          if (active === connection) active = null;
        }),
      );
      const hello = yield* enqueue("hello", {
        protocolVersion: DIM_PROTOCOL_VERSION,
        clientKind: "other",
        clientName: input.clientName,
      });
      return {
        hello: replayHello(hello),
        request: (method, params = {}, options) => enqueue(method, params, options?.timeout),
        notices: Stream.fromQueue(notices),
        closed: Deferred.await(closed),
      } satisfies DimConnection;
    });

    return { connect } satisfies DimConnectionFactory;
  },
);

export type DimReplayConnectionFactoryError = DimConnectionFactoryError;
