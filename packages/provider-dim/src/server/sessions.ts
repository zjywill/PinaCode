// @effect-diagnostics nodeBuiltinImport:off -- catalog filtering needs the filesystem's realpath.
import * as NodeFS from "node:fs";

import * as Effect from "effect/Effect";

import { isRecord, recordArray, recordNumber, recordString } from "./protocol.ts";
import type { DimConnectionError } from "./transport.ts";

export interface DimSessionPageEntry {
  readonly sessionId: string;
  readonly cwd: string;
  readonly title: string | null;
  readonly updatedAtMs: number | null;
}

export interface DimSessionPage {
  readonly sessions: ReadonlyArray<DimSessionPageEntry>;
  readonly nextCursor: string | null;
}

// Dim refuses a catalog page above 200 (`connection.rs`), below the RPC's 256-session cap.
const CATALOG_PAGE_LIMIT = 200;

// Dim stores canonical cwds and filters the catalog by exact string, so a project opened through a
// symlink (macOS /tmp included) needs both spellings.
function catalogCwds(cwd: string): ReadonlyArray<string> {
  try {
    const resolved = NodeFS.realpathSync(cwd);
    return resolved === cwd ? [cwd] : [cwd, resolved];
  } catch {
    return [cwd];
  }
}

/** One `session.catalog` page for a workspace, as Dim reports it. */
export const readDimSessionPage = Effect.fn("DimSessions.readPage")(function* (
  request: (
    method: string,
    params?: Record<string, unknown>,
  ) => Effect.Effect<unknown, DimConnectionError>,
  input: { readonly cwd: string; readonly cursor?: string },
) {
  const reply = yield* request("session.catalog", {
    cwd: catalogCwds(input.cwd),
    limit: CATALOG_PAGE_LIMIT,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
  });
  if (!isRecord(reply)) return { sessions: [], nextCursor: null } satisfies DimSessionPage;
  const sessions = (recordArray(reply, "sessions") ?? []).flatMap(
    (entry): DimSessionPageEntry[] => {
      if (!isRecord(entry)) return [];
      const sessionId = recordString(entry, "sessionId");
      const cwd = recordString(entry, "cwd");
      if (sessionId === undefined || cwd === undefined) return [];
      return [
        {
          sessionId,
          cwd,
          title: recordString(entry, "title") ?? null,
          updatedAtMs: recordNumber(entry, "updatedAt") ?? null,
        },
      ];
    },
  );
  return {
    sessions,
    nextCursor: recordString(reply, "nextCursor") ?? null,
  } satisfies DimSessionPage;
});
