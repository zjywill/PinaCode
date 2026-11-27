import {
  CommandId,
  MessageId,
  isPinaThread,
  reportsTurnsToPina,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import {
  subagentResultForRun,
  SUBAGENT_RESULT_TURN_ITEM_TYPES,
} from "@t3tools/provider-core/server/subagentProjection";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { forkParked } from "../serverActivation.ts";
import { CommandReceiptStoreV2 } from "./CommandReceiptStore.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { ThreadLaunchService } from "./ThreadLaunchService.ts";

export const make = Effect.gen(function* () {
  const engine = yield* ThreadManagementService;
  const projections = yield* ProjectionStoreV2;
  const launch = yield* ThreadLaunchService;
  const receipts = yield* CommandReceiptStoreV2;
  const sql = yield* SqlClient.SqlClient;

  const report = Effect.fn("PinaTurnReports.report")(function* (run: OrchestrationV2Run) {
    if (isPinaThread(run.threadId) || run.delegatedTaskId !== undefined) return;
    const thread = yield* projections.findThread(run.threadId);
    if (!thread || thread.deletedAt !== null) return;
    const trigger = yield* projections.getRunMessage(run.threadId, run.id);
    if (!reportsTurnsToPina(thread, trigger?.createdBy)) return;
    // Pina's own dispatched tasks already send their result through reportBack.
    if (trigger?.senderThreadId && isPinaThread(trigger.senderThreadId)) return;
    const key = `pina-turn-report:${thread.id}:${run.id}`;
    let commandId = CommandId.make(`server:${key}`);
    // Rejected command ids stay rejected even after the destination becomes available.
    for (let attempt = 1; ; attempt++) {
      const receipt = yield* receipts.getByCommandId(commandId);
      if (Option.isNone(receipt)) break;
      if (receipt.value.status === "accepted") return;
      commandId = CommandId.make(`server:${key}:retry:${attempt}`);
    }
    const records = yield* projections.getThreadRecords(thread.id, ["messages", "turnItems"], {
      messageRoles: ["assistant"],
      messageRunIds: [run.id],
      turnItemRunIds: [run.id],
      turnItemTypes: SUBAGENT_RESULT_TURN_ITEM_TYPES,
    });
    const result = subagentResultForRun({ ...records, providerTurns: [] }, run);
    const excerpt =
      result.messageId === null && result.turnItemId === null ? "" : result.text.trim();
    const link = formatThreadLink({ environmentId: null, threadId: thread.id }, thread.title);
    const summary = `${thread.title} · ${run.status}`;
    const pina = yield* launch.openPina();
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId,
      threadId: pina.threadId,
      messageId: MessageId.make(`message:${key}`),
      senderThreadId: thread.id,
      text:
        `Session report from ${link}. Turn ${run.id} ${run.status}.` +
        (excerpt
          ? `\n\nReported output (for reference):\n${excerpt.length > 4000 ? excerpt.slice(0, 3999) + "…" : excerpt}`
          : ""),
      notification: {
        source: { kind: "system", reportingThreadId: thread.id },
        outcome:
          run.status === "failed"
            ? "failed"
            : run.status === "completed"
              ? "completed"
              : "cancelled",
        summary,
      },
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
  });

  const events = Stream.unwrap(
    Effect.gen(function* () {
      const [cursor] = yield* sql<{ last_sequence: number; enabled_at: string }>`
      SELECT last_sequence, enabled_at FROM pina_turn_report_cursor WHERE id = 1`;
      if (!cursor) return yield* Effect.die("Missing Pina turn report cursor");
      return engine
        .streamStoredEventsFrom({ afterSequence: cursor.last_sequence, eventType: "run.updated" })
        .pipe(
          Stream.tap(
            Effect.fnUntraced(function* ({ event, sequence }) {
              if (event.type !== "run.updated") return;
              const run = event.payload;
              if (
                !run.completedAt ||
                !["completed", "failed", "interrupted", "cancelled"].includes(run.status)
              )
                return;
              if (DateTime.formatIso(run.completedAt) >= cursor.enabled_at) yield* report(run);
              yield* sql`UPDATE pina_turn_report_cursor SET last_sequence = ${sequence} WHERE id = 1 AND last_sequence < ${sequence}`;
            }),
          ),
        );
    }),
  );
  return events;
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* make;
    yield* forkParked(
      events.pipe(
        Stream.runDrain,
        Effect.tapError((error) =>
          Effect.logWarning("Pina turn report delivery will retry", { error }),
        ),
        Effect.retry(Schedule.spaced("5 seconds")),
      ),
    );
  }),
);
