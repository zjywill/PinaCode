# PinaCode Privacy Policy

Last updated: November 16, 2026

This document describes PinaCode, the open-source fork maintained at
[zjywill/PinaCode](https://github.com/zjywill/PinaCode). PinaCode is separate from
T3 Tools and its hosted services.

## Your environments and providers

PinaCode stores projects, conversation history, settings, and logs on the machine
running the server. Its default data directory is `~/.pinacode`. Connecting a
client to a remote environment sends requests and conversation data to that
environment. The environment's operator controls its storage and access.

Agents and AI providers you choose receive the information needed to handle your
requests, which can include prompts, conversation context, attachments, and
workspace files. Their own terms and privacy policies apply. Local use and direct
pairing do not require a T3 account.

## Product usage data

PinaCode currently retains upstream product analytics. Unless disabled or
overridden by configuration, the server sends usage events to
`https://ingest.t3.codes`, an upstream T3 endpoint, rather than a PinaCode-operated
analytics service. Events can include provider and model names, settings used for
a turn, results, durations, release channel, token counts, and hashed installation,
device, or provider account identifiers.

Product analytics events do not include prompts, responses, file contents,
authentication tokens, conversation IDs, or raw provider events. Diagnostics and
third-party services are separate from these product events.

To disable server product analytics, set `T3CODE_TELEMETRY_ENABLED=false` before
starting the server. This setting retains its upstream name. For desktop builds,
set it in the shell environment and restart the app. An administrator's managed
policy can also disable telemetry.

## Diagnostics and optional services

Crash reporting, relay tracing, and diagnostic exports depend on the build and
configuration. Mobile crash reports require a configured relay; supported builds
provide a **Send crash reports** setting under Diagnostics. Diagnostic reports
can contain error messages, stack traces, device information, and startup timings.
Error messages can contain values involved in a failure.

You can configure OpenTelemetry exports to a receiver you control in Diagnostics.
Disabling server product analytics does not disable independently configured
client diagnostics, provider telemetry, or exports you configure. Review the
settings and policies of any relay, remote server, or other service you use.

## Your choices and contact

You control which environments and providers you connect, their credentials, and
the local data on machines you operate. Removing local data does not remove
copies already sent to a provider, remote environment, or diagnostics service.

For questions about PinaCode's data handling, use the
[PinaCode issue tracker](https://github.com/zjywill/PinaCode/issues). Issues are
public; do not include credentials or private conversation content. Requests
about data held by third-party services should be directed to those services.
