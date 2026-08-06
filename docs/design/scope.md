# 范围与待定

## 11. 0→1 范围

### 范围

一个 `yan` 入口加 20 个子命令、2 个 hook 脚本、8 个 lib（子命令和 hook 清单见 [附录 C](appendix.md#附录-c--脚本清单)，8 个 lib 和怎么摆见 [`architecture.md` §3](architecture.md#3-仓库结构)、[`architecture.md` §5](architecture.md#5-子命令)），外加 `AGENTS.md`。

范围里最重的两块是内置 worktree 池（[§7](worktree.md#7-worktree)）和 forge 层支持两个远端（[§8.4](delivery.md#84-forge-层lib-forgesh)）。
其中池的分支感知、还树判据、孤立 commit 守卫本来就要写，真正多出来的只有复用池和 lease。
换回的是零外部依赖，以及 0→1 能在 `yan` 自己身上验收。

**0→1 验收**：一句话需求 → 一个 `unit` → 一个 `shift` → 子分支 MR 合回集成分支 → `shift` 下工还树 → 对外 MR 开出 → `user` 说合 → 合掉 → `log.md` 完整记录了整条链路。

### 为什么比 firstmate 小得多

firstmate 有 109 个文件、19 个 skill。差距不是奇迹，就是「明确不做」那些决定的和：

| 它有而 `yan` 没有 | 说明 |
| --- | --- |
| watcher 与独立 triage 层 | 唤醒管道 1:1 照搬，省掉的是那层独立 triage（[§5.5](supervision.md#55-监督)） |
| 多 backend（Herdr / zellij / orca / cmux / codex-app）加抽象层 | `yan` 以后只需 `lib-term.sh` 的第二份实现 |
| X mode 与 public-followup | 完全不做 |
| PR poll 注册与信任绑定 | `shift` 下工不等 CI，不需要 |
| secondmate 与配置继承 / AFK / no-mistakes 集成 | 一个 `yan` 一个 `task`，没有二级 agent 树 |
| install / lint / doc-check / treehouse | 池内置，其余不做 |

差距不只在数量上，也在每个文件的厚度上：firstmate 的每个脚本里都塞着多 backend 分支、
安全 journal、迁移路径。**`yan` 没有这些，不是因为写得更好，是因为它膨胀的原因我们一个都没有。**

### 关于 no-mistakes

不引入。 它在 firstmate 里承担「review + 补测试 + 补文档 + 修 CI」的自动化流水线，不引入的代价是质量把关落回 `user` + CI + 同事 review—这本来就是正常团队的做法。

一致性检查：`yan` 的 `mode` 体系里没有 no-mistakes 那一档，默认 `mr` 直接开 MR；CI 红了由 `yan` 查 GitLab 发现、派新 `shift` 修（[§5.3](agents.md#53-shift-的生命周期)），整条链路不依赖它。

### 路线

| 阶段 | 加什么 |
| --- | --- |
| 0→1 | 上面这些。单 `unit` 单 `shift` 跑通 |
| 1→2 | 多 `unit`（跨 repo / 跨 monorepo 子应用）、`needs` 落地顺序、多 `shift` 并发、`yan wait` 加 GitLab 轮询作为第四个 source |
| 2→10 | Herdr（`lib-term.sh` 的第二份实现）、`scout` 交付物、卡死 `shift` 的恢复流程 |
| 10→100 | 按任务选 model/effort、`merge-check` hook、learnings 定期裁剪 |

Herdr 是确定要支持的，只是受时间所限先不做。它带来两样 tmux 给不了的东西：

1. 原生 per-pane agent 状态—`term_agent_alive` 从猜变成问（[§5.7](agents.md#57-终端拓扑)）。
2. push 事件（`pane.agent_status_changed`）—`yan wait` 的第三个 source（pane hash 不变 = 可能卡住）是个启发式；Herdr 的原生 `blocked` 状态是事实。轮询可以换成订阅一个 socket。

[§5.7](agents.md#57-终端拓扑) 把终端操作内聚成七个函数就是为了这一天：加 Herdr = 写第二份实现，不改数据模型。

### 明确不做

- `yan` 跑在 Claude Code 以外的 harness 上（[§5.6](agents.md#56-harness-要求)）。Codex、Kimi Code 等只作为 `shift` 的 harness
- backend 抽象层 / 插件框架—Herdr 作为 `lib-term.sh` 的第二份实现进来，不需要框架
- 社交平台入口
- 跨 provider 配额路由
- 二级 agent 树（`yan` 不 spawn `yan`）
- 自己的质量流水线（firstmate 的 no-mistakes 位置）

这些是 firstmate 的具体处境，不是 `yan` 的。

---

## 12. 待定

全系统还没定的都在这里，包括代码结构上的那几个。

1. `$YAN_HOME` 要不要 git 版本化？ `mem/user.md` 和 `learnings/` 有提交历史挺有价值（能看到偏好怎么演化）。如果版本化，`tasks/` 要不要一起进去（会很吵）。倾向 `mem/` 进、`tasks/` 不进。不阻塞 0→1—随时能加，`git init` 一下的事。
2. `tasks/` 的裁剪策略：倾向不自动删任何东西，靠 `yan prune` 半手工裁，且 `artifacts/` 即使裁剪也单独保留。不阻塞 0→1，那时根本没有积累量。
3. `yan` 的 `task` id 格式：`t042` 这种纯序号，还是带语义的 slug？序号短但不可读，slug 可读但会跟 brief 标题重复。注意它会进分支名（[§6.5](branching.md#65-分支的命名权威) `yan/<task>-<unit>-<sid>`），所以短的有实际好处。倾向 `t042` 式序号，可读的标题住在 `brief.md` 和 `log.md` 的标题行。这条要在写 `yan task new` 之前定，见 [`implementation-plan.md` §4](../implementation-plan.md#4-现在挡路的问题)。
4. `lib-pool` 的池根目录要不要做成可配置？`~/.yan-trees/<repo>-<hash>/N/<repo>`（[§3](INDEX.md#3-目录布局)）是当前写法。

### 已定：子分支推到远端

**定了：推。** 两级 MR 都保留。

理由不在那些一条一条列得出来的利弊里，而是：**每个 `shift` 一个独立 MR，
就是 `user` review 的主要方式**—一个 `shift` 一个 `shift` 地看它相对集成分支的 diff，
本地基本不用看代码。这把 [§6.2](branching.md#62-两级-review) 的两级 review 从「结构自带的副产品」
变成了「要这个系统的原因之一」。

被明确接受的代价：服务器上会有一堆 `yan/*` 分支和一堆内部 MR。清理办法见 [§5.3](agents.md#53-shift-的生命周期) 和 [§7](worktree.md#7-worktree)
的下工顺序—合了就删，删排在还树之后。CI 的重复触发成本经 `user` 判断可以忽略，不做处理。
