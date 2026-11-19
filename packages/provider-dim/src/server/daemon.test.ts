import { assert, describe, it } from "@effect/vitest";

import { dimDaemonEndpoint, dimDaemonStartFailure } from "./daemon.ts";

describe("Dim daemon endpoint", () => {
  it("derives the Windows pipe from the native home", () => {
    const platform: NodeJS.Platform = "win32";
    const endpoint = dimDaemonEndpoint({ nativeHome: "/tmp/dim/rust", platform });
    assert.match(endpoint, /^\\\\.\\pipe\\dim-rust-[0-9a-f]{32}$/);
    assert.strictEqual(endpoint, dimDaemonEndpoint({ nativeHome: "/tmp/dim/rust", platform }));
    assert.notStrictEqual(endpoint, dimDaemonEndpoint({ nativeHome: "/tmp/other/rust", platform }));
    assert.strictEqual(
      dimDaemonEndpoint({ nativeHome: "/tmp/dim/rust", platform: "linux" }),
      "/tmp/dim/rust/daemon.sock",
    );
  });
});

describe("Dim daemon start failure", () => {
  it("names the daemon log when the process exited nonzero", () => {
    assert.strictEqual(
      dimDaemonStartFailure({
        exitStatus: "dima app-server exited with code 7",
        endpoint: "/tmp/dim/daemon.sock",
        binaryPath: "dima",
        logPath: "/tmp/dim/daemon.log",
      }),
      "dima app-server exited with code 7. The daemon log is at /tmp/dim/daemon.log.",
    );
  });

  it("points at the manual command when only the timeout expired", () => {
    assert.strictEqual(
      dimDaemonStartFailure({
        exitStatus: null,
        endpoint: "/tmp/dim/daemon.sock",
        binaryPath: "dima",
        logPath: "/tmp/dim/daemon.log",
      }),
      "Dim daemon did not start at /tmp/dim/daemon.sock. Run `dima app-server` in a terminal to see why.",
    );
  });
});
