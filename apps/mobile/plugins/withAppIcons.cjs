const fs = require("node:fs");
const path = require("node:path");
const {
  AndroidConfig,
  IOSConfig,
  withAndroidManifest,
  withXcodeProject,
  withDangerousMod,
} = require("expo/config-plugins");

const names = ["Gold", "Amethyst", "Diamond", "Pineapple"];
const assets = path.resolve(__dirname, "../../../assets/pinacode/alternates");
const launcher = "android.intent.category.LAUNCHER";
const main = "android.intent.action.MAIN";

function configureLauncher(manifest) {
  const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  const activity = AndroidConfig.Manifest.getMainActivityOrThrow(manifest);
  activity["intent-filter"] = activity["intent-filter"].filter(
    (filter) => !filter.category?.some((entry) => entry.$["android:name"] === launcher),
  );
  const aliases = ["Default", ...names].map((name) => ({
    $: {
      "android:name": ".Launcher" + name,
      "android:targetActivity": activity.$["android:name"],
      "android:enabled": String(name === "Default"),
      "android:exported": "true",
      "android:icon":
        name === "Default" ? "@mipmap/ic_launcher" : "@mipmap/pina_" + name.toLowerCase(),
    },
    "intent-filter": [
      {
        action: [{ $: { "android:name": main } }],
        category: [{ $: { "android:name": launcher } }],
      },
    ],
  }));
  app["activity-alias"] = [
    ...(app["activity-alias"] ?? []).filter(
      (old) => !aliases.some((alias) => alias.$["android:name"] === old.$["android:name"]),
    ),
    ...aliases,
  ];
}

module.exports = function withAppIcons(config) {
  config = withAndroidManifest(config, (cfg) => {
    configureLauncher(cfg.modResults);
    return cfg;
  });
  config = withDangerousMod(config, [
    "android",
    (cfg) => {
      const res = path.join(cfg.modRequest.platformProjectRoot, "app/src/main/res");
      for (const dir of ["drawable-nodpi", "mipmap-anydpi-v26", "mipmap-xhdpi"]) {
        fs.mkdirSync(path.join(res, dir), { recursive: true });
      }
      for (const name of names) {
        const id = "pina_" + name.toLowerCase();
        fs.copyFileSync(
          path.join(assets, "android", name + ".png"),
          path.join(res, "drawable-nodpi", id + ".png"),
        );
        fs.copyFileSync(
          path.join(assets, "preview", name + ".png"),
          path.join(res, "mipmap-xhdpi", id + ".png"),
        );
        fs.writeFileSync(
          path.join(res, "mipmap-anydpi-v26", id + ".xml"),
          `<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android"><background android:drawable="@android:color/black"/><foreground><inset android:drawable="@drawable/${id}" android:inset="18%"/></foreground></adaptive-icon>\n`,
        );
      }
      return cfg;
    },
  ]);
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const projectName = cfg.modRequest.projectName;
    const utils = IOSConfig.XcodeUtils;
    const { uuid, target } = utils.getApplicationNativeTarget({ project, projectName });
    for (const name of names) {
      const file = name + ".icon";
      fs.cpSync(
        path.join(assets, file),
        path.join(cfg.modRequest.platformProjectRoot, projectName, file),
        { recursive: true },
      );
      utils.addResourceFileToGroup({
        filepath: projectName + "/" + file,
        groupName: projectName,
        project,
        targetUuid: uuid,
        isBuildFile: true,
      });
    }
    for (const [, configuration] of utils.getBuildConfigurationsForListId(
      project,
      target.buildConfigurationList,
    )) {
      configuration.buildSettings.ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES =
        '"' + names.join(" ") + '"';
    }
    return cfg;
  });
};
