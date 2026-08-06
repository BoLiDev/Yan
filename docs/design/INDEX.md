# `yan` 设计

> 定位：本文是设计决策的记录，不是实现规格。每条决策尽量带上「为什么」—半年后回来改的时候，理由比结论更重要。
> 每条决策是什么时候定的，见 [`../decisions.md`](../decisions.md)。

本文是主干。它先阐述后续会被反复讨论的三块内容（设计原则、词汇表、存储判据），
再逐个板块地描述整个系统的主干，以及每个板块在主干流程中的职责与位置。
本文希望能够帮助读者快速理解 `yan` 的设计思路，每个部分的细节留在子文当中，读者可按需查看。

---

## 0. 什么是 `yan`

`yan` 是一个单人用的软件工作编排系统：`user` 提出一件要做的事，`yan` 把它拆成可派发的活，派给一次性的 sub-agent 在隔离的 git worktree 里完成，最后交付成 GitLab MR。`user` 在整个过程中只需要专注于需求的理解和设计，以及对实现片段的审核，无需关心实现细节和琐碎的信息（例如 worktree 位置、分支名称、哪个 agent 在做哪个部分）；同时因其多 `shift` 可并行的特性，降低了处理任务队列的心智负担。

### 设计原则

1. 不要存可以推导出来的状态。目录结构、git 和 GitLab 是 source of truth，本地不镜像它们。
2. 一处一个 owner。每条信息有唯一的写入者和唯一的读取时机，以此避免状态不一致。
3. prose 负责判断，脚本负责不需要判断的步骤。脚本不应该出现带业务语义的 if，这通常意味着分层出错了。
4. `user` 和 agent 共用同一个入口。`yan` 的每一个动作都由 CLI 提供，`user` 可以直接调用，他看到的和 agent 看到的是同一份状态。
5. 不可逆的动作必须过脚本，并且默认拒绝。

---

## 1. 词汇表

全系统命名的唯一来源：脚本、文档、`AGENTS.md` 都用这里的词。

| 词 | 是什么 | 寿命 |
| --- | --- | --- |
| `task` | 一件要做成的事 | 长命（周、月） |
| `unit` | 交付通道：一个 repo + 一段 `scope` + 当前一个集成分支 + 一个交付目标 | 跟 `task` 同寿 |
| `scope` | 一个 `unit` 允许改动的路径集合 | 跟 `unit` 同寿，可显式扩张 |
| `shift` | 一份派出去的活，跟一个 sub-agent 一对一 | 短命（小时） |
| 集成分支 | `unit` 当前的 working 分支，`shift` 都从它切出、合回它 | 一轮交付；交付或废弃后由新的接替（[§6.3](branching.md#63-集成分支怎么变)） |
| 子分支 | 一个 `shift` 的工作分支，从集成分支切出，合回集成分支 | 跟 `shift` 同寿 |
| `target` | 集成分支最终要合进去的分支（master / release/x / 任意分支） | 可变，是决策 |
| `yan` | 主 agent，`user` 的唯一接口 | 中寿，无持久状态 |

读起来是：一个 `task` 有若干 `unit`；推进 `unit` 靠一个个 `shift`；每个 `shift` 在自己的子分支上干活，合回集成分支；集成分支最终交付给 `target`。

实现注意：`shift` 是 shell 内建命令。`yan shift new` 作为子命令没问题，但脚本里别用 `shift` 当变量名，用 `sid`。

---

## 2. 存储判据

这三条决定「什么该存、存在哪」，是整份设计里最常被引用的东西。

| 类别 | 例子 | 策略 |
| --- | --- | --- |
| 事实 | 分支、commit、merge history、diff | git 里，绝不镜像 |
| 状态 | MR open/merged、CI 绿不绿、有没有冲突 | GitLab 现场查，绝不镜像 |
| 决策 | `branch`、`target`、`scope`、`mode`、`unit` 怎么划、要不要合 | 必须自己存，而且变更历史有价值 |

推论是：一个 `unit` 用过哪些子分支、集成分支同步到 `target` 哪个点、MR 现在什么状态，这些全都不存，要用的时候现场查。但是「当前在哪个分支上干、打算往哪合」git 和 GitLab 都不知道（MR 还没开的时候尤其如此），所以必须自己存。

注意「为什么」不算结构化决策：它是叙事。叙事（「现在做到哪一步、还差什么」）正是第三类里值得单列的那个子类别，它是散文，任何工具都推不出来，也不适合塞进 JSON，所以它住在 `log.md`（[§4.2](memory.md#42-logmd--叙事层)）。

### 格式选择

判据是主要读者：脚本读的用 JSON，模型或者 `user` 读的用 Markdown。一个文件不要有两种身份。判据不是「以后要不要程序化」。

| JSON | Markdown |
| --- | --- |
| `mem/repos.json`、`tasks/<id>/task.json`、`run/meta.json` | `mem/user.md`、`mem/learnings/*.md` |
|  | `brief.md`、`log.md`、`report.md`、`outcome.md`、`run/status` |

`run/status` 保持纯文本追加行，因为它需要「崩溃也不毁坏已有内容」，而 JSON 数组做不到这一点。

用 JSON 要付三笔成本，都在脚本里统一处理：

1. 原子写：一律 `写 tmp → mv`。JSON 是整文件替换语义，中途断掉会毁掉整个文件；markdown append 则天然抗损坏。
2. `version` 字段：每个 JSON 都带。这是给未来 schema 迁移留的唯一钩子。
3. `jq` 是硬依赖，bootstrap 检查要列上。

---

## 3. 目录布局

```
$YAN_HOME/
  AGENTS.md                    yan 的职责说明（唯一常驻上下文）
  bin/  docs/

  mem/                         长命记忆，人可读可手改
    user.md                    user 的偏好与工作风格
    repos.json                 仓库注册表
    learnings/general.md       跨 repo 通用的坑
    learnings/<repo>.md        repo-specific 的坑

  tasks/<id>/                  * 目录本身长命
    task.json                  结构化决策：units / scope / 交付历史
    brief.md                   任务契约
    log.md                     append-only 叙事进度
    report.md                  知识产出（结论）
    artifacts/                 * 不该进真实仓库的项目产物
    shifts/<sid>/
      brief.md                 派工单                    ← 长命
      outcome.md               这个 shift 干了什么、结论  ← 长命
      run/                     * 唯一易失层，下工时整目录删
        meta.json              树路径 / 终端 id / 子分支名
        status                 事件流（append-only）
        signal                 唤醒标记

  conf/                        本地选择，gitignored
    hooks/                     外部权威接缝，见 boundaries.md §10

  repos/                       clone；yan 只读（唯一例外是 git fetch）
```

持久和易失的界线用目录来划，而不用文件清单：`tasks/<id>/` 长命，`.../run/` 易失。所以 `shift` 下工就是 `rm -rf .../run/` 加一次 `yan tree return`。用一个 `rm -rf` 就能清干净，因为「哪些文件该删」的清单迟早会漏。

没有 backlog 文件。 队列是扫出来的视图：`yan ls` 扫 `tasks/*/task.json`，这消掉了整个系统最容易出的那类 bug。

worktree 不在这棵树里。 `yan tree` 的池在 `~/.yan-trees/<repo>-<hash>/N/<repo>`，所以 `repos/` 对整个系统来说就是个纯粹的 git 源加代码参考，`shift` 干活根本不碰它。池的运行时记录（lease）也放在池根目录里，不放在 `$YAN_HOME`，因为它跟着池走，不跟着 `task` 走。

---

# 主干

## 记忆系统

`yan` 每次启动都要先知道两件事：`user` 是个什么样的人，以及这些仓库上踩过哪些坑。这两样住在 `mem/`，是全系统唯一跨 `task` 长命的记忆。

`mem/user.md` 只在 `user` 明确要求时才写，因为它是关于人的判断，写错会持续误导；`mem/learnings/` 允许 `yan` 拿到证据后自己写，因为写错的代价小，而每次都问会导致根本不写。`task` 内部的进度则不进记忆，而是一行一行追加进 `log.md`——它是 §2 第三类里那个「叙事」子类别的落点，`user` 和 agent 读的是同一份。还有一类东西既不进仓库也不进记忆，就是 artifact（prototype、截图、调研数据），它们必须写在 worktree 之外，否则不是被清掉就是被误提交进公司仓库。

→ [`memory.md`](memory.md)：[§4.1](memory.md#41-记忆的授权差别) 授权差别 · [§4.2](memory.md#42-logmd--叙事层) `log.md` · [§4.3](memory.md#43-artifact) artifact · [§4.4](memory.md#44-不存什么) 不存什么

## agent 与 `shift`

`yan` 是主 agent，也是 `user` 的唯一接口；真正写代码的是一次性的 sub-agent，每一份派出去的活叫做一个 `shift`。

一个 `yan` 只管一个 `task`，这样它的上下文预算有界，而且跟 `task` 总数无关。`yan` 自己不存任何运行状态，每次启动就做一次全量 reconcile，所以「关掉重开一个」永远是非事件。派一个 `shift` 出去，就是写 brief、租一棵树、起一个终端；`shift` 只在自己的树里干活，只在需要 `yan` 动作的时候往 `run/status` 追加一行事件。它的下工条件是客观的：子分支的 MR 已经合回集成分支。收回来的动作有固定顺序，还树必须排在删远端子分支之前。至于 `yan` 和 `shift` 之间怎么说话、哪些事根本不必唤醒模型，也都在这一节里。

→ [`agents.md`](agents.md)：[§5.1](agents.md#51-寿命分层) 寿命分层 · [§5.2](agents.md#52-一个-yan--一个-task) 一个 `yan` = 一个 `task` · [§5.3](agents.md#53-shift-的生命周期) `shift` 的生命周期 · [§5.4](agents.md#54-通信) 通信 · [§5.6](agents.md#56-harness-要求) harness 要求 · [§5.7](agents.md#57-终端拓扑) 终端拓扑

## 监督系统

`shift` 在自己的终端里跑几小时，中间没有人盯着。监督这一层要保证「它干完了」和「它卡住了」这两件事都能传到 `yan` 面前，而且不依赖模型记得去检查。

三个 Claude Code hook 撑起整条链路——SessionStart 保证每次启动先 reconcile，autoarm 在自己的前台跑起 watcher，turnend guard 则负责验证监督真的起来了。watcher 本体是 `yan wait`，它盯三个 source：`shift` 主动报告的 signal、agent 是不是还活着、以及 pane 内容长时间不变（这一条抓的是「忘记报告」，也是 agent 最常见的失败模式）。这一节篇幅最大，因为它记的多半是同类系统上已经踩过的实伤。

→ [`supervision.md`](supervision.md)：[§5.5 监督](supervision.md#55-监督)

## 分支模型

所有交付都落在一个两级结构上：若干条子分支合进一条集成分支，集成分支再整体合进 `target`。

每个 `shift` 一条子分支，合回集成分支就下工，所以 `shift` 的生命周期有了一个客观的绑定物；并发也天然隔离，因为每个 `shift` 各自一条子分支加各自一棵树。这个结构还顺带给出了两级 review——子分支那一级由 `user` 自己验收，集成分支那一级才交给同事，于是同事只看到一个 MR。集成分支不是长命的，它会被整个替换，所以 `unit` 的结构里当前状态是几个标量、历史是 append-only 的数组。分支怎么命名也有讲究：集成分支可以委托给外部权威，子分支的命名权则永远归 `yan`。

→ [`branching.md`](branching.md)：[§6.1](branching.md#61-分支结构) 分支结构 · [§6.2](branching.md#62-两级-review) 两级 review · [§6.3](branching.md#63-集成分支怎么变) 集成分支怎么变 · [§6.4](branching.md#64-unit-的结构) `unit` 的结构 · [§6.5](branching.md#65-分支的命名权威) 命名权威 · [§6.6](branching.md#66-yan-永不解析分支名) 永不解析分支名 · [§6.7](branching.md#67-unit-粒度的判据) `unit` 粒度

## worktree

`shift` 不碰主 clone，它在一棵租来的 worktree 里干活，而这些树由 `yan` 自带的池管理。

`yan tree get` 一步就把「基于哪个集成分支、切哪条子分支」办好，`yan tree return` 把树还回池里。池之所以存在，只是为了热复用——还树的时候用 `git clean -fd` 而永远不加 `-x`，gitignore 掉的依赖和构建缓存因此跨 `shift` 保留下来，大 monorepo 上省掉的就是每次冷装。还树之前要先回答一个问题：毁掉这棵树会不会丢东西。答案靠两行 git 命令，而不是靠「活有没有落地」那个更强的判据。

→ [`worktree.md`](worktree.md)：[§7 worktree 与池](worktree.md#7-worktree)

## 交付模式

「干到哪一步停」和「谁能按 merge」是两个正交的轴，`yan` 把它们显式分开。

`mode` 有三档，`scout` 只调研不改代码，`branch` 改完就停在本地分支，`mr` 一路推到远端并开出 MR；默认是 `mr`，因为推到远端就是最好的备份。强制手段不做隔离机制，用启动参数加一条落地前的 `yan scope-check` 就够，而且越界的语义是「必须显式扩」而不是「禁止」。真正跟外部世界打交道的是 forge 这一层，它把 GitLab 和 GitHub 的差异藏在四个动词底下。

→ [`delivery.md`](delivery.md)：[§8.1](delivery.md#81-mode-与-authority) `mode` 与 authority · [§8.2](delivery.md#82-scout--branch--mr) `scout` / `branch` / `mr` · [§8.3](delivery.md#83-强制手段) 强制手段 · [§8.4](delivery.md#84-forge-层lib-forgesh) forge 层

## 边界

前面这些结构都就位之后，还需要一条明确的线：哪些动作 `yan` 可以自己做，哪些必须等 `user` 开口。

`yan` 只写自己的记账层，主 clone 除了 `git fetch` 一律不碰，`shift` 则只写自己那三处加它租来的树。对外的副作用只用一条线分界：在自己的分支和本机范围内可以自主，影响到 `target`、或者同事会看见的动作，必须 `user` 明说。另外还有一类决策 `yan` 根本不打算自己做，比如集成分支该叫什么名字，这类通过 `conf/hooks/` 委托给外部权威。

→ [`boundaries.md`](boundaries.md)：[§9](boundaries.md#9-yan-的可写范围) 可写范围 · [§10](boundaries.md#10-外部权威接缝okt-等) 外部权威接缝（okt 等）

## 范围与待定

设计到这里就完整了，剩下的是划定第一版做多少，以及还没想清楚的几件事。

0→1 是一个 `yan` 入口加 20 个子命令、2 个 hook、8 个 lib，验收标准是整条链在 `yan` 自己这个仓库上跑通一遍。它比同类的编排系统小得多，原因不是写得更好，而是那些系统膨胀的理由 `yan` 一个都没有。往后的路线分成 1→2、2→10、10→100 三段，Herdr 确定要支持，只是先不做。

→ [`scope.md`](scope.md)：[§11](scope.md#11-01-范围) 0→1 范围 · [§12](scope.md#12-待定) 待定

## 代码结构

上面都是「为什么」，而这些决策落到文件上是什么形状，是另一个问题。

整个 `bin/` 由两条正交的切法交叉出来，依赖只往下、从不往上；模型只能跑 `yan <cmd>`，从不 source 任何 lib。子命令分成原子和编排两类，判据是它有没有持有一条顺序不变量。分层最实在的回报在可测性上：接缝是唯一碰外部世界的东西，所以测一个子命令就等于把接缝换成替身。

→ [`architecture.md`](architecture.md)：分层、模块职责、仓库结构、可测性

## 附录

三份查的时候才看的清单：记忆读写契约、`yan` 的文件系统边界、脚本清单。

→ [`appendix.md`](appendix.md)：[附录 A](appendix.md#附录-a--记忆读写契约) / B / C

---

## 设计之外的文档

| 文档 | 装什么 |
| --- | --- |
| [`../implementation-plan.md`](../implementation-plan.md) | 按什么顺序做，每块必须自带哪些用例 |
| [`../decisions.md`](../decisions.md) | 某个决定是什么时候定的，当时手上有什么 |
