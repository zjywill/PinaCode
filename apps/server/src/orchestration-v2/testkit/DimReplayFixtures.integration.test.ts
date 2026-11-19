import { describe } from "@effect/vitest";

import { DimOrchestratorReplayHarness } from "../Adapters/DimAdapterV2.testkit.ts";
import { itRunsReplayFixtures, runReplayFixture } from "./ProviderReplayFixtures.ts";

describe("Dim replay fixtures", () => {
  itRunsReplayFixtures("dim", (input) =>
    runReplayFixture({ ...input, harness: DimOrchestratorReplayHarness }),
  );
});
