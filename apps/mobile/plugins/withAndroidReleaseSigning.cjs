const { withAppBuildGradle } = require("expo/config-plugins");

const signingScript = 'apply from: rootProject.file("../scripts/android-release-signing.gradle")';

module.exports = function withAndroidReleaseSigning(config) {
  return withAppBuildGradle(config, (config) => {
    if (!config.modResults.contents.includes(signingScript)) {
      config.modResults.contents += `\n${signingScript}\n`;
    }
    return config;
  });
};
