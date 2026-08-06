# 决策记录

> 定位：本文只记「什么时候定的、定了什么、理由的摘要、展开在哪」。
> 每条决策的完整推理住在它管的那一节，不在这里——被否掉的那些选项也不在这里。
> 本文里的 `design §x` 指 `docs/design/` 下的设计文档，主干是 [`design/INDEX.md`](design/INDEX.md)，从它进去找到那一节住在哪个文件。

---

## 2026-08-05 · 动工前的 P0

三个都已敲定，并且已经折进设计文档。

| | 决定 | 理由 | 展开在 |
| --- | --- | --- | --- |
| **P0-1** | `yan` 自带 worktree 池（`yan tree get \| return \| status`） | 整个项目不必为此多依赖一个外部工具。treehouse 里值得抄的三样——随机 `lease_id`、条件还树、`--json`——一并抄了进来 | [design §7](design/worktree.md#7-worktree) |
| **P0-2** | GitLab 和 GitHub 都支持，抽一层 forge deep module | 工作用 GitLab，日常用 GitHub，两个都是真实需求。附带收益：0→1 的验收标准可以在 `yan` 自己身上跑通 | [design §8.4](design/delivery.md#84-forge-层lib-forgesh) |
| **P0-3** | 子分支推到远端，两级 MR 都保留 | 每个 `shift` 一个独立 MR，就是 `user` review 的主要方式 | [design §12](design/scope.md#12-待定)「已定」、[design §6.2](design/branching.md#62-两级-review) |

P0-3 掉出来一条不变量，已经写进设计：**下工和删分支都以 MR 状态为准，不以 git 祖先关系为准**
（[design §5.3](design/agents.md#53-shift-的生命周期)）。

---

## 2026-08-05 · 环境实测

这台机器上跑了一遍，把假设换成事实。

| 工具 | 状态 | 对设计的影响 |
| --- | --- | --- |
| `tmux` | ✅ 3.6 | [design §5.7](design/agents.md#57-终端拓扑) 的 0→1 路径没被卡住。原先担心的 tmux 缺失不成立 |
| `herdr` | ✅ 0.7.5 | 2→10 的第二份 `lib-term.sh` 实现有环境 |
| `treehouse` | ✅ v2.1.1 | 装着且在日常使用。但分支模型对不上，不拿它当池，理由见 [design §7](design/worktree.md#7-worktree) |
| `jq` | ✅ 1.8.1 | [design §2](design/INDEX.md#2-存储判据) 的硬依赖满足 |
| `git` | ✅ 2.53.0 | — |
| `gh` | ✅ 2.97.0 | GitHub 侧齐了 |
| `claude` | ✅ 2.1.222 | [design §5.5](design/supervision.md#55-监督) 三个 hook 的宿主 |
| `wtpool` | ❌ 不存在 | 它是另一台机器上未发布的 CLI。[design §7](design/worktree.md#7-worktree) 原本整节建立在它上面，这条直接导致了 P0-1 |
| `glab` | ❌ 不存在 | GitLab 那份 forge 实现暂时没有靶子可测，见 [`implementation-plan.md` §4](implementation-plan.md#4-现在挡路的问题) |
| `okt` | ❌ 不存在 | 不阻塞。[design §10](design/boundaries.md#10-外部权威接缝okt-等) 的 hook 本来就是 opt-in + gitignored |

---

## 2026-08-05 · 0→1 用 tmux，不用 herdr

[design §5.7](design/agents.md#57-终端拓扑) 写的就是 tmux，这里补两条本机实测的证据，说明为什么现在不换。
两条都是在这台机器、这个版本（herdr 0.7.5）上量到的，所以建议把它们一并记进 `mem/learnings/`，
留给写第二份 `lib-term.sh` 实现的那一天：

1. 宿主恢复后 herdr 会丢掉 agent 的启动参数，恢复出来的 agent 停在手动确认模式，
   看着活着但什么都不做。
2. 往 herdr 后端发按键（`BTab` / `S-Tab`）不生效。

tmux 是验证过的参考实现，所以 0→1 按 [design §5.7](design/agents.md#57-终端拓扑) 走它。`yan` 起一个独立的 tmux session
在技术上没有问题，因为两个多路复用器互不干扰；代价是屏幕上会同时出现两套容器。

---

## 2026-08-06 · 原子与编排的判据

| | 决定 | 理由 | 展开在 |
| --- | --- | --- | --- |
| **判据** | 子命令分成原子和编排，判据是它是否代表一个不可拆分的核心能力；原判据「有没有持有一条顺序不变量」不再用于这个分类 | 原子命令就是 `yan` 的 primitive，而不可拆分才是 primitive 真正的意义 | [`architecture.md` §5](design/architecture.md#5-子命令) |

顺序不变量这个概念本身继续用，只是不再当分类判据——例如 P0-3 掉出来的那条、以及编排命令各自持有的那条。

---

## 2026-08-06 · 设计原则 6 退役

| | 决定 | 理由 | 展开在 |
| --- | --- | --- | --- |
| **设计原则 6** | 「从 0 到 1，再到 2、10、100。每一步只加当前真实疼痛所需要的机制」不再列在设计文档的设计原则里 | 它说的是进度，而进度归实现计划管，不归设计文档管 | [`implementation-plan.md` §0](implementation-plan.md#0-切分原则) |

---

## 还没查的公司仓库配置

这两件都要看一眼公司仓库的配置，成本都很低。它们都是 P0-3（子分支推到远端）掉出来的。

1. **分支保护 / push 规则会不会拒绝 `yan/*`。** 有些团队对分支名有强制规范。
2. **已合的远端子分支要真的被删掉**，否则服务器上会堆一堆 `yan/*`。
   [design §7](design/worktree.md#7-worktree) 的下工顺序已经写了这一步；开内部 MR 时直接勾上「合并后删除源分支」最省事。
