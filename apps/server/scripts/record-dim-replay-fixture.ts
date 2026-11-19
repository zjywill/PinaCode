// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalRandom:off globalConsole:off effectFnOpportunity:off -- a standalone recorder talks to a daemon, the filesystem and an HTTP fixture directly; Effect services buy nothing at this boundary.
// Records a Dim App Server transcript from a local, zero-cost daemon.
//
// Usage: node scripts/record-dim-replay-fixture.ts --scenario simple
//
// The mock model only understands `tool:<name> <json>`; the shared scenarios use prose prompts and
// tool calls, so this recorder serves `--model-config` with a local OpenAI-compatible model. Nothing
// leaves the machine. The Dim daemon writes its own SQLite under a temp home deleted on exit.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, type ProviderReplayEntry } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { DIM_PROVIDER, connectDim, makeDimAdapterV2 } from "@t3tools/provider-dim/server";
import type { DimReplayTranscript } from "@t3tools/provider-dim/testing";
import { recordDimConnection } from "@t3tools/provider-dim/testing";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

import * as ProviderAdapterRegistry from "../src/orchestration-v2/ProviderAdapterRegistry.ts";
import { provideDeterministicTestRuntime } from "../src/orchestration-v2/testkit/DeterministicRuntime.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "../src/orchestration-v2/testkit/fixtures/index.ts";
import { materializeFixtureInput } from "../src/orchestration-v2/testkit/fixtures/shared.ts";
import {
  runOrchestratorV2ProviderReplayScenario,
  type OrchestratorV2ProviderReplayHarness,
} from "../src/orchestration-v2/testkit/ProviderReplayHarness.ts";

const scenarioName = (() => {
  const index = process.argv.indexOf("--scenario");
  return index === -1 ? undefined : process.argv[index + 1];
})();

if (scenarioName === undefined) {
  throw new Error(
    `Pass --scenario with a Dim fixture: ${ORCHESTRATOR_REPLAY_FIXTURES.filter((fixture) =>
      fixture.providers.some((provider) => provider.driver === DIM_PROVIDER),
    )
      .map((fixture) => fixture.name)
      .join(", ")}`,
  );
}

const fixture = ORCHESTRATOR_REPLAY_FIXTURES.find((entry) => entry.name === scenarioName);
const variant = fixture?.providers.find((provider) => provider.driver === DIM_PROVIDER);
if (fixture === undefined || variant === undefined) {
  throw new Error(`Fixture ${scenarioName} has no Dim provider variant`);
}

const binary = process.env.T3_DIM_BIN ?? "dima";

interface FakeModel {
  readonly url: string;
  readonly close: () => Promise<void>;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      typeof part === "object" && part !== null && "text" in part
        ? [String((part as { text?: unknown }).text ?? "")]
        : [],
    )
    .join("");
}

function messageText(messages: ReadonlyArray<{ role?: string; content?: unknown }>): {
  lastUser: string;
  lastAssistant: string;
} {
  let lastUser = "";
  let lastAssistant = "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const text = textOf(message.content);
    if (message.role === "user" && lastUser === "" && !text.trimStart().startsWith("<dim-state")) {
      lastUser = text;
    }
    if (message.role === "assistant" && lastAssistant === "") lastAssistant = text;
  }
  return { lastUser, lastAssistant };
}

/** A deterministic local model; every prompt the fixtures use gets a fixture-shaped answer. */
async function startFakeModel(): Promise<FakeModel> {
  // Tool-call prompts need one more model call after their tool result.
  const phases = new Map<string, number>();
  const phaseOf = (prompt: string) => {
    const phase = phases.get(prompt) ?? 0;
    phases.set(prompt, phase + 1);
    return phase;
  };
  const server = NodeHttp.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const decoded = (() => {
        try {
          return JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }> };
        } catch {
          return {};
        }
      })();
      const messages = Array.isArray(decoded.messages) ? decoded.messages : [];
      const system = messages.find((message) => message.role === "system");
      const { lastUser, lastAssistant } = messageText(messages);
      const reply = (content: string) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({ id: "dim-fixture", choices: [{ index: 0, delta: { content }, finish_reason: "stop" }] })}\n\n`,
        );
        response.write("data: [DONE]\n\n");
        response.end();
      };
      const tool = (name: string, args: Record<string, unknown>) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({
            id: "dim-fixture",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call-${Math.random().toString(16).slice(2)}`,
                      type: "function",
                      function: { name, arguments: JSON.stringify(args) },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          })}\n\n`,
        );
        response.write("data: [DONE]\n\n");
        response.end();
      };
      if (textOf(system?.content).includes("Write a short title")) {
        reply("Dim fixture");
        return;
      }
      if (lastUser.includes("sleep 30")) {
        tool("exec", { command: "sleep 30", title: "fixture wait" });
        return;
      }
      if (lastUser.includes("steering fixture initial response")) {
        tool("exec", { command: "sleep 3", title: "fixture wait" });
        return;
      }
      if (lastUser.includes("Use request_user_input to ask one multiple-choice")) {
        if (phaseOf("plan-questions") === 0) {
          tool("ask_user", {
            questions: [
              {
                id: "schema_vs_ui_flexibility",
                header: "Schemas",
                question: "Should this fixture prefer strict schemas or UI flexibility?",
                options: [
                  { label: "Strict schemas (Recommended)", description: "Typed contracts" },
                  { label: "UI flexibility", description: "Loose client shapes" },
                ],
                multiSelect: false,
                allowCustom: true,
              },
            ],
          });
          return;
        }
        reply("plan questions fixture complete");
        return;
      }
      if (lastUser.includes("Use the Write tool once to create .claude-denied-write.txt")) {
        if (phaseOf("denied-write") === 0) {
          tool("exec", {
            command: "printf 'approval fixture' > .claude-denied-write.txt",
            title: "fixture write",
          });
          return;
        }
        reply("write permission denied");
        return;
      }
      if (lastUser.includes("Create or overwrite .codex-probe-write-action.txt")) {
        const phase = phaseOf("approved-write");
        if (phase === 0) {
          tool("write", {
            path: ".codex-probe-write-action.txt",
            content: "codex app-server approval fixture",
          });
          return;
        }
        if (phase === 1) {
          tool("exec", {
            command: "printf 'codex app-server approval fixture' > .codex-probe-write-action.txt",
            title: "fixture write",
          });
          return;
        }
        reply("Wrote the file.");
        return;
      }
      if (lastUser.includes("first repeat the exact final answer")) {
        reply(`${lastAssistant}\nprovider thread resume fixture second turn complete`);
        return;
      }
      const exact = /exactly: (.*)/s.exec(lastUser) ?? /following text: (.*)/s.exec(lastUser);
      if (exact !== null) {
        reply(exact[1]!.trim());
        return;
      }
      reply(lastUser.trim() === "" ? "Dim fixture response" : `Dim fixture: ${lastUser}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Fake model did not bind");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function waitForSocket(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (NodeFS.existsSync(path)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Dim daemon did not bind ${path}`);
}

async function main() {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "dimspk."));
  NodeFS.chmodSync(home, 0o700);
  const nativeHome = NodePath.join(home, "rust");
  NodeFS.mkdirSync(nativeHome, { mode: 0o700 });
  const socketPath = NodePath.join(nativeHome, "daemon.sock");
  const logPath = NodePath.join(home, "daemon.log");
  const model = await startFakeModel();
  const configPath = NodePath.join(home, "model-config.json");
  NodeFS.writeFileSync(
    configPath,
    JSON.stringify({
      defaultModel: { providerId: "fixture", modelId: "fixture" },
      providers: [
        {
          id: "fixture",
          kind: "openai-compatible",
          baseUrl: model.url,
          models: [
            {
              id: "fixture",
              contextWindow: 128_000,
              maxOutputTokens: 8_192,
              config: { maxTokens: 8_192 },
            },
          ],
        },
      ],
    }),
  );
  const environment: NodeJS.ProcessEnv = { ...process.env, MISE_OFFLINE: "1" };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("DIM_")) delete environment[name];
  }
  const daemon = NodeChildProcess.spawn(
    binary,
    [
      "app-server",
      "--model-config",
      configPath,
      "--unix",
      socketPath,
      "--no-ws",
      "--home",
      nativeHome,
    ],
    {
      cwd: home,
      env: environment,
      stdio: ["ignore", "ignore", NodeFS.openSync(logPath, "a")],
    },
  );
  const daemonPid = daemon.pid;
  const entries: ProviderReplayEntry[] = [];
  let workspaceRoot: string | null = null;

  try {
    await waitForSocket(socketPath, 20_000);
    const fixtureInput = fixture!.buildInput();
    const recordingHarness: OrchestratorV2ProviderReplayHarness<DimReplayTranscript, never> = {
      driver: DIM_PROVIDER,
      decodeTranscript: (transcript) => Effect.succeed(transcript as DimReplayTranscript),
      makeProviderAdapterRegistryLayer: () =>
        Layer.effect(
          ProviderAdapterRegistry.ProviderAdapterRegistryV2,
          Effect.gen(function* () {
            const adapter = yield* makeDimAdapterV2({
              instanceId: ProviderInstanceId.make("dim"),
              connections: {
                connect: Effect.fn("DimRecorder.connect")(function* ({
                  clientName,
                }: {
                  readonly clientName: string;
                }) {
                  const live = yield* connectDim({ endpoint: socketPath, clientName });
                  entries.push(
                    {
                      type: "expect_outbound",
                      frame: {
                        id: 0,
                        method: "hello",
                        params: {
                          protocolVersion: 4,
                          clientKind: "other",
                          clientName,
                        },
                      },
                    },
                    { type: "emit_inbound", frame: { id: 0, result: live.hello } },
                  );
                  return yield* recordDimConnection(live, entries, {
                    mask: (value) =>
                      workspaceRoot !== null &&
                      (value === workspaceRoot || value.startsWith(`${workspaceRoot}/`)),
                  });
                }),
              },
            });
            return ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
              get: () => Effect.succeed(adapter),
              list: () => Effect.succeed([ProviderInstanceId.make("dim")]),
            });
          }),
        ).pipe(
          Layer.provide(
            Layer.mergeAll(
              TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
              NodeServices.layer,
              IdAllocator.layer,
            ),
          ),
        ),
    };

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const workspace = yield* checkpointWorkspace(fixture!.name, fixtureInput.workspaceFiles);
          workspaceRoot = workspace;
          const materialized = yield* materializeFixtureInput({
            scenario: fixture!.name,
            fixtureInput,
            driver: DIM_PROVIDER,
            modelSelection: variant!.modelSelection,
            ...(variant!.runtimeMode === undefined ? {} : { runtimeMode: variant!.runtimeMode }),
          }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
          yield* runOrchestratorV2ProviderReplayScenario(
            {
              name: `${fixture!.name}/dim`,
              transcript: {
                provider: "dim",
                protocol: "dim.ndjson-v1",
                version: "1",
                scenario: fixture!.name,
                entries: [],
              },
              commands: materialized.commands,
              steps: materialized.steps,
              projectionThreadIds: materialized.projectionThreadIds,
              runtimePolicyOverride: { cwd: workspace },
            },
            recordingHarness,
          ).pipe(provideDeterministicTestRuntime);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
    void result;
  } finally {
    if (daemonPid !== undefined) {
      try {
        process.kill(daemonPid, "SIGTERM");
      } catch {
        // Already gone.
      }
      await new Promise<void>((resolve) => {
        if (daemon.exitCode !== null) return resolve();
        daemon.once("exit", () => resolve());
        setTimeout(resolve, 5_000);
      });
    }
    await model.close();
    NodeFS.rmSync(home, { recursive: true, force: true });
  }

  const header = {
    type: "transcript_start",
    provider: "dim",
    protocol: "dim.ndjson-v1",
    version: "1",
    scenario: fixture!.name,
    metadata: { recordedWith: "dim-model-fixture" },
  };
  const target = NodeURL.fileURLToPath(variant!.transcriptFile);
  NodeFS.writeFileSync(
    target,
    [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
  console.log(`Wrote ${entries.length} entries to ${NodePath.relative(process.cwd(), target)}`);
}

await main();
