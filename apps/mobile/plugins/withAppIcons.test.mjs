import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { AndroidConfig, compileModsAsync } from "expo/config-plugins";
import { expect, it } from "vite-plus/test";
import withAppIcons from "./withAppIcons.cjs";

it("keeps deep links and sharing on MainActivity and creates one enabled launcher after repeated prebuilds", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pina-launchers-"));
  try {
    const dir = NodePath.join(root, "android/app/src/main");
    const file = NodePath.join(dir, "AndroidManifest.xml");
    await NodeFSP.mkdir(dir, { recursive: true });
    const actions = ["MAIN", "VIEW", "SEND"].map(
      (action) =>
        `<intent-filter><action android:name="android.intent.action.${action}"/><category android:name="android.intent.category.${action === "MAIN" ? "LAUNCHER" : "DEFAULT"}"/></intent-filter>`,
    );
    await NodeFSP.writeFile(
      file,
      `<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:name=".MainApplication"><activity android:name=".MainActivity">${actions.join("")}</activity></application></manifest>`,
    );
    for (let pass = 0; pass < 2; pass++) {
      await compileModsAsync(withAppIcons({ name: "Pina Code", slug: "pinacode" }), {
        projectRoot: root,
        platforms: ["android"],
      });
    }
    const manifest = await AndroidConfig.Manifest.readAndroidManifestAsync(file);
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(manifest);
    expect(activity["intent-filter"].map((filter) => filter.action[0].$["android:name"])).toEqual([
      "android.intent.action.VIEW",
      "android.intent.action.SEND",
    ]);
    const aliases = app["activity-alias"].map((alias) => alias.$);
    expect(aliases.map((alias) => alias["android:name"])).toEqual([
      ".LauncherDefault",
      ".LauncherGold",
      ".LauncherAmethyst",
      ".LauncherDiamond",
      ".LauncherPineapple",
    ]);
    expect(aliases.filter((alias) => alias["android:enabled"] === "true")).toEqual([aliases[0]]);
    for (const alias of aliases.slice(1)) {
      expect(alias["android:targetActivity"]).toBe(".MainActivity");
      const resource = alias["android:icon"].slice("@mipmap/".length);
      expect(
        await NodeFSP.readFile(
          NodePath.join(dir, "res/mipmap-anydpi-v26", resource + ".xml"),
          "utf8",
        ),
      ).toContain("@drawable/" + resource);
    }
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
