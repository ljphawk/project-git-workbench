# Project Git Workbench

一个给多仓库工作区用的 VS Code Git 工作台。打开文件就能定位它所属的仓库，从 **Local Changes** 逐个查看差异、选择要提交的文件，也能在同一界面查历史、切分支和暂存任务。

尤其适合 AI 辅助开发后的人工验收。AI 改完一轮，你可以先看它碰了哪些文件，再沿着差异逐处检查，最后只提交确认过的改动。Android、鸿蒙、Python 和 Web 项目可以放在同一个工作区里，各自保留独立的 Git 历史和远程地址。

## 快速上手

**需要桌面版 VS Code 1.95+ 和 Git 2.37+。** 从源码打包还需要 Node.js 22+ 和 npm。

1. 克隆本仓库，在仓库目录运行以下命令，生成 `project-git-workbench-0.4.7.vsix`。

   ```sh
   npm ci
   npm run package
   ```

2. 在 VS Code 命令面板运行 **Extensions: Install from VSIX...**，选择生成的文件。
3. 用 VS Code 打开存放多个项目的总目录。在资源管理器右键一个项目目录或文件，选择 **在 Project Git 中打开**。也可以点左侧 **Project Git** 图标，从顶部选择仓库。
4. 打开 **Local Changes**，点击文件名查看 VS Code 原生 Diff。项目路径和当前分支显示在工作台顶部，提交前可以核对一次。

点击工作台顶部的 **↗** 可在编辑区展开，适合同时查看文件列表和提交表单。默认打开其他仓库的文件时，工作台会跟随切换。想固定在某个项目时，可以关闭 `projectGit.autoFollowEditor`。

## 在大项目里验收 AI 改动

下面是一个匿名示例。各业务目录可以继续分层，标注 Git 仓库的位置才是操作边界。

```text
workspace/
├── mobile/
│   ├── android-app/       # Git 仓库
│   │   ├── app/
│   │   └── modules/
│   └── harmony-app/       # Git 仓库
│       ├── entry/
│       └── features/
├── web/
│   └── portal/            # Git 仓库
│       ├── src/
│       └── tests/
└── services/
    └── api/               # Git 仓库
        ├── src/
        └── tests/
```

比如 AI 为同一需求修改了 Android 页面、Web 前端和 API 测试。你可以从任意改动文件进入对应仓库，按仓库验收和提交。打开 Android 文件时，列表展示整个 Android 仓库的改动。切到 API 文件时，列表跟随到 API 仓库，提交也在对应仓库内完成。

1. **先留出审阅基线。** 从干净的分支或 Worktree 开始，或者先把已有改动用 **Shelve Changes** 收起来。Git 展示的是相对基线的改动，已有人工改动和 AI 改动混在一起时，工作台会一起显示。
2. **从文件列表检查影响范围。** 在 **Local Changes** 按名称或路径筛选。比如先看 `modules/` 下的业务逻辑，再检查测试、配置和意外新增的文件。
3. **连续看差异。** 点开一份文件，左侧仍保留当前仓库的改动清单。用右下角 **↑ 上一处 / ↓ 下一处** 查看差异块，到文件边界后可继续看相邻文件。按 **Esc** 可从代码区域关闭插件打开的比对。
4. **提交验收通过的文件。** 新文件可以右键 **Add** 加入暂存区。提交前只勾选要纳入本次提交的文件，再填提交信息。跨仓库改动要分别进入各自仓库验收并提交。

如果 AI 已经把改动提交了，打开 **Log** 查看某条提交的文件差异，也可以选中基线与结果两条提交，点击 **比较所选提交**，一次查看这轮改动涉及哪些文件。

## 日常操作

| 功能 | 怎么用 |
| --- | --- |
| Local Changes | 查看未暂存、已暂存、未跟踪和冲突文件。支持筛选、原生 Diff、暂存、取消暂存和丢弃。 |
| Commit | 提交勾选文件的全部本地改动，保留未勾选文件的暂存内容。勾选 **Amend commit** 可修改最后一次提交。 |
| Log | 看提交图，用分支、作者、日期、路径、文字或哈希筛选。选中提交可查看完整消息与文件。拖动分隔线调整详情区高度。 |
| Branches | 左侧树展示本地分支、远程分支和标签。单击分支筛选日志，右键执行 Checkout、Merge、Rebase 或创建分支等操作。 |
| Remote | 顶部支持 Fetch、Pull、Push 和查看 Git 地址。分支菜单支持后台快进更新有上游的非当前分支，标签菜单支持推送指定标签。 |
| Shelf | 勾选文件后命名搁置，之后预览补丁、恢复或删除。恢复后保留备份。 |

**暂存和提交的范围。** 右键 **Add** 暂存当前文件，底部 **暂存** 对勾选的文件生效。**Commit** 会提交勾选文件的全部本地改动，包括该文件尚未暂存的内容。需要按行或按差异块提交时，可用 VS Code 内置源代码管理。

**暂时切换任务。** 在 Local Changes 勾选需要收起的文件，点击 **Shelve Changes…** 并命名。回到任务后，在 **Shelf** 页选 **Unshelve 恢复**。Shelf 是该扩展在仓库 Git 本地目录中保存的补丁，暂存和未暂存版本分别记录。它独立于 Git Stash 与 Android Studio Shelf，普通 Push 不会传送这些补丁。恢复冲突时会保留备份。

**历史与分支操作。** 顶部 Pull 和后台分支 Pull 只允许快进。Rebase、Reset、Cherry-pick 等操作应先检查当前分支并处理未提交改动。丢弃未跟踪文件前会要求确认，这类文件删除后无法通过 Git 找回。

## 设置

| 设置 | 默认值 | 用途 |
| --- | --- | --- |
| `projectGit.autoFollowEditor` | `true` | 打开文件时跟随其 Git 仓库 |
| `projectGit.scanDepth` | `6` | 自动发现仓库的目录深度，可设为 1–12 |
| `projectGit.logLimit` | `150` | 提交历史每页条数，可设为 20–1000 |
| `projectGit.afterDiffSidebar` | `explorer` | 离开比对页时返回的侧边栏模块 |

目录较深时，直接右键目标项目或文件即可定位仓库。Git 操作使用扩展宿主上的 Git 和已有的 SSH 或 Credential Helper。扩展需要受信任的工作区。远程工作区需要在远程宿主上安装扩展并配置 Git。

## 开发与贡献

克隆后运行 `npm ci`。在 VS Code 中打开本仓库，按 **F5** 启动 Extension Development Host，打开一个包含 Git 仓库的测试工作区。

```sh
npm test
npm run package
```

安装 Python Playwright 和 Chromium 后，可运行 `python3 test/ui_test.py` 和 `python3 test/history_ui_test.py` 检查工作台界面。仓库相关测试使用临时目录和本地 Git 仓库。

- `src/` 包含扩展入口、Git 操作、差异导航和 Shelf。
- `media/` 包含工作台界面。
- `test/` 包含 Git 行为、界面和扩展宿主测试。

欢迎提交 Issue 或 Pull Request。反馈问题时，可附上扩展版本、操作系统、复现步骤和匿名目录结构。分享日志或截图前，请移除账号、内部地址和项目内容。

[MIT License](LICENSE)
