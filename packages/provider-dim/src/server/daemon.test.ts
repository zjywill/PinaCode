import { assert, describe, it } from "@effect/vitest";

import { dimDaemonEndpoint } from "./daemon.ts";

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
