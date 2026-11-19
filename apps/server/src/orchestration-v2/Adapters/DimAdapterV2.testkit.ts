import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, type ProviderReplayTranscript } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { DIM_PROVIDER, makeDimAdapterV2 } from "@t3tools/provider-dim/server";
import {
  decodeDimReplayTranscript,
  DimTransportError,
  makeDimReplayConnectionFactory,
  type DimReplayTranscript,
} from "@t3tools/provider-dim/testing";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";

import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";

class DimReplayTranscriptDecodeError extends Schema.TaggedError<DimReplayTranscriptDecodeError>()(
  "DimReplayTranscriptDecodeError",
  {
    scenario: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode the Dim replay transcript for ${this.scenario}.`;
  }
}

const INSTANCE_ID = ProviderInstanceId.make("dim");

export const DimOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  DimReplayTranscript,
  DimReplayTranscriptDecodeError | DimTransportError
> = {
  driver: DIM_PROVIDER,
  decodeTranscript: (transcript: ProviderReplayTranscript) =>
    Effect.try({
      try: () => decodeDimReplayTranscript(transcript),
      catch: (cause) =>
        new DimReplayTranscriptDecodeError({ scenario: transcript.scenario, cause }),
    }),
  makeProviderAdapterRegistryLayer: (transcript) =>
    Layer.effect(
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      Effect.gen(function* () {
        const connections = yield* makeDimReplayConnectionFactory(transcript);
        const adapter = yield* makeDimAdapterV2({ instanceId: INSTANCE_ID, connections });
        return ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
          get: () => Effect.succeed(adapter),
          list: () => Effect.succeed([INSTANCE_ID]),
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
