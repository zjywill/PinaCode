# macOS 构建与发布

使用仓库自己的 scripts/build-desktop-artifact.ts。先读当前脚本参数和发布工作流，确认版本、构建架构及签名方式；下面是已经在本机验证过的流程。

## 构建

1. 查询 GitHub 最新 Release，决定新版本和源提交。版本对齐用 scripts/update-release-package-versions.ts；只提交发布所需文件。此脚本会对齐 desktop、server、web、contracts 的版本，不要手工遗漏其中一项。
2. 核对 security find-identity -v -p codesigning 中的 Developer ID Application 身份。签名与公证需要实际可用的身份和 Apple API 凭据。
3. 在发布 worktree 中设置以下进程环境。变量值从现有配置读取，不打印私钥：

       T3CODE_DESKTOP_UPDATE_REPOSITORY=zjywill/PinaCode
       CSC_NAME=Junyi Zhang (NGM7GX8DGB)
       APPLE_API_KEY=<AuthKey 文件绝对路径>
       APPLE_API_KEY_ID=<key-id>
       APPLE_API_ISSUER=<issuer-id>

   CSC_NAME 不带 Developer ID Application: 前缀，electron-builder 会据目标选择证书类型。不要把上游更新源或脚本的 fallback 带进正式包。

4. 选用仓库要求的 Node 和本检出的 vp，运行：

       node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 --build-version <version> --signed --output-dir <private-temp-dir>/mac

   dmg 目标也生成更新所需 ZIP。第一次构建不跳过 bundle 构建；只有确认现有 dist 来自同一源与版本时才使用 --skip-build。需要检查打包后的 .app 时可用 --keep-stage，并在完成后清理保留的 stage。

## 验证产物

- codesign --verify --deep --strict 检查 .app；xcrun stapler validate 检查票据；spctl --assess --type execute --verbose=2 应显示 Notarized Developer ID。
- 核对 Info.plist 的版本、bundle ID 及 Resources/app-update.yml 的 owner/repo。
- 必须有 DMG、ZIP、各自的 blockmap、latest-mac.yml，以及 SHA256SUMS。核对 manifest 中的版本、大小及 SHA-512，生成安装包的 SHA-256。
- 构建器会验证打包依赖自包含性。还应按仓库流程进行启动检查，使用独立 PINACODE_HOME 和测试数据。
- 注意 macOS Electron profile 默认仍在真实 ~/Library/Application Support/pinacode；PINACODE_HOME 只隔离后端数据。没有确认 profile 隔离能力时，不直接运行可能占用真实安装 profile 的 GUI smoke。可以先用打包后的 Electron 配合 ELECTRON_RUN_AS_NODE=1 启动其 server bin.mjs，验证旧数据库迁移、HTTP 页面和静态资源。清楚报告实际验证范围。

## GitHub 发布与清理

1. 将必要提交推送到正确 origin，确认目标 SHA。创建新 tag 对应的 draft Release，附件采用明确白名单，不上传 builder-debug.yml、临时配置或凭据。
2. 用 GitHub 返回的附件大小及 SHA-256 digest 对照本地产物，确认所有上传完成，再将草稿发布并标记 latest。沿用仓库既有 tag 格式；当前使用 0.1.x，无 v 前缀。
3. 检查 releases/latest/download/latest-mac.yml 公开可访问且版本正确。
4. 执行主技能中的旧 Release 清理流程，只保留本次发布。存在较新的草稿或 Release 时停止，先核对并行发布状态。不要使用 --cleanup-tag。

若某一步已成功，重入时先读取其结果，继续缺失步骤，不重新创建 Release 或重复上传。
