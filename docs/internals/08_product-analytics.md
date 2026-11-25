# Product analytics

PinaCode accepts upstream analytics calls through a local no-op service. Clients omit analytics owner identifiers when connecting to an environment. Relay operations use the local tracer. Operator-configured OpenTelemetry export is independent of product analytics.
