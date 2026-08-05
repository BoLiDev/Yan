# yan 设计

> 状态：草案。2026-08-05 按三个 P0 决定修订，决策记录见 [`decisions.md`](decisions.md)。
> 定位：这份文档是设计决策的记录，不是实现规格。每条决策尽量带上「为什么」—半年后回来改的时候，理由比结论值钱。
> 代码怎么摆、每块怎么测，是另外两份：[`architecture.md`](architecture.md)、[`implementation-plan.md`](implementation-plan.md)。
>
> **2026-08-05 改动**：§7 worktree 池改为 yan 内置（不再依赖 wtpool，也不包 treehouse）；
> 新增 §8.4 forge 层，GitLab 和 GitHub 都支持；§12 待定 5「子分支上远端」定为**推**，
> 两级 MR 保留。连带 §3 / §5.3 / §9.2 / §11 / 附录 C 同步更新。

## 目录

- [0. 这是什么](#0-这是什么)
- [1. 词汇表](#1-词汇表)
- [2. 三条判据](#2-三条判据)
- [3. 目录布局](#3-目录布局)
- [4. 记忆系统](#4-记忆系统)
  — [4.1 授权差别](#41-记忆的授权差别) · [4.2 `log.md`](#42-logmd--叙事层) · [4.3 artifact](#43-artifact) · [4.4 不存什么](#44-不存什么)
- [5. Agent 系统](#5-agent-系统)
  — [5.1 寿命分层](#51-寿命分层决定存储策略) · [5.2 一个 yan = 一个 task](#52-一个-yan--一个-task) · [5.3 shift 的生命周期](#53-shift-的生命周期) · [5.4 通信](#54-通信) · [5.5 监督](#55-监督) · [5.6 harness 要求](#56-harness-要求) · [5.7 终端拓扑](#57-终端拓扑)
- [6. 分支模型](#6-分支模型)
  — [6.1 两级结构](#61-两级结构) · [6.2 两级 review](#62-两级分支--两级-review) · [6.3 集成分支怎么变](#63-集成分支怎么变) · [6.4 unit 的结构](#64-unit-的结构当前是标量历史是-append-only) · [6.5 命名权威](#65-两级分支有两个不同的命名权威) · [6.6 永不解析分支名](#66-yan-永不解析分支名) · [6.7 unit 粒度](#67-unit-粒度的判据)
- [7. worktree](#7-worktree)
- [8. 交付模式](#8-交付模式)
  — [8.1 两个正交的轴](#81-两个正交的轴) · [8.2 三种 mode](#82-三种-mode) · [8.3 强制手段](#83-强制手段) · [8.4 forge 层](#84-forge-层lib-forgesh)
- [9. yan 的可写范围](#9-yan-的可写范围)
  — [9.1 文件系统](#91-文件系统) · [9.2 外部副作用](#92-外部副作用真正需要边界的部分)
- [10. 外部权威接缝（okt 等）](#10-外部权威接缝okt-等)
- [11. 0→1 范围](#11-01-范围)
- [12. 待定](#12-待定)
- [附录 A · 记忆读写契约](#附录-a--记忆读写契约) · [附录 B · 文件系统边界](#附录-b--yan-的文件系统边界) · [附录 C · 脚本清单](#附录-c--脚本清单)

---

## 0. 这是什么

yan 是一个单人用的软件工作编排系统：user 提出一件要做的事，yan 把它拆成可派发的活，派给一次性的 sub-agent 在隔离的 git worktree 里完成，最后交付成 GitLab MR。

firstmate 是灵感来源，不是蓝本。yan 有意在几处走了不同的路，每处都标注了原因。

### 设计原则

1. 状态能推导就不要存。 目录结构、git、GitLab 是权威；本地不镜像它们。这是 wtpool（user 自己的 worktree 池）已经验证过的路子。
2. 一处一个 owner。 每条信息有唯一的写入者和唯一的读取时机。同一个状态记在两个地方，迟早会不一致。
3. 判断归 prose，机制归脚本。 一旦发现在 shell 里写业务语义的 if，就是层放错了。
4. user 和 agent 共用同一个入口。 所有能力都是 CLI，user 能自己敲，看到的和 agent 看到的是同一份现实。
5. 不可逆的动作必须过脚本，并且默认拒绝。
6. 从 0 到 1，再到 2、10、100。 每一步只加当前真实疼痛所需要的机制。

---

## 1. 词汇表

全系统命名的唯一来源：脚本、文档、`AGENTS.md` 都用这里的词。

| 词 | 是什么 | 寿命 |
| --- | --- | --- |
| task | 一件要做成的事 | 长命（周、月） |
| unit | 交付通道：一个 repo + 一段 scope + 当前一个集成分支 + 一个交付目标 | 跟 task 同寿 |
| scope | 一个 unit 允许改动的路径集合 | 跟 unit 同寿，可显式扩张 |
| shift | 一份派出去的活，跟一个 sub-agent 一对一 | 短命（小时） |
| 集成分支 | unit 当前的 working 分支，shift 都从它切出、合回它 | 一轮交付；交付或废弃后由新的接替（§6.3） |
| 子分支 | 一个 shift 的工作分支，从集成分支切出，合回集成分支 | 跟 shift 同寿 |
| target | 集成分支最终要合进去的分支（master / release/x / 任意分支） | 可变，是决策 |
| yan | 主 agent，user 的唯一接口 | 中寿，无持久状态 |

读起来是：一个 *task* 有若干 *unit*；推进 *unit* 靠一个个 *shift*；每个 *shift* 在自己的子分支上干活，合回集成分支；集成分支最终交付给 *target*。

实现注意：`shift` 是 shell 内建命令。`yan shift new` 作为子命令没问题，但脚本里别用 `shift` 当变量名，用 `sid`。

---

## 2. 三条判据

这三条决定「什么该存、存在哪」，是整份设计里最常被引用的东西。

| 类别 | 例子 | 策略 |
| --- | --- | --- |
| 事实 | 分支、commit、merge history、diff | git 里，绝不镜像 |
| 状态 | MR open/merged、CI 绿不绿、有没有冲突 | GitLab 现场查，绝不镜像 |
| 决策 | branch、target、scope、mode、unit 怎么划、要不要合 | 必须自己存，而且变更历史有价值 |

推论：一个 unit 用过哪些子分支、集成分支同步到 target 哪个点、MR 现在什么状态—全都不存，现场查。但「当前在哪个分支上干、打算往哪合」git 和 GitLab 都不知道（MR 还没开的时候尤其），必须自己存。

注意「为什么」不算结构化决策：它是叙事，归 `log.md`（§4.2），不进 JSON。

第三类有个子类别值得单列：叙事（「现在做到哪一步、还差什么」）。它是散文，任何工具都推不出来，也不适合塞进 JSON。它住在 `log.md`（§4.2）。

### 格式选择

主要读者是脚本 → JSON；主要读者是模型或 user → Markdown。一个文件不要有两种身份。 判据不是「以后要不要程序化」。

| JSON | Markdown |
| --- | --- |
| `mem/repos.json`、`tasks/<id>/task.json`、`run/meta.json` | `mem/user.md`、`mem/learnings/*.md` |
|  | `brief.md`、`log.md`、`report.md`、`outcome.md`、`run/status` |

`run/status` 保持纯文本追加行，因为它需要「崩溃也不毁坏已有内容」，JSON 数组做不到。

用 JSON 要付三笔成本，脚本里统一处理：

1. 原子写：一律 `写 tmp → mv`。JSON 是整文件替换语义，中途断掉会毁掉整个文件；markdown append 天然抗损坏。
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
    hooks/                     外部权威接缝（§10）

  repos/                       clone；yan 只读（唯一例外是 git fetch）
```

持久 / 易失的界线用目录划，不用文件清单：`tasks/<id>/` 长命，`.../run/` 易失。shift 下工 = `rm -rf .../run/` + `yan tree return`。一个 `rm -rf` 就干净—「哪些文件该删」的清单迟早会漏。

没有 backlog 文件。 队列是扫出来的视图：`yan ls` 扫 `tasks/*/task.json`，消掉了整个系统最容易出的那类 bug。

worktree 不在这棵树里。 `yan tree` 的池在 `~/.yan-trees/<repo>-<hash>/N/<repo>`，所以 `repos/` 对整个系统就是个纯粹的 git 源加代码参考，shift 干活根本不碰它。池的运行时记录（lease）也在池根目录里，不在 `$YAN_HOME`—它跟着池走，不跟着 task 走。

---

## 4. 记忆系统

### 4.1 记忆的授权差别

`user.md` 和 `learnings` 的授权不同，理由：learnings 写错代价小（下次发现就改），每次都问会导致根本不写；`user.md` 是关于人的判断，写错会持续误导。所以 learnings 允许 yan 自主写（重写式、带日期、带证据），`user.md` 只在 user 明确要求时写。

每条记忆的「谁写 / 何时写 / 谁读 / 何时读」完整清单见 附录 A。

### 4.2 `log.md` — 叙事层

JSON 装不下「做到哪了」，而单独维护一份 `progress.md`，它和各个 `outcome.md` 迟早会对不上。所以用 append-only 的一行式日志：

```markdown
# t042 统一鉴权 header

- 08-04  s1 auth       实现 header 解析          → !31 合入集成分支
- 08-05  s2 auth       接入 auth header          → !33 合入集成分支
- 08-06  s3 auth       修 CI 报的类型错          → !35 合入集成分支
- 08-07  auth       对外 MR !88 → release/bigproject
- 09-01  决策       改为往 master 合（大项目稳定期结束）
```

append-only 所以永不冲突；一行一条所以成本几乎为零；user 和 agent 读同一份—想知道情况 `cat log.md` 就够，不用拼二十个 `outcome.md`。它也是新 shift 的上下文来源：生成 brief 时整个塞进去（足够短）。

### 4.3 artifact

理由是硬的：公司仓库是多人协作的，不能随便塞东西。 prototype html、设计文档、截图、性能图表、调研数据—项目相关，但不该进仓库。

由此一条硬约束：artifact 必须写在 worktree 之外。

因为 worktree 要被 `yan tree return` 清空。shift 如果把 prototype 写在树里，两种结局都糟：被清掉，或者被 commit 进公司仓库。所以 spawn 时注入 `YAN_TASK_DIR=$YAN_HOME/tasks/<id>`，brief 明确要求产物写 `$YAN_TASK_DIR/artifacts/`。这条同时挡掉「agent 顺手把设计文档提交进公司仓库」这类事故—对多人仓库来说这个防护比省上下文更值钱。

它的寿命跟 task 目录一样长，不随 shift 下工删除—价值恰恰在任务结束之后。主要读者是 user，所以需要 `yan open <id>` 直接打开目录或在浏览器里看 html。索引 0→1 不做，靠目录和文件名，多到找不着再说。

和 `report.md` 的界线：report 是结论（给 agent 读、给未来 intake 复用）；artifacts 是产物本身（给人看的东西）。一个 prototype html 属于 artifacts，「这个 prototype 验证了什么」属于 report。

### 4.4 不存什么

临时路径、会变的版本号、复制过来的状态快照；repo 自己就能说明的东西（代码结构、git history—那属于 repo 的 `AGENTS.md`）；任何 git 或 GitLab 已经权威持有的东西。

---

## 5. Agent 系统

### 5.1 寿命分层决定存储策略

| 寿命 | 谁 | 存储策略 |
| --- | --- | --- |
| 长 | task 及其资产 | 文件，持久，手工裁剪 |
| 中 | yan | 没有自己的状态文件 |
| 短 | shift / sub-agent | 易失文件，下工即删 |

中间那条是关键：yan 不该有任何持久运行状态。 每次启动就是一次全量 reconcile—扫 `tasks/`、查终端、查树池，现实是什么就是什么。这样「关掉重开一个」永远是非事件，不需要交接、不需要 resume。

这也让 task 的状态大部分不用存：「从没派过 shift」看 `shifts/` 是否为空、「有 shift 活着」扫 `run/` 加查终端、「没 shift 活着但没完成」是两者的补集—全部可推导。只有「已宣布完成」必须存，因为那是 user 的决定，不是事实。所以 `task.json` 里只需要一个完成标记，零状态漂移。

### 5.2 一个 yan = 一个 task

这是跟 firstmate 最大的分歧之一（它是一个主 agent 管所有项目所有任务）。

理由：yan 的上下文预算有界，且跟 task 总数无关。firstmate 需要「启动内存预算」「压缩版 backlog 列表」「状态日志只读尾部」那一整套上下文管理机制，根源就是它的主 agent 要装下全局。

一个 task-scoped yan 的世界：

```
必读   AGENTS.md · mem/user.md · tasks/<id>/{task.json,brief.md,log.md}
       tasks/<id>/shifts/*/run/          （重建现实）
按需   mem/repos.json                    （查 clone 路径）
       mem/learnings/<repo>.md           （只读涉及的那几片）
       tasks/<id>/shifts/*/outcome.md    （开新 shift 时）
       repos/<repo>/                     （只读，判断 scope、看代码结构）
不读   其他 task 的任何东西
```

启动命令：

```sh
cd "$YAN_HOME" && YAN_TASK=t042 claude \
  --add-dir "$YAN_HOME/repos/monorepo-x" --add-dir "$YAN_HOME/repos/proto"
```

cwd 是 `$YAN_HOME`（要跑 `bin/`、读 `mem/`），`--add-dir` 只放这个 task 涉及的 clone—别的 repo 它根本看不见。

跨 task 的事谁管？答案都是「脚本，不是 agent」：

- 两个 task 改了同一个 scope 会不会撞？  不需要任何机制。worktree 隔离了文件系统冲突；git 冲突和语义冲突是正常的开发现实，由 rebase + CI + review 处理，GitLab 会在合的时候告诉你。文件重叠不是串行化的理由。
- 想看全局有哪些 task 在跑？  `yan ls` 扫目录，user 自己敲。它带一列 scope 是有用的信息（user 自己判断要不要在意），但 yan 主动扫描并告警是噪音—重叠很常见、会反复报警然后被忽略。
- 多个 yan 同时写 `mem/`?  `user.md` 只在明确要求时写，而 user 一次只跟一个 yan 说话。真要保险加 flock。

锁的粒度是 task，不是 home。 同时开两个 yan 做两个 task 完全合法；只有对同一个 task 开第二个 yan 才拦。

### 5.3 shift 的生命周期

- 出生：yan 写 `shifts/<sid>/brief.md` → `yan tree get --base <集成分支> --branch <子分支>` 租树（holder = `<task>/<unit>/<sid>`）→ 起终端 → 注入 `YAN_TASK_DIR`
- 干活：只在自己的树里；稀疏地往 run/status 追加需要 yan 动作的事件
- 下工：子分支的 MR 已合回集成分支 → 写 `outcome.md` → `rm -rf run/` → `yan tree return` → 删远端子分支

下工条件为什么是「MR 合回集成分支」：  合了就意味着改动已经在集成分支上（远端有副本），树里的东西没有独占价值，还树是安全的。这比「活干完了」更强、更可验证，而且完全客观。

**判断「合没合」查 MR 状态，不查 git 祖先关系。** 内部 MR 若是 squash 合的，集成分支不含子分支的 HEAD，祖先关系会说谎—但活确实已经落了。删分支同理。这和 §6.6「不解析分支名、归属查权威源」是同一条原则的延伸。

还树必须排在删远端子分支之前，理由见 §7。

不等对外 MR 的 CI。  这是有意的：只要 shift 挂在那儿等，就必须持续判断「它是在等还是卡了」—而那正是 firstmate `fm-crew-state.sh` 那五步推导（run-step 归属校验、head 祖先关系判断、status log 陈旧性反证、ci 步骤下「还在等检查」vs「检查绿了在等合并」的歧义消解）存在的唯一原因。为省一次重启把这整块复杂度请回来不划算。CI 红了由 yan 查 GitLab 发现，再派新 shift 修—轮询一个权威数据源比监督一个挂着的 agent 便宜一个数量级。

shift 从不横跨 task。  一个 shift 可以横跨同一个 task 的多个 unit（比如同时动 auth 和 gateway，一个 sub-agent 持两棵树），但那意味着两个子分支、两个 MR。

### 5.4 通信

| 方向 | 机制 | 约束 |
| --- | --- | --- |
| yan → shift（出生） | `brief.md` 文件 | 长契约只在这里，一次性 |
| yan → shift（运行中） | `yan send` 包 `term_send`，单行短消息 | 长指令写成文件只发路径。文字和 Enter 分开发，文字只打一次、只重试 Enter（firstmate 的教训） |
| shift → yan | `yan report <state> "<note>"` | 脚本同时 append `run/status` + touch `run/signal` |

为什么 `yan report` 必须是个脚本，而不是「brief 里要求 agent 做两件事」：别指望 agent 记得做两步。包成一个命令还能顺带校验 state 只属于那五个词、加时间戳、原子写。这是 shift 唯一需要调的 yan 命令（外加自查用的 `yan scope-check`）。

三条铁律：shift 之间不通信（需要协调的活由同一个 shift 持多棵树完成）；shift 从不直接对 user 说话（所有汇报走 status，由 yan 翻译成人话）；*`run/status` 的每一行是事件，不是当前状态*—这条必须一开始就分清，否则会重演 firstmate「`tail -1` 报的是最后一个事件而不是当前状态」那个坑。

#### 确定性的推进不要唤醒模型

一个事件到达时先问：这件事需要判断吗？  不需要判断的，脚本直接做完，模型根本不必醒。

| 脚本自己做完 | 需要判断 → 唤醒模型 |
| --- | --- |
| shift 报 done，写 `log.md` 一行 | 合并有冲突 |
| 子分支无冲突合回集成分支 | shift 报 `blocked` / `needs-decision` |
| 某个 unit 的 `needs` 已满足、还没派过 shift → 派下一个 | shift 死了 / 卡了 |
|  | CI 红了怎么修 |

落地顺序已经在 `task.json` 的 `needs` 里声明了，所以「A 落了 → 派 B」是纯编排，不是判断。这类推进由 `yan report` 自己完成，链条不必在每个环节停下来等模型。

右边那些需要判断的，恰好也都是 user 该知情的事—「唤醒模型」和「值得打扰 user」这两条线基本重合。

### 5.5 监督

监督机制 1:1 照搬 firstmate 的三个 hook（都注册在 `.claude/settings.json`），但不抄它的 triage 层。

| hook | 类型 | 干什么 |
| --- | --- | --- |
| SessionStart | nudge | 注入一句「先跑 `yan session-start`」 |
| Stop（autoarm） | `asyncRewake: true`，长 timeout | 拿单飞锁 → 在自己前台跑 `yan wait` → 翻译成 exit 0/2 |
| Stop（turnend guard） | 阻塞式 | 监督不健康就拦住结束 turn，有界后 fail open |

autoarm 负责起监督，guard 负责验证监督真的起来了—一个做事，一个验收。

`yan wait` 是 watcher 本体，由 autoarm 在前台启动；模型从不调用它—所以「模型忘了起监督」这个失败模式不存在。它的输出契约是给 hook 读的（退出码加一行 reason），不是给模型读的 stdout：有事就写 wake 文件、打印 reason、exit 0；无事就静默 exit 非 0。它同时是纯观察者，不持有任何状态：超时、被杀、随 hook 进程树死掉，都不丢任何东西—shift 还在自己的终端里，状态全在文件里。这是「重启是非事件」在监督层的体现。

SessionStart 是「重启即对接」的保障。这个能力本身来自 durable state 加全量 reconcile（§5.1），不来自任何 hook—firstmate 的原话：

> A restart must be a non-event because durable state and live backend inventory, not conversation memory, are authoritative.

hook 的作用只是让它不依赖模型记得去做，启动就注入一条指令要求先 reconcile。firstmate 用的就是这个（`FIRSTMATE_OP: v1 session-start: Run bin/fm-session-start.sh now, exactly once, before executing any other instructions`）。

#### 完整流程

```
你说话 → yan 处理完 → 准备结束 turn
   ↓  两个 Stop hook 被同一事件触发，并发

   guard（同步阻塞）                 autoarm（asyncRewake, 长 timeout）
   ─────────────────             ──────────────────────────────────
   有活要监督吗？                     有活要监督吗？
     没有 → 放行                        没有 → 退出
   watcher 健康吗？                    拿单飞锁
     健康 → 清零计数，放行                 在自己前台跑 yan wait
   等 800ms 看锁被认领了吗                 ↓ 阻塞几分钟到几小时
     认领了 → 放行                      watcher 发现 s1 done
   都没有 → 计数 +1                       ↓ 写 wake 文件
     ≤3 → exit 2 拦住，模型去修           exit 2 + stderr banner
     >3 → 放行 + 报警                     ↓
                                      yan 被唤醒 → yan drain
                                      →  「s1 完成，MR ...」
```

800ms 的因果：两个 hook 由同一个 Stop 事件触发，所以它们在赛跑。guard 很可能比 autoarm 先跑到检查点—那时 autoarm 还没拿到锁、watcher 还没起来，看起来像「没人看家」，其实人正在进门。所以 guard 等一下（firstmate 用 `FM_CLAUDE_AUTOARM_SYNC_WAIT_MS`，默认 800ms）给它认领的机会。没有这个等待，guard 会在每一次正常的 turn 结束时误报。

「三次」的主体是模型，不是 guard。  guard 自己不起 watcher—它 exit 2 拦住 turn，模型被迫继续去查去修（看日志、检查终端还在不在、手动 arm 一次），再尝试结束 turn。所以三次 = 给模型三次介入机会。

#### 三样基础设施

|  | 为什么 |
| --- | --- |
| 单飞锁 | Claude 对 async hook 不去重，每次 Stop 都触发一次。没有锁就会起多个 watcher |
| wake 文件 | 唤醒原因必须从「watcher 退出」活到「模型下一个 turn」。exit 2 只带一行 banner 不够。firstmate 原话：*The durable wake queue preserves actionable events between a rewake and the next Stop-launched arm* |
| beacon | `yan wait` 每轮 touch 一个时间戳文件，因为 pid 活着 ≠ watcher 在工作 |

所以「watcher 健康」不是「进程还活着」，而是三件事同时成立：lock 存在且其中的 pid 活着、身份匹配（那个 pid 真是我们的 watcher，不是 pid 复用后的别人）、beacon 新鲜（默认 300 秒）。firstmate 两个方向都拦：*A stale beacon blocks even when a watcher pid is live; A fresh leftover beacon blocks when the lock is missing, dead, or identity-mismatched.*

autoarm 的关键结构是 `asyncRewake: true` 加一个很长的 timeout（firstmate 用 `timeout: 28800`，8 小时），让 hook 本身能活几小时；watcher 跑在 hook 的前台（绝不用 shell &），所以 harness 拥有进程组，超时或会话销毁时两者一起被杀。timeout 必须设长，否则 hook 被杀 watcher 就跟着死。

#### guard 的三个设计要点

**一、它的价值在 autoarm 根本没跑的时候。** 如果 autoarm 跑了但失败了，它自己会留下失败记录。但如果它压根没被调用（`.claude/settings.json` 被改坏、hook 路径错了、harness 跳过了它），它连「失败」都不会留下—什么记录都没有，看起来跟一切正常一模一样。这时 guard 是唯一的探测手段。

> 这就是它必须是独立的第二个 hook—一个没跑的 hook 没法报告自己没跑。

**二、不能用 `stop_hook_active` 防死锁。** 一般 harness 靠它—含义是「这次 stop 紧跟在一次 hook 拦截之后」，读到 true 就放行，从而保证每个 turn 最多被拦一次。Claude 下这样做是错的，firstmate 的 `docs/turnend-guard.md` 原话：

> *Claude Code sets `stop_hook_active=true` on every stop after any stop-hook continuation, including `asyncRewake` rewakes, which re-opened the 2026-07-21 blind window under the default one-shot behavior.*

根源是两件完全不同的事共用了一个标志：guard 拦截的含义是「我刚拦过你，别再拦」（需要计数），autoarm rewake 的含义是「有事了，醒醒」（跟防死锁完全无关）。被 autoarm 唤醒的那个 turn，它的第一次 stop 就已经带 true 了—按本意该是 false，guard 从没拦过它。于是 guard 直接放行，而那个 turn 结束时恰恰需要起新 watcher。盲窗。这是踩过的实伤，不是理论风险。

所以自己数：计数写 `run/guard-failures`，watcher 恢复健康时清零，autoarm 的 rewake 碰不到它。两个额外收获：

- guard 完全不需要读 hook 的 stdin—它要的信息（有没有活、watcher 健康否、拦过几次、哪个 task）全在文件系统和 `YAN_TASK` 环境变量里。于是不依赖 `jq`，也没有 firstmate 那两个「jq 没装 / stdin 是空的」的 fail-open 分支。好测试，也不会被 harness 改 payload 悄悄搞坏。
- 语义更合适：`stop_hook_active` 是「每 turn 拦一次、无限期唠叨」；自己数是「整个故障期间拦 3 次，然后明确报警并闭嘴」。autoarm 的 rewake 会频繁产生新 turn，前者会很吵而且没用。

预算设 3，留在 Claude 自身那个 8 次硬上限以下（`fm-turnend-guard.sh` 注释：*below Claude's 8-block override*）—由我们自己决定何时放弃并打印有意义的警告，而不是被 harness 静默强行放行。

**三、用完预算必须 fail open。** 含义不是「算了不管了」，而是「进入盲跑，并且大声告诉你」：shift 还在干活一切照旧，事件还在往 `run/status` 里写一条不丢，只是没人在盯—干完了不会有人叫你。所以那次放行必须打印一句明确的话：自动监督坏了，从现在起得你自己看。那时的选择是自己 `yan ls` 看看，或者重启 yan（SessionStart 会 reconcile，往往顺手就恢复了）。

为什么不能一直拦：一直拦 = 整个 session 废掉，你连话都说不上，而且每一轮循环都是一次完整的模型推理在烧 token。盲跑的后果是「晚点才知道」，卡死的后果是「完全不可用」。前者可以接受。

#### yan wait 看三个 source

只看 signal 不够，因为 agent 会死、会卡、会忘记报告—一个卡死的 shift 会让你干等到超时。这三条直接移植 firstmate 的教训：

| source | 抓什么 | 成本 |
| --- | --- | --- |
| `run/signal` | shift 主动报告 | 文件存在检查 |
| `term_agent_alive` | agent 死了—它不可能自己报告这件事 | 一次终端查询 |
| pane 内容 hash 长时间不变 | agent 停下来但没报告—卡住、等确认对话框、忘了 report | `term_read` + `md5` |

第三条成本极低、价值最高，因为「忘记报告」是 agent 最常见的失败模式。yan 不需要 firstmate 的第四个 source（PR 轮询），因为 shift 下工不等 CI（§5.3）。

#### wake 插入时的规则

hook 用 exit 2 唤醒模型时，user 可能正在跟 yan 聊别的，shift 的通知会插进当前话题。这是想要的行为，但 `AGENTS.md` 必须有一条：

> 收到 shift 通知时先处理它，再回到 user 当前的话题。不能因为正在聊别的就丢掉或拖延。

否则会出现「shift 报了 blocked，但 yan 当时在讨论方案，就忘了」这种失败。

顺带一个 per-task 设计的收益：因为一个 yan 只管一个 task，user「聊别的」通常也在这个 task 范围内，所以 wake 插进来天然不跑题。firstmate 那种全局主 agent 会在你聊 t051 时插进 t042 的 blocked，那才叫割裂。

#### 成本、缺口、以及砍掉了什么

多小时任务的成本接近零。 `yan wait` 单次寿命有界（30 分钟起），一个 3 小时的 shift 会有 6 次无事退出；wait 无事退出 → hook 跟着 exit 0（不是 exit 2），模型根本不被唤醒。「进程寿命有界、覆盖无界」靠的是 hook 每次 Stop 都重新触发；但如果模型一直没有新 turn，hook 也不会重新触发—这就是为什么单次寿命要设够长，以及为什么 guard 要检查 beacon 新鲜度（它是「autoarm 静默失效」的唯一探测手段）。

一个明确接受的缺口：所有 shift 下工之后、对外 MR 的 CI 在跑时，没有任何 agent 在工作，三个 source 都没东西可等。0→1 的答案是 yan 结束 turn，不等 CI，结论在 user 下次开 yan 时由 reconcile 查 GitLab 得到。代价是 CI 红了不会主动通知你。想要主动通知就加第四个 source（轮询 GitLab）—机制现成，排到 1→2。

砍掉的部分：firstmate 那 20 个文件不是花在管道上（管道就是上面这三个 hook），而是花在一层独立的 triage 上—吸收无害唤醒、「可证明在工作」判据、wedge 计时器、连续升级计数、demand-deep-inspection 标记、busy-turn 上界。yan 的 triage 就是那三个 source，长在 `yan wait` 里，不是单独一层。它能这么瘦，是因为它膨胀的原因我们都没有：多 backend 的忙碌判据、no-mistakes 的 run-step 归属校验、多 home 冲突、procevent、X-mode。

同样砍掉的还有：primary scope 判断（验 marker、比 git dir 和 git common dir—一个 yan 一个 task，没有 agent 树）、六个 harness 各一份适配（只 Claude，§5.6）、hook payload 解析（不读 stdin）。

两个都很小。guard 尤其小，因为它不读 stdin、不依赖 `jq`、也没有 firstmate 那两个 fail-open 分支。

### 5.6 harness 要求

**yan 锁 Claude Code。Codex 及其他 harness 明确 out of scope。**

这是权衡后的决定。走 harness 无关的路要么付 send-keys 注入的代价（聊天记录里出现假装 user 打的字、composer 竞态、pane 静止判据），要么付有界前台 checkpoint 的代价（插话要按 Esc、每小时几千 token 的往返）。firstmate 那套 hook 方案比两者都干净，值得为它锁定一个 harness。

但这个锁定只针对 yan。shift 可以是任何 agent CLI。 shift 对 harness 的全部要求：

1. 启动时能接受一个初始 prompt（去读 brief）
2. 能在 pane 里跑
3. 能执行 shell 命令（调 `yan report`、git、跑测试）
4. 能接收 `tmux send-keys` 的文字输入（接受 steer）

没有 hook 要求，没有 background 要求。 Codex、Kimi Code、公司私域的 CLI 都满足。而 shift 才是烧 token 的大头（它在真正写代码），yan 只是编排—所以便宜模型、开源模型、私域模型的价值在 shift 这一层能完整吃到，yan 锁 Claude Code 是笔划算的交易。

跟 Herdr 不冲突：Herdr 是多路复用器（backend），Claude Code 是 harness。那三个 hook 是 Claude Code 自己的生命周期钩子，跟外面是 tmux 还是 Herdr 无关。两者是不同的轴。

### 5.7 终端拓扑

**一个 task 一个终端容器。** 0→1 用 tmux，未来换 Herdr—两者的层级概念一一对应，所以现在选对拓扑，将来迁移只换 CLI 调用，不动数据模型。

| 概念 | tmux | Herdr |
| --- | --- | --- |
| task 容器 | session | workspace |
| 一个 agent | window | tab |
| 终端 | pane | pane |

```
session / workspace "t042 统一鉴权"
├── yan          ← 主 agent
├── s3-auth      ← shift
└── s4-gateway   ← shift
```

`tmux ls` 直接就是 task 列表，切 session 就是切 task。yan 和它派的 shift 同处一个容器—外层只看到 task，切进去才看到具体 agent。这不需要任何额外机制：`yan start t042` 建容器并在里面起 yan，之后 yan 派 shift 就是在自己所在的容器里加一个 window。这正是 firstmate 的扁平默认路径。

firstmate 那个可选的 `herdr-presentation-spaces`（每个 crewmate 一个一次性 workspace）不要抄—它背着一整套安全边界，光「Herdr 0.7.5 的 explicit close 会偷焦点」就要一整套 focus-safe emptying-close 方案（验证 close 会清空 → 把将死的 workspace 移到焦点后面 → 证明 pane 里只剩空闲 shell → 结束那个 shell 走 pane-death 路径 → 确认移除 → 失败回滚），而它自己承认 *Grouping is best-effort*。那份代价的根源是「workspace 的生命周期要自动推导」，而 yan 没有这个问题：容器的生命周期 = yan 的生命周期 = user 手动开关。

#### 从 firstmate 的 Herdr 实践里直接继承的三条

1. **label 不是权威，记 id。** Herdr 不强制 workspace/tab 标签唯一（原话：*a label can never decide where a worker goes*）。所以 `run/meta.json` 记的是 id（tmux `$0` / `@3`，Herdr `workspace_id` / `tab_id` / `pane_id`），不靠名字找。这跟 §6.6「不解析分支名，靠存储」是同一条原则。
2. **close 要精确。** 只关自己记录的那个 window/pane，永不关 session/workspace（原话：*Cleanup closes only the exact recorded task pane and never calls `workspace close`*）。
3. **不偷焦点。** tmux 用 `-d`，Herdr 用 `--no-focus`。

#### herdr-readiness 的正确形态

不做 backend 抽象层（那是 firstmate 支持 5 种 backend 的产物）。做的只是内聚：把所有终端操作收在 `bin/lib-term.sh` 一个文件里，七个函数—

```
term_container_create   建 task 容器
term_agent_start        在容器里起一个 agent（或进程），返回 id
term_send               发文字 + Enter
term_read               读 pane 内容
term_agent_alive        判断 agent 活不活
term_agent_close        精确关掉一个记录过的 agent
term_list               列出容器里的 agent
```

0→1 只有 tmux 实现。加 Herdr 就是写第二份实现加一个 `conf/backend` 开关—不是插件框架，只是别把 `tmux` 命令撒到十五个脚本里。

`term_agent_alive` 是这个接缝最值钱的地方：tmux 下只能靠猜进程名（firstmate 连 Pi 跑在通用解释器里都认不出来），Herdr 有原生 agent registration，能干净区分「pane 在但 agent 死了」/「pane 没了」/「活着」。

---

## 6. 分支模型

### 6.1 两级结构

```
target (master / release/x / 任意分支)
 └─ 集成分支（当前这一轮的 working 分支）———→ 对外 MR —→ target
      ├─ 子分支 s1  → MR → 合回集成分支 → shift s1 下工
      ├─ 子分支 s2  → MR → 合回集成分支 → shift s2 下工
      └─ 子分支 s3  ...（可并发，各自一棵 worktree）
```

这个结构一次解决三件事：shift 的生命周期有了客观的绑定物（子分支合了就下工）、多 agent 并发有了隔离（各自的子分支加各自的树）、前进有了载体（新 shift 从集成分支当前 head 切出）。

注意集成分支只代表当前这一轮—它会被整个替换，见 §6.3。所以「在同一轮里继续改」跟「上一轮已经交付或废弃了」是两种不同的机制，别当成一回事。

### 6.2 两级分支 = 两级 review

这是结构自带的，不是额外加的：

| MR | 合到 | 谁 review | 性质 |
| --- | --- | --- | --- |
| 子分支 → 集成分支 | user 自己 own 的分支 | user + CI，不需要同事 | 内部验收关口 |
| 集成分支 → target | target | 同事正式评审 | 对外交付 |

同事只看到一个 MR，不会被噪音淹。

### 6.3 集成分支怎么变

三种「往前」加一种「换赛道」：

| 变化 | 谁做 | 记在哪 |
| --- | --- | --- |
| 吸收子分支 | shift 的 MR | git merge history |
| 同步 target | `yan sync` | git |
| target 变更 | `yan unit set --target`（需 user 明说） | `unit.target` 字段 |
| 换掉整个集成分支 | `yan unit set --branch`（需 user 明说） | `unit.branch` 字段 + 旧的进 `history[]` |

「同步 target」绝不能交给子分支的 agent—它只看得见自己那点改动，让它 rebase 整个集成分支是灾难。`yan sync` 是脚本动作，不是 shift: 租树 → fetch → rebase/merge target → push → 还树，不需要 agent，只有产生冲突时才派一个 shift 去解。时机固定：每次开新 shift 之前先 sync，新子分支从同步后的 head 切。这样冲突集中在「集成分支 ← target」一处，不会散到每个子分支里各解一遍。

最后那一种是这个模型里最容易被漏掉的：集成分支不是长命的。 真实工作方式是 okt 拉一个 `2.0.1`，改完、上线、合进 master，然后收到反馈，再拉一个 `2.0.2`。所以 unit 的集成分支会整个被替换，而不是一直往前推。

由此「要改」有三种形态，机制完全不同：

|  | 上一轮的结局 | 怎么办 | 新分支的 base |
| --- | --- | --- | --- |
| 同一轮内 | 集成分支还没合进 target | 派新 shift，从当前集成分支切子分支，合回去 | 当前集成分支 |
| 交付后收到反馈 | 已合进 target、关闭了 | 换赛道：okt 拉 `2.0.2` | target（已含上一轮） |
| 废弃 | 因为某些原因不用了，没合 | 同样换赛道，但标记为废弃 | 旧分支本身（活不丢） |

后两种都是 `yan unit set --branch <新分支>`，区别只在 history 里怎么记。

`target` 变更也不是纯记账：从 `release/x` 换成 `master`，集成分支要 rebase 到新 target，可能一堆冲突，可能需要派 shift。

### 6.4 unit 的结构：当前是标量，历史是 append-only

```json
{ name: auth, repo: monorepo-x, scope: [apps/auth], needs: [proto],

  branch: 2.0.4,  target: master,  mode: mr,
  mr: https://gitlab.../merge_requests/88,

  history: [
    { branch: 2.0.1, target: master, at: 2026-08-20,
      end: delivered, mr: https://gitlab.../merge_requests/31 },
    { branch: 2.0.3, target: master, at: 2026-08-25,
      end: abandoned }
  ] }
```

当前状态是四个可变标量（branch / target / mode / mr），因为 yan 唯一的操作性需求就是「派新 shift 时从哪个分支切」—那只需要一个字符串。`mr` 是当前轮开出的对外 MR，`yan mr` 开的时候写上。

`history[]` 是 append-only 的历史，写进去就再也不动。跟当前分开而不是「当前就是数组最后一项」，因为当前要频繁读，而且 append-only 的语义更干脆。

每项最多五个字段，各有理由：

| 字段 | 为什么存 |
| --- | --- |
| `branch` | 核心—哪个分支用过 |
| `target` | 往哪合过。可能跟当前不同（`2.0.1` 合 release，后来改成合 master） |
| `at` | 退役时间。「什么时候开始用下一个」=「这个什么时候退役」，一个时间点够 |
| `end` | delivered 还是 abandoned。没有它，history 里躺着一串分支，你看不出哪个真上线了、哪个是半路扔掉的 |
| `mr`（可选） | 唯一查起来麻烦的：分支删了之后要 `glab mr list --source-branch` 才找得到，同一分支开过多个 MR 还有歧义。而 URL 是不变的事实，存它不违反判据（§2）。废弃的轮次可能压根没开过 MR，所以这个字段可选 |

用 `end: "delivered" | "abandoned"` 而不是 `"abandoned": true`—读的时候一眼就懂，不靠「缺省即交付」这种约定。

不存的三样：`why`（叙事，`log.md` 有）、`base`（`git log` 看得出新分支含不含旧分支的 commit）、历史轮次的 `mode`（没人会查）。

`end` 由 yan 自己判断，不需要额外的 flag—换分支时查一下当前 `mr` 在 GitLab 上的状态：

| GitLab 上的状态 | 判定 |
| --- | --- |
| merged | `delivered` |
| closed，或 `mr` 字段本来就是空的 | `abandoned` |
| 还 open | 这轮还没结束，先问 user：是要废弃它，还是搞错了 |
| 查不到（离线、MR 被删） | 问 user |

这符合「会变的状态查 GitLab」的判据。但判断结果必须写进 history—写完之后就不再查 GitLab 了，历史要自解释。

换赛道是一个原子操作：判定 `end` → 把当前 `branch`/`target`/`mr` 打包追加进 `history[]`（带 `at`）→ 覆盖当前字段 → `log.md` 记一行。

废弃的那一行 `log` 必须写清原因。 正常轮换的原因摆在那儿（上线了、有反馈）；废弃的原因才是最容易忘的—半年后看到 `2.0.3` 断在那儿，你会想不起来当初为什么扔掉它。

```
- 08-25  auth  废弃 2.0.3 → 2.0.4（基于 2.0.3; 上游 proto 改了接口，这条线的 MR 没法 review 了）
```

`target` 没有默认值，`yan unit add` 必须显式给—user 的实际工作方式是大项目期团队短期维护一个分支大家往里合，平稳期各自往 master 合，没有一个安全的默认。

`needs` 是落地顺序，`yan land` 按它拓扑排序。同一个 repo 可以在 units 里出现多次—team 的 monorepo 子应用各改各的，不能用同一个分支改两个应用，所以一个 unit = 一个子应用 = 一个分支 = 一棵树。

### 6.5 两级分支有两个不同的命名权威

集成分支的命名可以委托给外部权威（okt）；子分支的命名权永远归 yan。

理由：okt 认识团队的概念（feature、app、release），完全不认识 shift。让它命名子分支没有意义，而且有害。子分支不能从集成分支名派生（例如 okt 给了 `feature/AUTH-123`，我们造 `feature/AUTH-123/s1`），四个理由：

1. 团队 CI 常按分支前缀触发，每个 shift 都会白烧一次昂贵 CI
2. 分支保护和规范检查可能对团队前缀有要求，内部分支会撞上
3. 同事在 GitLab 上看分支列表会被内部分支淹没
4. okt 可能扫描/管理它认识的前缀，yan 的内部分支不该被它看见

外加一个 git 硬约束：`refs/heads/feature/AUTH-123` 已经是文件，`feature/AUTH-123/s1` 根本建不出来（`cannot lock ref ... exists`）。

```
集成分支    由 hook 命名；无 hook 时默认 yan/<task>-<unit>-r<n>
            例：2.0.2（okt 给的）   或   yan/t042-auth-r2（内置默认）
子分支      永远由 yan 命名，固定格式，不派生自集成分支
            yan/<task>-<unit>-<sid>        例：yan/t042-auth-s7
```

内置默认必须带轮次号 `r<n>`，因为集成分支会被替换（§6.3）—不带的话第二轮会跟第一轮撞名，同一个分支名建不出来第二次。

`n` = `history[]` 的长度 + 1，不需要额外存：轮次号本来就是历史记了几笔。有 hook 时 okt 给什么就是什么（`2.0.2` 自带版本语义），轮次号不参与。

子分支不带轮次号。 `sid` 是全局递增的（s1、s2、s3…），第二轮的 `s7` 天然不会跟第一轮的 `s3` 撞；而且 §6.6 定了 yan 不解析分支名、归属查存储，所以子分支名不需要表达它属于哪一轮。

`yan/t042-auth-r2` 和 `yan/t042-auth-s7` 是同级的两个文件名，永不冲突—所以不需要 `/trunk` 之类的后缀。

### 6.6 yan 永不解析分支名

因为集成分支的命名可能由 okt 接管，yan 不能假设它有任何结构：不靠前缀 glob 推断归属，而是 `task.json` 存 `unit.branch`、`run/meta.json` 存 shift 的子分支名。反向查询（「这分支是谁的」）查存储，不拆字符串。

例外：`git branch --list 'yan/*'` 可以用来找出所有 yan 造的分支做运维清理。那是「枚举自己的东西」，不是「从名字推断归属」，不违反这条。

### 6.7 unit 粒度的判据

集成分支合到 target 时，那个 MR 的 diff 是所有 shift 的总和。shift 攒多了同事 review 不下去。这个成本反过来给了 unit 粒度一个明确标准：

> 一个 unit 的粒度 = 一个对外 MR 的粒度 = 同事一次 review 能吃下的量。

攒到 review 不下去，说明该拆成两个 unit（两个集成分支、两个对外 MR）。

---

## 7. worktree

**池是 yan 自带的：`yan tree get | return | status`。** 不是独立二进制，不依赖任何外部工具。

原稿写的是 user 自己的 wtpool，它是另一台机器上未发布的 CLI，所以整节改成内置。
也不包 treehouse，理由不是「零状态文件」那种设计取向，而是**分支模型对不上**，
以及落地判据的口径对不上：

1. 分支模型：treehouse 恒定 detached HEAD，把「不碰分支名」当卖点；而 yan 的子分支要从
   集成分支切出、要 push、要开 MR（§6.1、§6.5），树上必须有真实分支。
2. 落地判据的口径：它判定一棵树能不能还的条件是「HEAD 已并入 default branch」，而 yan
   的子分支合回的是集成分支，永远不是 default branch——于是每一次正常下工的还树都会被它
   拒绝，得长期带 `--force`，而 §9.2 明确把 `--force` 列成禁止动作。

把最后一道防线变成日常动作，这个代价我不接受。

零状态那条得公道说一句——**这是三条理由里最弱的一条**：treehouse 需要状态文件，是因为
它要表达「没有活进程但树仍被占用」这个语义，这个语义不可推导，必须存；而 yan 两种都要——
shift 干活期间树里一直有活进程，进程扫描就够，但 `yan sync` 是无进程的短租（下面「隔离
粒度」那条：集成分支不常驻任何树，临时租、用完就还），那段时间只能靠 lease 表达占用。
所以零状态不构成拒绝理由，只是设计取向的差异。

内置之后，接口直接按 yan 的模型定，不需要在租到的树里补做分支这一层：

- **分支感知**：`yan tree get --base <集成分支> --branch <子分支>` 一步到位
- **绑定方式**：holder = `<task>/<unit>/<sid>`。`yan tree status` 直接显示归属，池本身就是运行时注册表
- **租约身份**：每次 acquire 生成一个随机 `lease_id`（抄 treehouse）
- **条件还树**：`return --if-lease-id` / `--if-lease-holder`，持锁比对，不匹配就在任何破坏性动作之前非零退出——不杀进程、不重置、不清状态。这对自动重试是安全的
- **`--json` 输出**：`get` 回 `{path, lease_id, holder}`，`status` 回数组
- **隔离粒度**：一个 shift 一棵树。集成分支不常驻任何树，`yan sync` 临时租、用完就还
- **池占用**：= 当前活着的 shift 数，跟 task 数无关
- **热复用**：还树 = `reset --hard` + `clean -fd`，永不带 `-x`。`-x` 会连 gitignore 的东西一起删，那一个字母就是「秒级复用」和「每次冷装」的分界线
- **背压**：池满时 `get` 自己失败，不再撑新树。这条和上一条是配套的——满了就新建的话池会慢慢长胖，多出来的全是冷树，等于没池

`lease_id` 和条件还树不是可选项。它们解决的正是 §5.5 里 guard 做「身份匹配」的同一类
问题：只认 holder 标签的话，一个重试的、或者上一轮遗留的调用，可能还掉别人刚租到的树。
监督层已经认真处理过一次陈旧身份的坑，池层不该还是裸的。

还有一条跟池配套的硬不变量：**spawn 必须断言 sub-agent 的 cwd 不等于主 clone 路径，否则拒绝启动。**

### 热复用是硬契约，不是优化

没有复用需求的话，一 shift 一次 `git worktree add`、下工 `remove` 就够了，
根本不需要池、租约、背压这一整套。**池多出来的复杂度全部是为了这一件事：
大 monorepo 上常驻 3 棵热树，租到哪一棵都不需要冷装依赖。**

所以下面这条是 `lib-pool` 的契约，不是实现细节：

> **还树用 `git clean -fd`，永远不加 `-x`。** gitignore 的依赖和构建缓存跨 shift 保留。

一个诚实的边界：它消掉的是**冷装**，不是所有 install。集成分支之间 lockfile 变了，
热树里的 `node_modules` 就是旧的。正确的处理是 brief 里每次都跑一遍 install——
热的时候几秒内 no-op，变了的时候增量装。不要试图聪明地跳过。

由此 0→1 **不需要** treehouse 那种 `post_create` provision hook：brief 本来就会跑 install，
冷树和热树走同一条路径就都覆盖了，不用多加一层机制。首次撑开 N 棵新树要装 N 次，
是一次性成本，知道就行。

### 池最多几棵树

**per-repo 配置，写在 `repos.json` 里，默认 8。** 不是一个全局常量。

这个数直接决定了同一个仓库上的最大并发 shift 数，跟 task 数无关（见上面「池占用」那条）。
所以它不是实现细节，是一个真实的决策。

它是磁盘和并行度的权衡。默认给到 8，是因为并行度的上限不该由工具来替你设——
池满是个准确的信号，真撞上了你自己会知道。需要往下调的信号有两个，都跟 monorepo 有关：

1. **磁盘。** 一棵树的 `node_modules` 就可能好几个 G，8 棵是几十个 G。
2. **树越多，热复用越弱。** 每棵树被用到的频率下降，更容易在某次 lockfile 变动之后变凉。
   池小反而更热——这和「多开几棵总没坏处」的直觉是反的。

所以巨型 monorepo 上把它调到 2 或 3 是完全合理的，而这正是它必须跟着 repo 走的原因。

**一个连带的坑**：`yan sync` 也要短租一棵树。如果池满了，`sync` 会失败——
而它恰好发生在 `yan shift new` 的第一步。这不是死锁（池满时本来就不该再开 shift），
但错误信息必须说「池满，开不了新 shift」，而不是「sync 失败」，
否则你会去查一个根本不存在的同步问题。

### 还树安全吗：只问「毁掉这棵树会不会丢东西」

还树 = `reset --hard` + `clean -fd`，会销毁树里的东西，所以只需回答这一个问题。

| 情况 | 树外有副本? |
| --- | --- |
| 改了没 commit | ✗ 还树就永久没了 |
| commit 了没 push | ✗ 孤立 commit 守卫就是拦这个 |
| 已 push（MR 都还没开） | ✓ 副本在远端上，够了 |
| 子分支已合回集成分支 | ✓ 这是 shift 的下工条件 |

「有副本」和「已落地」是两个不同强度的判据：前者管「树能不能还」，后者管「task 能不能宣布完成」。firstmate 把它们揉进同一个 `work_is_landed()`（因为它的 crewmate 活到落地为止），yan 拆开了，所以还树只需要那个更弱的判据，两行就能查完：

```sh
git -C "$tree" status --porcelain         # 非空 → 有未提交改动 → 没副本
git -C "$tree" branch -r --contains HEAD  # 空   → 没有远端分支包含 HEAD → 没副本
```

不用处理 firstmate 那些「squash merge 后分支被删、要去 `refs/pull/<n>/head` 捞」的情形—那是落地判断才需要的复杂度。

`yan tree return --force` 是禁止的，除非 user 明说这些改动可以丢。孤立 commit 守卫是最后一道防线：它拒绝还树的时候，正是「工作只在树里」的时候。拒绝是停下来查，不是加 `--force` 绕过。

### 下工的动作顺序必须钉死：还树在前，删分支在后

> **MR 合了 → 写 `outcome.md` → `rm -rf run/` → 还树 → 删远端子分支 → shift 结束**

顺序反了的话，squash 会把上面那个副本判据搞坏。如果内部 MR 是 squash 合的，
集成分支里没有子分支那个 HEAD；这时候先删远端子分支，`branch -r --contains HEAD`
就变成空—判据说「没副本」，树还不回去了，而活其实早就落了。

还树在前、删分支在后，还树时远端子分支必然还在，副本判据必然成立；删在最后，
那时活已经在集成分支里。**这样 yan 完全不用管团队把内部 MR 设成了 merge 还是 squash**——
那个设置在公司仓库里可能根本不由我们决定。

---

## 8. 交付模式

### 8.1 两个正交的轴

firstmate 那三种模式（no-mistakes / direct-PR / local-only）不是权限等级，是「做到哪一步就停」；合并权限在它那里是另一个正交维度。yan 显式分开：轴 1 · mode 管干到哪一步停下来，轴 2 · authority 管谁能按 merge（§9.2）。

### 8.2 三种 mode

| mode | 改代码 | commit | push | 开 MR | 交付物 | 终态 |
| --- | --- | --- | --- | --- | --- | --- |
| scout | × | ✓（scratch） | × | × | `report.md` + `artifacts/` | `done: report` |
| branch | ✓ | ✓ | × | × | 本地干净分支 | `done: branch <name>` |
| mr | ✓ | ✓ | ✓ | ✓ | GitLab MR | `done: mr <url>` |

层级：`kind: scout | ship` 是 task 级（交付物类型不同）；`mode: branch | mr` 是 unit 级（不同 repo 的交付姿态不同）。per-repo 默认写在 `repos.json`，per-unit 覆盖写在 `task.json`。

`scout` 的树是「声明为可丢弃的 scratch」（抄 firstmate）：允许随便脏、随便 commit（跑复现、试探性改动都需要），但不许 push、不许落地，report 写完整棵树直接丢。比「禁止改任何东西」实用得多。

默认 mode 是 `mr` 而不是 `branch`，因为 push 到远端就是最好的备份。`branch` 只在「这个仓库不能随便推分支」时才用（分支保护、命名规范、推一次触发昂贵 CI）。

`mode` 管的是集成分支的对外交付方式；子分支那一级恒定走「MR 合回集成分支」。

### 8.3 强制手段

0→1 不花预算做隔离机制，用启动参数就够：

| 目标 | 手段 |
| --- | --- |
| 不乱改 + 省上下文 | cwd 设成 scope 主路径，其余 scope 用 `--add-dir` 加进来。agent 的世界就是那几个目录 |
| `scout` 不改代码 | plan mode（其他 harness 对应只读 sandbox） |
| `branch` 不许 push | 只在 `brief` 里写一句 |

最后一条的理由：GitLab 服务端的分支保护本身就是最后一道防线。 误推一个分支是廉价可逆的（删掉就行），真正严重的情况服务端会直接拒。客户端 hook 只是锦上添花。

具体 flag 以各 harness 当时的 `--help` 为准，spawn 脚本里维护一张小映射表（harness → 设 cwd / 加目录 / 只读模式），别做抽象层。

保留一条最便宜的校验：`yan scope-check <id>` 用 `git diff --name-only` 加前缀匹配，在 land 之前跑一次。它不约束 agent 干活，只在落地前报告越界。语义是「越界必须显式扩，不是禁止」：

> 改 `apps/auth` 时发现必须动 `apps/common` 的一个类型—这在真实工作里天天发生。硬拒绝会让 agent 卡死或者偷偷绕过。规则是改 `task.json` 扩 scope，并在 `log.md` 记一行。

这样既挡掉乱改，又能看到范围是怎么长大的—scope 频繁膨胀本身就是「任务拆错了」的信号。

`sparse-checkout` 归档：它需要先解决「编辑范围 ≠ 构建闭包」（monorepo 里 `apps/auth` 编译通常需要 sibling 包在场），成本高，等上下文真的疼再做。

### 8.4 forge 层：`lib-forge.sh`

**GitLab 和 GitHub 都支持**，因为两个都是真实需求：工作用 GitLab，日常用 GitHub。
附带一个不小的收益：支持 GitHub 之后，0→1 的验收标准可以在 yan 自己身上跑通。

判据用 Ousterhout 的 deep module：接口窄、实现厚。这层符合——对外四个动词，
底下藏着两个 CLI 的参数形状、术语（MR / PR）、JSON 形状、鉴权、CI 模型五处差异。

```
forge_mr_create      开 MR / PR，回 URL
forge_mr_state       merged | closed | open | unknown
forge_mr_merge       合
forge_ci_state       green | red | pending | none
```

**要防的是它退化成 shallow module**：每个函数都是 `glab` / `gh` 的一行透传，
返回值原封不动漏出去，调用方还是得知道自己在跟谁说话——那就是 pass-through method，
是 deep 的反面。我能想到的避法只有一条：接口用 yan 自己的词汇定义，不是两个 forge 的并集。

三条具体约束：

1. **返回值是 yan 的封闭集合。** `forge_mr_state` 的四个值不是随便挑的—
   它们正是 §6.4 判定 `end` 需要的那四种情况，一一对应。不要漏第五种。
2. **CI 只回答绿红。** GitLab 是一条 pipeline 一个状态，GitHub 是 N 个独立 check run
   加 legacy status，「哪个 job 挂了」两边不对称，硬要统一就会漏。而 §5.3 需要的
   只是「CI 红了 → 派新 shift 修」。要看细节是 shift 的事——shift 可以知道自己在
   哪个 forge 上，因为它是在读，不是在做决定。
3. **归属放 `repos.json` 的 per-repo 字段，不是全局开关。** 一个 task 完全可能同时
   动公司 GitLab 的 monorepo 和 GitHub 上的个人仓库，所以按仓库分派，不按 session。

鉴权不统一。 `gh` 和 `glab` 各自管自己的登录，这一层不试图抹平—bootstrap 检查两个
CLI 是否都已认证，缺哪个就明确报哪个。自建 GitLab 实例还需要 `glab auth login --hostname`。

这不是 §11「明确不做」里禁的 backend 抽象层。那条禁的是插件框架，而这里和 §5.7 的
`lib-term.sh` 是同一个形状：**内聚成一个文件里的几个函数，不是框架。**

---

## 9. yan 的可写范围

### 9.1 文件系统

yan 写的只有自己的记账层：`task.json`、`log.md`、各级 `brief.md`、`run/meta.json`、`mem/learnings/`、`mem/repos.json`。

yan 不写的有四类：`repos/` 主 clone（唯一允许的写是 `git fetch`，永不 checkout、永不改工作区、永不 commit）、shift 自己写的 `status` / `outcome.md` / `artifacts/`、user 的本地选择 `conf/`、以及 yan 自己的 `bin/` 和 `AGENTS.md`（运行时不自改）。其他 task 的目录也不读（§5.2）。

逐条清单见 附录 B。

### 9.2 外部副作用—真正需要边界的部分

| 动作 | 谁做 | 授权 |
| --- | --- | --- |
| `yan tree get / return`（不带 force） | yan、shift | 自主 |
| `yan tree return --force` | — | 禁止，除非 user 明说可丢 |
| 起 / 关终端 | yan | 自主 |
| push 子分支 | shift | 自主 |
| push 集成分支（`yan sync` 后） | yan | 自主 |
| `git push --force` 到任何地方 | — | 禁止 |
| 开子分支 MR（→ 集成分支） | shift | 自主 |
| 合子分支 MR（→ 集成分支） | yan | 自主（内部验收，user own 这个分支） |
| 开对外 MR（集成分支 → target） | yan | 自主（开 MR 可逆） |
| 合对外 MR（→ target） | yan | 必须 user 明说 |
| 删已合并的子分支 | yan | 自主。必须排在还树之后（§7） |
| 删未合并的任何分支 | — | 禁止 |
| `yan unit set`（改 branch / target / mode / scope） | yan | 必须 user 明说—改的全是决策 |
| MR 上留评论、@人 | — | 必须 user 明说，会打扰同事 |

> 在自己的分支和本机范围内 = 自主；一旦影响 target 或者同事会看见 = user 明说。

### 9.3 shift 的范围

shift 只写三处：自己 `shifts/<sid>/` 下的 status 和 outcome、`tasks/<id>/artifacts/`、以及它租来的那棵树里的代码。`mem/`、`task.json`、集成分支、主 clone 一律不碰。

反过来，yan 从不进 worktree 改代码。唯一进树的场合是 `yan sync`，那是脚本动作，有冲突就立刻退出交给 shift。这条让「谁改了什么」永远可归因。

---

## 10. 外部权威接缝（okt 等）

> 跟 §5.5 的 Claude Code hook 区分开：那是 harness 的生命周期钩子，这里是把「分支该叫什么名、能不能合」这类决策委托给外部权威的接缝。两者同名不同物。

user 的团队用 okt 管分支命名和可合并性。yan 的代码里不出现 `okt` 三个字母，通过一个 opt-in 接缝委托出去。

```
conf/hooks/
  branch-name      给集成分支起名（或直接建好它）
  merge-check      判断能不能合   ← 留位置，0→1 不实现
```

`conf/` 是 LOCAL、gitignored—这是这台机器、这个团队的选择，不是 yan 的一部分。

### branch-name 契约

只在集成分支上调用。 子分支永远由 yan 自己命名（§6.5）—okt 不认识 shift，让它命名没有意义。

输入 JSON 走 stdin（字段以后能加，不破坏已有 hook），输出一行分支名走 stdout。这个不对称是有意的。

```json
{ task: t042, task_title: 统一鉴权 header,
  unit: auth, repo: monorepo-x, target: master,
  scope: [apps/auth] }
```

hook 允许自己去创建/注册分支，只要最后在 stdout 打印分支名。yan 的逻辑因此能同时支持「okt 只给名字」和「okt 直接把分支建好了」两种用法：

```
name=$(hook branch-name <<< "$ctx") || die "分支命名被拒绝"
分支已存在（本地或远端）→ checkout 它
分支不存在            → 从 base 切一个
```

失败语义：hook 非零退出时 yan 停下来报错，绝不 fallback 到内置默认。否则 okt 拒绝之后 yan 会悄悄造出一个不合团队规范、可能根本合不进去的分支—那比直接失败糟糕得多。

**为什么是 hook 而不是内置**：分支名属于决策那一类，而决策可以由外部权威做。yan 的职责只是「把决策记下来，并且不假设它长什么样」。`merge-check` 以后接进来是同一个道理：「能不能合」是决策，okt 可以是决策者，yan 只负责执行和记录。

---

## 11. 0→1 范围

### 范围

一个 `yan` 入口加 20 个子命令、2 个 hook 脚本、8 个 lib（子命令和 hook 清单见 附录 C，8 个 lib 和怎么摆见 [`architecture.md`](architecture.md) §3、§5），外加 `AGENTS.md`。

两个决定让范围比原稿大了一点：内置 worktree 池（§7）和 forge 层支持两个远端（§8.4）。
其中池的分支感知、还树判据、孤立 commit 守卫本来就要写，真正多出来的只有复用池和 lease。
换回的是零外部依赖，以及 0→1 能在 yan 自己身上验收。

### 为什么比 firstmate 小得多

firstmate 有 109 个文件、19 个 skill。差距不是奇迹，就是「明确不做」那些决定的和：

| 它有而 yan 没有 | 说明 |
| --- | --- |
| watcher 与独立 triage 层 | 唤醒管道 1:1 照搬，省掉的是那层独立 triage（§5.5） |
| 多 backend（Herdr / zellij / orca / cmux / codex-app）加抽象层 | yan 以后只需 `lib-term.sh` 的第二份实现 |
| X mode 与 public-followup | 完全不做 |
| PR poll 注册与信任绑定 | shift 下工不等 CI，不需要 |
| secondmate 与配置继承 / AFK / no-mistakes 集成 | 一个 yan 一个 task，没有二级 agent 树 |
| install / lint / doc-check / treehouse | 池内置，其余不做 |

差距不只在数量上，也在每个文件的厚度上：firstmate 的每个脚本里都塞着多 backend 分支、
安全 journal、迁移路径。**yan 没有这些，不是因为写得更好，是因为它膨胀的原因我们一个都没有。**

### 关于 no-mistakes

不引入。 它在 firstmate 里承担「review + 补测试 + 补文档 + 修 CI」的自动化流水线，不引入的代价是质量把关落回 user + CI + 同事 review—这本来就是正常团队的做法。

一致性检查：yan 的 mode 体系里没有 no-mistakes 那一档，默认 `mr` 直接开 MR；CI 红了由 yan 查 GitLab 发现、派新 shift 修（§5.3），整条链路不依赖它。

**0→1 验收**：一句话需求 → 一个 unit → 一个 shift → 子分支 MR 合回集成分支 → shift 下工还树 → 对外 MR 开出 → user 说合 → 合掉 → `log.md` 完整记录了整条链路。

### 路线

| 阶段 | 加什么 |
| --- | --- |
| 0→1 | 上面这些。单 unit 单 shift 跑通 |
| 1→2 | 多 unit（跨 repo / 跨 monorepo 子应用）、`needs` 落地顺序、多 shift 并发、`yan wait` 加 GitLab 轮询作为第四个 source |
| 2→10 | Herdr（`lib-term.sh` 的第二份实现）、`scout` 交付物、卡死 shift 的恢复流程 |
| 10→100 | 按任务选 model/effort、`merge-check` hook、learnings 定期裁剪 |

Herdr 是确定要支持的，只是受时间所限先不做。它带来两样 tmux 给不了的东西：

1. 原生 per-pane agent 状态—`term_agent_alive` 从猜变成问（§5.7）。
2. push 事件（`pane.agent_status_changed`）—`yan wait` 的第三个 source（pane hash 不变 = 可能卡住）是个启发式；Herdr 的原生 `blocked` 状态是事实。轮询可以换成订阅一个 socket。

§5.7 把终端操作内聚成七个函数就是为了这一天：加 Herdr = 写第二份实现，不改数据模型。

### 明确不做

- yan 跑在 Claude Code 以外的 harness 上（§5.6）。Codex、Kimi Code 等只作为 shift 的 harness
- backend 抽象层 / 插件框架—Herdr 作为 `lib-term.sh` 的第二份实现进来，不需要框架
- 社交平台入口
- 跨 provider 配额路由
- 二级 agent 树（yan 不 spawn yan）
- 自己的质量流水线（firstmate 的 no-mistakes 位置）

这些是 firstmate 的具体处境，不是 yan 的。

---

## 12. 待定

全系统还没定的都在这里，包括代码结构上的那几个。

1. `$YAN_HOME` 要不要 git 版本化？ `mem/user.md` 和 `learnings/` 有提交历史挺有价值（能看到偏好怎么演化）。如果版本化，`tasks/` 要不要一起进去（会很吵）。倾向 `mem/` 进、`tasks/` 不进。不阻塞 0→1—随时能加，`git init` 一下的事。
2. `tasks/` 的裁剪策略：倾向不自动删任何东西，靠 `yan prune` 半手工裁，且 `artifacts/` 即使裁剪也单独保留。不阻塞 0→1，那时根本没有积累量。
3. `yan` 的 task id 格式：`t042` 这种纯序号，还是带语义的 slug？序号短但不可读，slug 可读但会跟 brief 标题重复。注意它会进分支名（§6.5 `yan/<task>-<unit>-<sid>`），所以短的有实际好处。倾向 `t042` 式序号，可读的标题住在 `brief.md` 和 `log.md` 的标题行。这条要在写 `yan task new` 之前定，见 [`implementation-plan.md`](implementation-plan.md) §4。
4. `lib-pool` 的池根目录要不要做成可配置？`~/.yan-trees/<repo>-<hash>/N/<repo>`（§3）是当前写法。

### 已定：子分支推到远端（原待定 5）

**定了：推。** 两级 MR 都保留，§5.3 / §6.1 / §9.2 维持当前写法。

理由不是当初那张利弊对照表里的任何一项，而是一件表里没有的事：**每个 shift 一个独立 MR，
就是 user review 的主要方式**—一个 shift 一个 shift 地看它相对集成分支的 diff，
本地基本不用看代码。这把 §6.2 的两级 review 从「结构自带的副产品」
变成了「要这个系统的原因之一」。

被明确接受的代价：服务器上会有一堆 `yan/*` 分支和一堆内部 MR。清理办法见 §5.3 和 §7
的下工顺序—合了就删，删排在还树之后。CI 的重复触发成本经 user 判断可以忽略，不做处理。

wtpool 的 `--help` 标签 bug 那条（原 §12 的第 4 项）随 §7 内置池一起消失。

---

# 附录

以下三节是查的时候才看的清单，不是读的时候看的。主线里的决策都指向这里。

## 附录 A · 记忆读写契约

| 记忆 | 谁写 | 何时写 | 谁读 | 何时读 |
| --- | --- | --- | --- | --- |
| `mem/user.md` | yan | 只在 user 明确要求时；重写式 | yan | 启动 |
| `mem/repos.json` | yan | 只经 `yan repo-add` | yan | 启动 + 要动 repo 时 |
| `mem/learnings/*.md` | yan | 拿到证据后；重写式，带日期，会过期就删 | yan | 按需，只读涉及的那几片 |
| `tasks/<id>/task.json` | yan | 创建、加 unit、`unit set`、宣布完成 | yan | 启动 |
| `tasks/<id>/brief.md` | yan | 创建时一次；修订要显式 | yan、shift | yan 启动；shift 出生 |
| `tasks/<id>/log.md` | yan | 每个 shift 结束、每次决策，追加一行 | yan、user | 启动；`cat` |
| `tasks/<id>/report.md` | shift | 收尾前 | yan、未来的 task | 任务收尾；同类问题 intake |
| `tasks/<id>/artifacts/` | shift | 随时 | user | 任务收尾后 |
| `shifts/<sid>/brief.md` | yan | spawn 前一次 | shift | 出生第一件事 |
| `shifts/<sid>/outcome.md` | shift（yan 兜底） | 下工前 | yan、下一个 shift | 开新 shift 时 |
| `run/meta.json` | spawn 脚本 | spawn 时 | yan | 启动，重建现实 |
| `run/status` | shift | 稀疏：只写需要 yan 动作的事件 | yan | 被唤醒时 |

授权差别的理由见 §4.1。

## 附录 B · yan 的文件系统边界

### 可写

| 路径 | 写什么 | 约束 |
| --- | --- | --- |
| `tasks/<id>/task.json` | 决策：units、scope、交付历史、完成标记 | 原子写 |
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
| `shifts/<sid>/run/status` | shift 写的事件流，yan 只读 |
| `shifts/<sid>/outcome.md` | shift 主写。只在 shift 异常死亡没写时 yan 才补写，并注明是补记 |
| `tasks/<id>/artifacts/` | shift 主写。yan 可整理（重命名、加索引），不改内容 |
| `mem/user.md` | 只在 user 明确要求时写 |
| `conf/`（含 `hooks/`） | user 的本地选择 |
| `bin/`、`AGENTS.md` | yan 自己的工具和职责说明，运行时不自改 |
| 其他 `tasks/*/` | 只管自己那个 task |

## 附录 C · 脚本清单

每个子命令的步骤、以及它各自持有的那条顺序不变量，见 [`architecture.md`](architecture.md) §5。

| 脚本 | 干什么 |
| --- | --- |
| `yan repo-add` | 注册一个 repo，clone 到 `repos/` |
| `yan task new` | 建 `tasks/<id>/`，写 brief |
| `yan unit add` | 加一个 unit（target 必须显式给），建集成分支 |
| `yan unit set` | 改 branch / target / mode / scope。换 branch 时判定 `end` 并归档（§6.4） |
| `yan start` | 建 task 的终端容器，在里面起 yan |
| `yan session-start` | 全量 reconcile，由 SessionStart hook 触发 |
| `yan tree` | 内置 worktree 池：`get` / `return` / `status`（§7） |
| `yan shift new` | 派一个 shift 出去（§5.3） |
| `yan send` | 单行消息发给 shift |
| `yan report` | shift 调用：append status + touch signal |
| `yan wait` | watcher 本体，由 autoarm 前台启动，盯三个 source（§5.5） |
| `yan drain` | 模型被唤醒后读 wake 文件 |
| `yan state` | 从 meta + 终端 + git + GitLab 现场推导当前状态 |
| `yan scope-check` | diff 越界校验 |
| `yan shift done` | 收一个 shift 回来。动作顺序见 §7 |
| `yan sync` | 集成分支跟上 target |
| `yan mr` | 开对外 MR |
| `yan land` | 合（需授权） |
| `yan ls` | 扫 `tasks/` 渲染队列 |
| `yan open` | 打开 task 目录 / artifacts |
| `hook-autoarm.sh` | asyncRewake Stop hook（§5.5） |
| `hook-turnend-guard.sh` | 阻塞式 Stop hook（§5.5） |
| `bin/lib-term.sh` | 终端操作内聚层（§5.7） |
| `bin/lib-forge.sh` | GitLab / GitHub 内聚层（§8.4） |
