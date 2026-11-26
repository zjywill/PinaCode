import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE pina_turn_report_cursor (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_sequence INTEGER NOT NULL,
    enabled_at TEXT NOT NULL
  )`;
  // Existing sessions participate from the upgrade onward, including a turn already running.
  yield* sql`INSERT INTO pina_turn_report_cursor
    SELECT 1, COALESCE(MAX(sequence), 0), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM orchestration_events`;
});
