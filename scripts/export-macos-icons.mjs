#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const root = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const check = process.argv.includes("--check");
const icons = [
  ["Default", "assets/pinacode/pinacode.icon"],
  ...["Amethyst", "Diamond", "Gold", "Pineapple"].map((name) => [
    name,
    `assets/pinacode/alternates/${name}.icon`,
  ]),
];

for (const [name, source] of icons) {
  const temporary = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pinacode-macos-icon-"));
  try {
    const appIcon = NodePath.basename(source, ".icon");
    NodeChildProcess.execFileSync("xcrun", [
      "actool",
      NodePath.join(root, source),
      "--compile",
      temporary,
      "--output-format",
      "human-readable-text",
      "--output-partial-info-plist",
      NodePath.join(temporary, "info.plist"),
      "--app-icon",
      appIcon,
      "--standalone-icon-behavior",
      "all",
      "--target-device",
      "mac",
      "--minimum-deployment-target",
      "26.0",
      "--platform",
      "macosx",
    ]);
    const iconset = NodePath.join(temporary, "export.iconset");
    NodeChildProcess.execFileSync("iconutil", [
      "-c",
      "iconset",
      NodePath.join(temporary, appIcon + ".icns"),
      "-o",
      iconset,
    ]);
    // The native ICNS includes macOS's safe area and shadow; a plain ictool preview is full bleed.
    const rendered = NodePath.join(iconset, "icon_512x512@2x.png");
    const target = NodePath.join(root, "assets/pinacode/alternates/dock", name + ".png");
    if (check) {
      if (!NodeFS.readFileSync(rendered).equals(NodeFS.readFileSync(target))) {
        throw new Error(`Outdated macOS icon: ${name}. Run vp run icons:export:macos.`);
      }
    } else {
      NodeFS.copyFileSync(rendered, target);
    }
    console.log(`${check ? "Checked" : "Exported"} ${name}`);
  } finally {
    NodeFS.rmSync(temporary, { recursive: true, force: true });
  }
}
