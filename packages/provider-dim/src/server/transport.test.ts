// @effect-diagnostics nodeBuiltinImport:off -- the test drives a real unix socket and temp directory.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { connectDim, DimProtocolVersionError, DimRpcError } from "./transport.ts";

const isDimRpcError = Schema.is(DimRpcError);
const isDimProtocolVersionError = Schema.is(DimProtocolVersionError);

const helloResult = (protocolVersion: number) => ({
  instanceId: "instance-1",
  serverVersion: "0.1.0-alpha.26",
  buildId: "build-1",
  protocolVersion,
  daemonProfile: { kind: "mock" },
  features: [
    "session.create",
    "session.submit",
    "session.stop",
    "session.history",
    "session.model.progress",
    "session.branch.get",
    "session.input_lookup",
  ],
});

const withServer = <A, E, R>(
  handler: (socket: NodeNet.Socket) => void,
  use: (endpoint: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | Scope.Scope> =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "dim-transport-"));
      const endpoint = NodePath.join(directory, "daemon.sock");
      const server = NodeNet.createServer(handler);
      await new Promise<void>((resolve) => server.listen(endpoint, resolve));
      return {
        endpoint,
        close: async () => {
          await new Promise<void>((resolve) => server.close(() => resolve()));
          NodeFS.rmSync(directory, { recursive: true, force: true });
        },
      };
    }),
    (server) => Effect.promise(server.close),
  ).pipe(Effect.flatMap((server) => use(server.endpoint)));

const respond = (socket: NodeNet.Socket, id: number, body: Record<string, unknown>) => {
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`);
};

describe("connectDim", () => {
  it.live("greets, correlates replies, and delivers notices", () =>
    withServer(
      (socket) => {
        socket.setEncoding("utf8");
        let buffer = "";
        socket.on("data", (chunk: string) => {
          buffer += chunk;
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const frame = JSON.parse(buffer.slice(0, newline)) as {
              id: number;
              method: string;
              params: Record<string, unknown>;
            };
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
            if (frame.method === "hello") {
              respond(socket, frame.id, { result: helloResult(4) });
            } else if (frame.method === "echo") {
              respond(socket, frame.id, { result: frame.params });
            } else if (frame.method === "notice") {
              socket.write(
                `${JSON.stringify({ jsonrpc: "2.0", method: "session.state", params: { running: true } })}\n`,
              );
              respond(socket, frame.id, { result: { ok: true } });
            } else if (frame.method === "boom") {
              respond(socket, frame.id, {
                error: { code: -32000, message: "nope", data: { appError: "session_closed" } },
              });
            }
          }
        });
      },
      (endpoint) =>
        Effect.gen(function* () {
          const connection = yield* connectDim({ endpoint, clientName: "test" });
          assert.strictEqual(connection.hello.protocolVersion, 4);
          assert.include(connection.hello.features ?? [], "session.submit");
          assert.deepEqual(yield* connection.request("echo", { value: 1 }), { value: 1 });
          assert.deepEqual(yield* connection.request("notice"), { ok: true });
          const notice = yield* Stream.runHead(connection.notices);
          assert.strictEqual(notice._tag, "Some");
          if (notice._tag === "Some") {
            assert.strictEqual(notice.value.method, "session.state");
            assert.deepEqual(notice.value.params, { running: true });
          }
          const failed = yield* connection.request("boom").pipe(
            Effect.match({
              onFailure: (error) => error,
              onSuccess: () => undefined,
            }),
          );
          assert.isTrue(isDimRpcError(failed));
          assert.strictEqual((failed as DimRpcError).appError, "session_closed");
        }),
    ),
  );

  it.live("refuses a daemon that speaks another protocol version", () =>
    withServer(
      (socket) => {
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          const frame = JSON.parse(chunk.toString().split("\n")[0]!) as { id: number };
          respond(socket, frame.id, { result: helloResult(3) });
        });
      },
      (endpoint) =>
        connectDim({ endpoint, clientName: "test" }).pipe(
          Effect.match({
            onFailure: (error) => error,
            onSuccess: () => undefined,
          }),
          Effect.map((failed) => {
            assert.isTrue(isDimProtocolVersionError(failed));
            assert.strictEqual((failed as DimProtocolVersionError).found, 3);
            assert.strictEqual((failed as DimProtocolVersionError).required, 4);
          }),
        ),
    ),
  );
});
