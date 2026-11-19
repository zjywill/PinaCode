// @effect-diagnostics nodeBuiltinImport:off -- the test needs a real symlink on disk.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { readDimSessionPage } from "./sessions.ts";

describe("readDimSessionPage", () => {
  it.effect("asks the catalog for both paths, within Dim's page limit", () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "dimspk-sessions."));
      const target = NodePath.join(root, "workspace");
      NodeFS.mkdirSync(target);
      const link = NodePath.join(root, "linked-workspace");
      NodeFS.symlinkSync(target, link);
      const realTarget = NodeFS.realpathSync(target);
      const requests: Array<Record<string, unknown> | undefined> = [];
      yield* readDimSessionPage(
        (_method, params) => {
          requests.push(params);
          return Effect.succeed({ sessions: [], nextCursor: null });
        },
        { cwd: link },
      ).pipe(
        Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
      );
      assert.deepEqual(requests[0]?.["cwd"], [link, realTarget]);
      // Dim answers a larger page with invalid_params, which empties the import list.
      assert.isAtMost(Number(requests[0]?.["limit"]), 200);
    }),
  );
});
