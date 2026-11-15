import ExpoModulesCore
import UIKit

public final class T3AppIconModule: Module {
  public func definition() -> ModuleDefinition {
    Name("T3AppIcon")

    AsyncFunction("current") { () -> String? in
      let app = UIApplication.shared
      return app.supportsAlternateIcons ? (app.alternateIconName ?? "Default") : nil
    }.runOnQueue(.main)

    AsyncFunction("select") { (name: String, promise: Promise) in
      UIApplication.shared.setAlternateIconName(name == "Default" ? nil : name) { error in
        if let error {
          promise.reject(error)
        } else {
          promise.resolve()
        }
      }
    }.runOnQueue(.main)
  }
}
