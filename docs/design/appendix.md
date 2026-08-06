# 附录

以下三节是查的时候才看的清单，不是读的时候看的。主线里的决策都指向这里。

## 附录 A · 记忆读写契约

| 记忆 | 谁写 | 何时写 | 谁读 | 何时读 |
| --- | --- | --- | --- | --- |
| `mem/user.md` | `yan` | 只在 `user` 明确要求时；重写式 | `yan` | 启动 |
| `mem/repos.json` | `yan` | 只经 `yan repo-add` | `yan` | 启动 + 要动 repo 时 |
| `mem/learnings/*.md` | `yan` | 拿到证据后；重写式，带日期，会过期就删 | `yan` | 按需，只读涉及的那几片 |
| `tasks/<id>/task.json` | `yan` | 创建、加 `unit`、`unit set`、宣布完成 | `yan` | 启动 |
| `tasks/<id>/brief.md` | `yan` | 创建时一次；修订要显式 | `yan`、`shift` | `yan` 启动；`shift` 出生 |
| `tasks/<id>/log.md` | `yan` | 每个 `shift` 结束、每次决策，追加一行 | `yan`、`user` | 启动；`cat` |
| `tasks/<id>/report.md` | `shift` | 收尾前 | `yan`、未来的 `task` | 任务收尾；同类问题 intake |
| `tasks/<id>/artifacts/` | `shift` | 随时 | `user` | 任务收尾后 |
| `shifts/<sid>/brief.md` | `yan` | spawn 前一次 | `shift` | 出生第一件事 |
| `shifts/<sid>/outcome.md` | `shift`（`yan` 兜底） | 下工前 | `yan`、下一个 `shift` | 开新 `shift` 时 |
| `run/meta.json` | spawn 脚本 | spawn 时 | `yan` | 启动，重建状态 |
| `run/status` | `shift` | 稀疏：只写需要 `yan` 动作的事件 | `yan` | 被唤醒时 |

授权差别的理由见 [§4.1](memory.md#41-记忆的授权差别)。

## 附录 B · `yan` 的文件系统边界

### 可写

| 路径 | 写什么 | 约束 |
| --- | --- | --- |
| `tasks/<id>/task.json` | 决策：units、`scope`、交付历史、完成标记 | 原子写 |
| `tasks/<id>/log.md` | 叙事进度 | append-only，永不改写历史行 |
| `tasks/<id>/brief.md` | 任务契约 | 创建时一次；修订要显式并在 log 记一行 |
| `shifts/<sid>/brief.md` | 派工单 | spawn 前一次 |
| `shifts/<sid>/run/meta.json` | 树路径、终端 id、子分支名 | spawn 时 |
| `shifts/<sid>/run/` | 整目录删除 | 下工时 |
| `mem/learnings/*.md` | 运维事实 | 可自主写，但重写式 + 带日期 + 带证据，不许无限追加 |
| `mem/repos.json` | 仓库注册表 | 只经 `yan repo-add` |

### 只读 / 不写

| 路径 | 为什么 |
| --- | --- |
| `repos/<repo>/` | 主 clone。唯一允许的写是 `git fetch`。永不 checkout、永不改工作区、永不 commit |
| `shifts/<sid>/run/status` | `shift` 写的事件流，`yan` 只读 |
| `shifts/<sid>/outcome.md` | `shift` 主写。只在 `shift` 异常死亡没写时 `yan` 才补写，并注明是补记 |
| `tasks/<id>/artifacts/` | `shift` 主写。`yan` 可整理（重命名、加索引），不改内容 |
| `mem/user.md` | 只在 `user` 明确要求时写 |
| `conf/`（含 `hooks/`） | `user` 的本地选择 |
| `bin/`、`AGENTS.md` | `yan` 自己的工具和职责说明，运行时不自改 |
| 其他 `tasks/*/` | 只管自己那个 `task` |

## 附录 C · 脚本清单

每个子命令的步骤、以及它各自持有的那条顺序不变量，见 [`architecture.md` §5](architecture.md#5-20-个子命令)。

| 脚本 | 干什么 |
| --- | --- |
| `yan repo-add` | 注册一个 repo，clone 到 `repos/` |
| `yan task new` | 建 `tasks/<id>/`，写 brief |
| `yan unit add` | 加一个 `unit`（`target` 必须显式给），建集成分支 |
| `yan unit set` | 改 `branch` / `target` / `mode` / `scope`。换 `branch` 时判定 `end` 并归档（[§6.4](branching.md#64-unit-的结构当前是标量历史是-append-only)） |
| `yan start` | 建 `task` 的终端容器，在里面起 `yan` |
| `yan session-start` | 全量 reconcile，由 SessionStart hook 触发 |
| `yan tree` | 内置 worktree 池：`get` / `return` / `status`（[§7](worktree.md#7-worktree)） |
| `yan shift new` | 派一个 `shift` 出去（[§5.3](agents.md#53-shift-的生命周期)） |
| `yan send` | 单行消息发给 `shift` |
| `yan report` | `shift` 调用：append status + touch signal |
| `yan wait` | watcher 本体，由 autoarm 前台启动，盯三个 source（[§5.5](supervision.md#55-监督)） |
| `yan drain` | 模型被唤醒后读 wake 文件 |
| `yan state` | 从 meta + 终端 + git + GitLab 现场推导当前状态 |
| `yan scope-check` | diff 越界校验 |
| `yan shift done` | 收一个 `shift` 回来。动作顺序见 [§7](worktree.md#7-worktree) |
| `yan sync` | 集成分支跟上 `target` |
| `yan mr` | 开对外 MR |
| `yan land` | 合（需授权） |
| `yan ls` | 扫 `tasks/` 渲染队列 |
| `yan open` | 打开 `task` 目录 / artifacts |
| `hook-autoarm.sh` | asyncRewake Stop hook（[§5.5](supervision.md#55-监督)） |
| `hook-turnend-guard.sh` | 阻塞式 Stop hook（[§5.5](supervision.md#55-监督)） |
| `bin/lib-term.sh` | 终端操作内聚层（[§5.7](agents.md#57-终端拓扑)） |
| `bin/lib-forge.sh` | GitLab / GitHub 内聚层（[§8.4](delivery.md#84-forge-层lib-forgesh)） |
