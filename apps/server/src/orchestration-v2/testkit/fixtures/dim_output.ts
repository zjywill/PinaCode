import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertRuntimeRequestCounts,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessageInputIntents,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  MESSAGE_STEERING_INITIAL_PROMPT,
  MESSAGE_STEERING_STEER_PROMPT,
  PROVIDER_THREAD_RESUME_FIRST_PROMPT,
  PROVIDER_THREAD_RESUME_SECOND_PROMPT,
  projectionFor,
} from "./shared.ts";
import { assertSimpleOutput } from "./simple/codex_output.ts";
import { assertMultiTurnOutput } from "./multi_turn/codex_output.ts";
import { assertQueuedTurnOutput } from "./queued_turn/codex_output.ts";
import { assertTurnInterruptOutput } from "./turn_interrupt/codex_output.ts";

const DIM = "dim";

function assertDimBase(result: OrchestratorV2ScenarioResult, transcript: ProviderReplayTranscript) {
  assert.equal(transcript.provider, DIM);
  return projectionFor(result, transcript.scenario);
}

export function assertDimSimpleOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertDimBase(result, transcript);
  assertSimpleOutput(result, transcript);
}

export function assertDimMultiTurnOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertDimBase(result, transcript);
  assertMultiTurnOutput(result, transcript);
}

export function assertDimQueuedTurnOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertDimBase(result, transcript);
  assertQueuedTurnOutput(result, transcript);
}

export function assertDimTurnInterruptOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertDimBase(result, transcript);
  assertTurnInterruptOutput(result, transcript);
}

export function assertDimMessageSteeringOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = assertDimBase(result, transcript);
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertTurnItemTypes(projection, ["user_message", "assistant_message"]);
  assertRuntimeRequestCounts(projection, { total: 0 });
  assertUserMessagesInclude(projection, [
    MESSAGE_STEERING_INITIAL_PROMPT,
    MESSAGE_STEERING_STEER_PROMPT,
  ]);
  assertUserMessageInputIntents(projection, ["turn_start", "steer"]);
  assertAssistantTextIncludes(projection, "steering fixture observed");
  assert.equal(projection.runs.length, 1, "steering must attach to the active run");
  assert.equal(
    projection.providerTurns.length,
    1,
    "active steering must not create a new provider turn",
  );
}

export function assertDimProviderThreadResumeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const hellos = transcript.entries.filter(
    (entry) =>
      entry.type === "expect_outbound" &&
      typeof entry.frame === "object" &&
      entry.frame !== null &&
      Reflect.get(entry.frame, "method") === "hello",
  );
  assert.lengthOf(hellos, 2, "the idle release must open a second Dim connection");

  const projection = assertDimBase(result, transcript);
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [
    PROVIDER_THREAD_RESUME_FIRST_PROMPT,
    PROVIDER_THREAD_RESUME_SECOND_PROMPT,
  ]);
  assert.lengthOf(projection.providerThreads, 1, "resume must keep one provider thread");
  const answers = projection.turnItems.flatMap((item) =>
    item.type === "assistant_message" ? [item.text] : [],
  );
  assert.lengthOf(answers, 2);
  assert.include(
    answers[1],
    "provider thread resume fixture first turn complete",
    "the resumed session must remember the first answer",
  );
  assert.include(answers[1], "provider thread resume fixture second turn complete");
}
