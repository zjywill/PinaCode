import { AppIconNameSchema, type AppIconName } from "@t3tools/contracts";
import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DesktopAppIdentity from "../app/DesktopAppIdentity.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

class DockIconError extends Schema.TaggedError<DockIconError>()("DockIconError", {
  message: Schema.String,
}) {}

const preference = "PinaCodeDockIcon";

const isAppIconName = Schema.is(AppIconNameSchema);

export const current = Effect.sync((): AppIconName => {
  const value = Electron.systemPreferences.getUserDefault(preference, "string");
  return isAppIconName(value) ? value : "Default";
});

export const apply = Effect.fn("desktop.macDockIcon.apply")(function* (name: AppIconName) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (environment.platform !== "darwin" || !Electron.app.dock) {
    return yield* new DockIconError({ message: "Dock icons require macOS." });
  }
  const directory = environment.isPackaged
    ? environment.path.join(environment.resourcesPath, "dock-icons")
    : environment.path.join(environment.rootDir, "assets/pinacode/alternates/dock");
  const image = Electron.nativeImage.createFromPath(
    environment.path.join(directory, name + ".png"),
  );
  if (image.isEmpty())
    return yield* new DockIconError({ message: "Could not load the Dock icon." });
  Electron.app.dock.setIcon(image);
});

export const select = Effect.fn("desktop.macDockIcon.select")(function* (name: AppIconName) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (name === "Default" && !environment.isPackaged) {
    yield* (yield* DesktopAppIdentity.DesktopAppIdentity).configure;
  } else {
    yield* apply(name);
  }
  Electron.systemPreferences.setUserDefault(preference, "string", name);
});
