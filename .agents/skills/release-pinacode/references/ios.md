# iOS：一份构建用于 TestFlight 和 App Store

## 版本与原生工程

- 查询 ASC 已批准、待审版本与构建号，确定本次 marketing version 和 build number。更新 apps/mobile/app.config.ts；需要保持两个 EAS profile 一致时，同时更新 eas.json 中 testflight 的版本覆盖值。
- 保持 APP_VARIANT=production、app.pinacode.client 和正确 Apple Team。一次 App Store 导出可同时用于内测、外测和正式版。
- 发布 worktree 必须独立安装依赖，不能链接原 worktree 的 node_modules。Metro 的 watchFolders 默认只包含发布工作区，链接到外部会报 Unable to resolve module expo。
- 从 apps/mobile 使用本检出的 Expo CLI 预构建 iOS，再在 ios 目录 pod install。显式指定 Node 路径；避免临时目录中的 shell 改用系统 Ruby 或错误 Node。

## 签名与归档

- 先核对钥匙串及 Developer Portal 已有证书。缺少所需分发身份时，可以为发布创建证书并导入私钥；不要撤销其他证书。CSR、私钥和临时 API key JSON 放在权限受限的目录，成功后删除副本。
- macOS 自带 /usr/bin/openssl 导出的 PKCS#12 已验证可被 security import 读取。若其他 OpenSSL 导出出现 MAC verification failed，改用兼容导出参数或系统工具，不重建或撤销已经签发的证书。
- 本机可通过 xcodebuild archive 与 exportArchive 发布。仓库关于 EAS fingerprint 的限制仍需核对；不要把 macOS 算出的 fingerprint 交给另一 OS 的 EAS 构建并假定相同。这里沿用本机原生 Xcode 归档，不发布 OTA。

归档参数使用当前生成的 workspace、scheme 和实际版本。例如：

    xcodebuild -workspace PinaCode.xcworkspace -scheme PinaCode \
      -configuration Release -sdk iphoneos -destination 'generic/platform=iOS' \
      -archivePath <archive-path> -derivedDataPath <derived-data-path> \
      -allowProvisioningUpdates -authenticationKeyPath <p8-path> \
      -authenticationKeyID <key-id> -authenticationKeyIssuerID <issuer-id> \
      archive DEVELOPMENT_TEAM=NGM7GX8DGB CODE_SIGN_STYLE=Automatic \
      CURRENT_PROJECT_VERSION=<build-number> MARKETING_VERSION=<version>

选择适合本机资源的并行度。出现可修复的构建环境错误时保留 DerivedData，修正后增量归档；不要因构建慢而跳过尚未完成的步骤。

ExportOptions.plist 使用 method=app-store-connect、teamID=NGM7GX8DGB、signingStyle=automatic、destination=export、manageAppVersionAndBuildNumber=false。导出后读取 IPA 内主应用 Info.plist，核对 bundle ID、marketing version、build number 和现有加密声明。

## 上传与分发

Fastlane 已在本机验证可用。临时 API key JSON 包含 key_id、issuer_id、key 和 in_house=false；文件权限 0600，不能进入仓库或发布附件。

只上传一次：

    fastlane pilot upload --api_key_path <json-path> \
      --app_identifier app.pinacode.client --ipa <ipa-path> \
      --skip_waiting_for_build_processing true --skip_submission true

等待 ASC 查询返回本次版本和构建号，且 processingState=VALID。上传成功不代表处理已完成；未确认结果前不要重传同一构建或盲目增加构建号。

读取实际 betaGroups，沿用已有组。当前是 PinaCode Internal 和 PinaCode Public Beta，不把这些名字当其他应用的默认值。

- 内部组若没有自动接收所有构建，通过 POST /v1/betaGroups/<group-id>/relationships/builds 添加本次 build ID。
- 外测可运行：

      fastlane pilot distribute --api_key_path <json-path> \
        --app_identifier app.pinacode.client --app_platform ios \
        --app_version <version> --build_number <build-number> \
        --distribute_external true --groups 'PinaCode Public Beta' \
        --notify_external_testers false --changelog '<本次说明>'

  显式给 app_platform，避免非交互平台选择提示。不要额外给测试者发送通知，除非用户要求。

- 核对中英文 betaBuildLocalizations；总 changelog 可能覆盖不同语言，必要时单独更新中文。
- 查询 buildBetaDetail 和各 betaGroups/<id>/builds 确认实际状态。build 的 betaGroups 关系不支持 GET_RELATED，应从组查询构建。

## 正式版审核

创建或复用本次 appStoreVersion，设置 releaseType=AFTER_APPROVAL（用户另有发布时机要求时遵从）。核对从上一版继承的截图、版权、审核联系人和演示要求，补充对应语言的 whatsNew；不要编造审核资料或修改已有隐私、加密声明来绕过验证。

Fastlane deliver 的非交互调用需要配置文件。在私有临时目录创建 fastlane/Deliverfile，写入 app_identifier 'app.pinacode.client'，从该目录执行：

    fastlane deliver --api_key_path <json-path> \
      --app_identifier app.pinacode.client --platform ios \
      --app_version <version> --build_number <build-number> \
      --skip_binary_upload true --skip_metadata true --skip_screenshots true \
      --submit_for_review true --automatic_release true \
      --precheck_include_in_app_purchases false --force true

上述 IAP 预检查设置适用于当前无应用内购买的 PinaCode；如果产品改变，按实际能力调整。不要同时给 deliver 传 ipa 和 build_number；它们互斥。临时目录的 Ruby 可能回退到系统 2.6，显式使用已安装的兼容 Ruby 与 Fastlane。

最后通过 ASC 确认正式版绑定的是本次 build ID、releaseType 正确，以及实际审核状态。WAITING_FOR_REVIEW 与 WAITING_FOR_BETA_REVIEW 要分别报告；不能把 Fastlane 的“distributed”日志当作外测已获批。
