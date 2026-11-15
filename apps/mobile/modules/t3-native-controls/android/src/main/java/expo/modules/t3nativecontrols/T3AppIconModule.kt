package expo.modules.t3nativecontrols

import android.content.ComponentName
import android.content.pm.PackageManager
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T3AppIconModule : Module() {
  private val names = listOf("Default", "Gold", "Amethyst", "Diamond", "Pineapple")
  private val context get() = requireNotNull(appContext.reactContext)
  private fun component(name: String) = ComponentName(context, context.packageName + ".Launcher" + name)

  override fun definition() = ModuleDefinition {
    Name("T3AppIcon")

    AsyncFunction("current") {
      names.first { name ->
        when (context.packageManager.getComponentEnabledSetting(component(name))) {
          PackageManager.COMPONENT_ENABLED_STATE_DEFAULT -> name == "Default"
          PackageManager.COMPONENT_ENABLED_STATE_ENABLED -> true
          else -> false
        }
      }
    }

    AsyncFunction("select") { selected: String ->
      require(selected in names)
      val manager = context.packageManager
      val changes = (listOf(selected) + (names - selected)).map { name ->
        val state = if (name == selected) PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                    else PackageManager.COMPONENT_ENABLED_STATE_DISABLED
        component(name) to state
      }.filter { (alias, state) -> manager.getComponentEnabledSetting(alias) != state }
      if (Build.VERSION.SDK_INT >= 33) {
        if (changes.isNotEmpty()) manager.setComponentEnabledSettings(changes.map { (alias, state) ->
          PackageManager.ComponentEnabledSetting(alias, state, PackageManager.DONT_KILL_APP)
        })
      } else {
        // Enable the new launcher before disabling the previous one on pre-33 devices.
        changes.forEach { (alias, state) ->
          manager.setComponentEnabledSetting(alias, state, PackageManager.DONT_KILL_APP)
        }
      }
    }
  }
}
