#!/usr/bin/env node
import * as NodeURL from "node:url";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import sharp from "sharp";

import { DEVELOPMENT_PUBLIC_ICON_OVERRIDES } from "./lib/brand-assets.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

class IconExportError extends Schema.TaggedError<IconExportError>()("IconExportError", {
  operation: Schema.Literals(["render", "check"]),
  path: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.operation === "check"
      ? `Outdated icon: ${this.path}`
      : `Failed to render icon: ${this.path}`;
  }
}

const root = new URL("../", import.meta.url);
const master = new URL("assets/pinacode/icon.png", root);
const check = process.argv.includes("--check");
Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const emit = Effect.fn("icons.emit")(function* (path: string, data: Uint8Array) {
    const target = NodeURL.fileURLToPath(new URL(path, root));
    if (!check) return yield* fs.writeFile(target, data);
    const current = yield* fs.readFile(target);
    if (!Buffer.from(current).equals(data))
      return yield* new IconExportError({ operation: "check", path });
  });

  const webSizes = [16, 32, 180, 192, 512];
  const renditions = yield* Effect.forEach(
    [...new Set([...WINDOWS_ICON_SIZES, ...webSizes])],
    (size) =>
      Effect.gen(function* () {
        const contents = yield* Effect.tryPromise({
          try: () => sharp(NodeURL.fileURLToPath(master)).resize(size, size).png().toBuffer(),
          catch: (cause) =>
            new IconExportError({ operation: "render", path: master.pathname, cause }),
        });
        if (webSizes.includes(size)) yield* emit("assets/pinacode/icon-" + size + ".png", contents);
        return { size, contents };
      }),
    { concurrency: "unbounded" },
  );
  yield* emit(
    "assets/pinacode/icon.ico",
    encodePngIco(renditions.filter(({ size }) => size <= 256 && size !== 180 && size !== 192)),
  );
  for (const { sourceRelativePath, targetRelativePath } of DEVELOPMENT_PUBLIC_ICON_OVERRIDES) {
    yield* emit(
      targetRelativePath,
      yield* fs.readFile(NodeURL.fileURLToPath(new URL(sourceRelativePath, root))),
    );
  }
}).pipe(Effect.provide(NodeFileSystem.layer), NodeRuntime.runMain);
