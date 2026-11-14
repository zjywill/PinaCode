#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

import { DEVELOPMENT_PUBLIC_ICON_OVERRIDES } from "./lib/brand-assets.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const root = new URL("../", import.meta.url);
const master = new URL("assets/pinacode/icon.png", root);
const check = process.argv.includes("--check");
async function emit(path: string, data: Buffer) {
  const target = new URL(path, root);
  if (!check) return writeFile(target, data);
  if (!(await readFile(target)).equals(data)) throw new Error("Outdated icon: " + path);
}

const webSizes = [16, 32, 180, 192, 512];
const renditions = await Promise.all(
  [...new Set([...WINDOWS_ICON_SIZES, ...webSizes])].map(async (size) => {
    const contents = await sharp(master.pathname).resize(size, size).png().toBuffer();
    if (webSizes.includes(size)) await emit("assets/pinacode/icon-" + size + ".png", contents);
    return { size, contents };
  }),
);
await emit(
  "assets/pinacode/icon.ico",
  encodePngIco(renditions.filter(({ size }) => size <= 256 && size !== 180 && size !== 192)),
);
for (const { sourceRelativePath, targetRelativePath } of DEVELOPMENT_PUBLIC_ICON_OVERRIDES) {
  await emit(targetRelativePath, await readFile(new URL(sourceRelativePath, root)));
}
