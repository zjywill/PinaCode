# Product usage data

The T3 Code server sends product usage events to T3 Code's own endpoint at `ingest.t3.codes`,
associated with a hashed random identifier for the installation. To count how many installations one person
uses, the server also sends a hashed identifier for your T3 Connect account when you are signed in
to one, and a random identifier for each device that connects. The endpoint keeps a copy of each
event and forwards events to PostHog. Events include the provider, model, reasoning effort,
permission mode, turn and request results, duration, release channel, and token counts when
available. Child-agent token counts are reported separately from the main agent's. Models from a
provider's catalog are reported by name, even when a custom endpoint serves them. Any other
model, such as a local or fine-tuned one, is reported only as a custom model of that provider.

Product events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, child-agent output, or identifiers from your provider accounts.

## Relay connection diagnostics

T3 Code sends relay connection traces to Axiom to diagnose T3 Connect connectivity. These are
separate from product events. Traces carry connection timings, request paths, environment and
thread identifiers, and error types. They omit machine addresses, query strings, log lines,
error messages, and stack frames.

To disable product events and relay tracing from the server, set
`T3CODE_TELEMETRY_ENABLED=false` in its environment before starting it. Relay tracing also stops
when `T3CODE_OTEL_SDK_DISABLED` or `OTEL_SDK_DISABLED` turns OpenTelemetry export off.

An administrator can turn product events and relay tracing off in the server and desktop app with
a [managed policy](./managed-policy.md#other-capabilities). This does not control traces sent by
the hosted web app or mobile clients.

The desktop app reads `T3CODE_TELEMETRY_ENABLED` from your shell profile (for example `~/.zshrc`) on macOS and
Linux, so export it there and restart the app. On Windows, set it as a user environment variable.

A browser opened from a Pina Code server sends relay traces only while connected and allowed by that
server's policy. The hosted web app sends relay traces when configured and has no tracing toggle.

## Mobile app diagnostics

When the iOS or Android app crashes or hits an error, it sends a report to T3 Code: the error
message, the stack trace, the app version, and the device model and OS version. Each launch also
sends startup timings, and every report carries a random ID for the install. Reports go through
the T3 Connect relay to Axiom. They do not include your threads, prompts, or connection details,
but an error message can quote a value the app was handling.

To stop sending them, turn off **Send crash reports** in **Settings > About Pina Code > Diagnostics**.

The mobile app also sends relay connection traces when its build has tracing configured. These
carry an identifier for the current app session. To stop them, turn off **Send connection traces**
in **Settings > About Pina Code > Diagnostics**. This is separate from crash reports. Server environment variables and managed policy do
not disable mobile tracing.

## Export diagnostics to your own receiver

To send traces, metrics, or logs to an OpenTelemetry receiver, open
**Settings > Maintenance > Diagnostics**, select an environment, and enter each signal's OTLP HTTP
endpoint under **OpenTelemetry export** (for example `http://localhost:4318/v1/traces`). Save, then
restart that environment's server. The receiver must be reachable from the server's machine.
**Test** sends an empty export from the server to check an endpoint before or after you save it;
saved endpoints are checked when the section opens. Checks send authentication headers only to
the signal's currently running endpoint and do not follow redirects. To check a new endpoint
that requires authentication, save it and restart the server first.

`T3CODE_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` environment variables override the saved
settings. An overridden signal shows **Set by environment** and names the variable that set it, and its
**Test** checks the running endpoint instead of the field. For endpoints saved here or set with `T3CODE_OTLP_*_URL`, set `T3CODE_OTLP_HEADERS` for
receivers that need authentication and `T3CODE_OTLP_PROTOCOL=http/protobuf` for receivers that do
not accept JSON. An endpoint set with `OTEL_EXPORTER_OTLP_*` takes its headers and protocol from
`OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_PROTOCOL` instead.
