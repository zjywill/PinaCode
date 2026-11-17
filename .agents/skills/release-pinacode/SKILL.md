---
name: release-pinacode
description: 发布 PinaCode 的 macOS 安装包、iOS TestFlight 和 App Store 正式版，并在 macOS 成功发布后清理旧 GitHub Release。适用于 PinaCode 发版或明确请求清理发布记录。
---

# 发布 PinaCode

按请求发布 macOS、iOS 或两者。只创建或修改本技能时不执行发布或删除。

## 发布源与授权

- 在当前检出核对 origin、HEAD、工作区和现有版本。目标仓库是 zjywill/PinaCode，不能误用上游 pingdotgg/t3code。
- 默认发布已提交的版本，向用户说明发布源。保留未提交内容与暂存状态；不要把其他任务的工作顺手提交。用户明确要求纳入时，先完成相应验证。
- 使用相邻的隔离发布 worktree。安装它自己的依赖，不要把原检出的 node_modules 链接进去：Metro 会拒绝工作区之外的依赖。遵守仓库的 setup 标记和 AGENTS.md。
- 用户的发布请求授权完成对应构建、签名、必要的版本提交和推送、上传及审核提交。没有相应请求时不执行这些外部动作。缺少必需凭据时先完成独立工作，再具体说明缺什么。
- 本仓库上游工作流可能带有仅允许 pingdotgg/t3code 的条件，或依赖上游专用 runner。先读实际工作流；不能把“任务被跳过”算发布成功。当前分叉可使用下面记录的本机构建流程。

## 选择版本和凭据

- macOS 读取 GitHub 最新 Release，通常递增补丁版本；沿用现有发布架构，除非用户另有要求。
- iOS 通过 App Store Connect 查询已批准版本、待审版本和最新构建号。已批准的版本不能再上传；新版本和构建号必须可用。复用已有待发布版本时不要重复创建。
- 一份有效的 iOS App Store 构建可以同时用于 TestFlight 和正式版审核，无需为两个渠道重复构建。
- 已知生产标识：bundle ID 为 app.pinacode.client，Apple Team ID 为 NGM7GX8DGB，ASC App ID 为 6834654178。用 API 核对应用和团队后再使用。
- 凭据只从已配置的环境、钥匙串或维护者提供的本机配置读取，不写进仓库或技能。兼容配置名 APP_STORE_CONNECT_API_KEY（key ID）和 APP_STORE_CONNECT_ISSUER_ID；私钥默认位于 ~/.appstoreconnect/private_keys/AuthKey_<key-id>.p8，也可用 ASC_KEY_PATH 显式指定。不要输出配置或私钥内容。
- 本机已配置的 Apple 发布资料位于 `~/Documents/apple sign/`：先读取其中 `README.md` 和 `KITE-IOS-TESTFLIGHT.md` 核对 key ID、issuer ID 与团队，私钥位于 `api-key/AuthKey_<key-id>.p8`。此路径优先于上述默认路径；设置 `ASC_KEY_PATH` 后核验目标应用，不必复制私钥，也不要在未检查此目录前向维护者重复索取凭据。
- scripts/asc.mjs 提供无需第三方依赖的 ASC API 调用。支持 ASC_KEY_ID、ASC_ISSUER_ID、ASC_KEY_PATH；也可通过 --env-file 显式传入维护者指定的配置文件。涉及联系人等资料时把响应存入私有临时目录，只输出必要状态。

## 执行对应平台

- 发布 macOS 时读取 [macOS 流程](references/macos.md)。
- 发布 iOS 时读取 [iOS 流程](references/ios.md)。
- 独立平台工作可并行运行；版本提交、状态变更和依赖它们的动作按顺序执行。持续跟进本次构建和上传，不用定时自动化代替。
- 遵守仓库要求的验证。检查失败要区分基线问题和本次回归，不把未通过说成通过。不要为让发布变绿而隐藏或删除检查。

## macOS 发布后只保留最新 Release

这是维护者明确要求的发布保留策略：macOS 新版本成功发布并验证可下载后，该仓库 GitHub 上只保留这一条 Release。删除其他 Release 及附件，保留 Git tags 和 commits。仅 iOS 发布不触发此清理。

发布成功的条件包括签名与公证验证、完整更新文件及哈希、GitHub 正式发布状态，以及公开 latest-mac.yml 指向新版本。构建失败、草稿、附件不完整或更新文件验证失败时不清理。

使用脚本先查看清单，再执行；请求发布 macOS 时此保留策略已有授权，不需要重复确认。明确请求只清理旧 Release 时，先验证保留的最新版，再执行同样步骤。

    python3 scripts/prune_github_releases.py --repo zjywill/PinaCode --keep <new-tag>
    python3 scripts/prune_github_releases.py --repo zjywill/PinaCode --keep <new-tag> --apply --snapshot <private-temp-dir>/releases-before-prune.json

路径相对于本技能目录。脚本默认只读；执行模式按快照中的 Release ID 删除，不删除标签。存在较新的草稿或 Release 时停止，避免影响并行发布。若 latest 改变、保留版本无效或任一删除失败，立即停止并重新核对，不进行盲目重试。最后确认只剩保留的 Release。

## 收尾与报告

- 验证远端 tag/提交、Release 附件、iOS 版本与构建绑定、测试组及审核状态。
- App Store 的 WAITING_FOR_REVIEW 和外测的 WAITING_FOR_BETA_REVIEW 都是待审核，不能称为已经公开上线。正式版按请求设为审核通过后自动发布。
- 保存生产 xcarchive 到本机标准 Xcode Archives 目录，保留必要日志和导出产物。清理本任务临时 worktree、构建进程及私钥副本；不撤销正常发布证书，不动用户正在运行的安装。
- 报告各渠道版本、链接、实际状态、旧 Release 清理数量和未提交工作的去向。等待 Apple 审核不等于发布失败，也不保证审核时间。
