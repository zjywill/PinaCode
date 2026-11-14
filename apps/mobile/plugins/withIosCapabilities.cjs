const { withEntitlementsPlist } = require("expo/config-plugins");

module.exports = function withIosCapabilities(config, { personalTeam }) {
  return withEntitlementsPlist(config, (modConfig) => {
    delete modConfig.modResults["aps-environment"];
    if (personalTeam) {
      delete modConfig.modResults["com.apple.developer.applesignin"];
      delete modConfig.modResults["com.apple.security.application-groups"];
    }
    return modConfig;
  });
};
