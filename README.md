<p align="center">
  <img src="./assets/pinacode/icon-192.png" width="80" height="80" alt="PinaCode 图标" />
</p>

# PinaCode

PinaCode 是 [T3 Code](https://github.com/pingdotgg/t3code) 的独立分支。你可以在同一个界面里使用 Codex、Claude Code 等已登录的编程助手，在电脑上开始工作，再从手机接着操作。

PinaCode 可以和 T3 Code 同时安装：命令是 `pinacode`，默认服务端口是 `4773`，数据保存在 `~/.pinacode`（可通过 `PINACODE_HOME` 修改）。使用本地环境或直接配对的环境无需 T3 账号；编程助手仍需各自登录。

## 从源码运行

先按[开发环境指南](./docs/operations/development.md#first-checkout)准备 Node.js 和 Vite+，然后运行：

```sh
git clone https://github.com/zjywill/PinaCode.git
cd PinaCode
vp i
vp run dev
```

打开终端输出的地址即可使用网页版。开发桌面版请运行 `vp run dev:desktop`。

## 同步 T3 Code 更新

`origin` 指向 PinaCode，`upstream` 指向原项目。新克隆的仓库只需添加一次上游：

```sh
git remote add upstream https://github.com/pingdotgg/t3code.git
```

之后在工作区干净时运行：

```sh
git switch main
git fetch upstream
git merge upstream/main
```

如果有冲突，先解决冲突并完成合并。检查 PinaCode 的改动仍然正常后，运行 `git push origin main` 发布同步结果。

## 文档与许可

[使用文档](./docs/README.md)涵盖[编程助手配置](./docs/user/install.md#providers)、[远程连接](./docs/user/remote-access.md)和[源码管理](./docs/user/source-control.md)。文档中的 T3 Code 官方下载链接提供的是上游版本。

PinaCode 保留原项目的 [MIT 许可证](./LICENSE)。感谢 T3 Code 维护者和贡献者。
