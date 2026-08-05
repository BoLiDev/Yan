# 5. Agent 系统

## 5.1 寿命分层决定存储策略

| 寿命 | 谁 | 存储策略 |
| --- | --- | --- |
| 长 | task 及其资产 | 文件，持久，手工裁剪 |
| 中 | yan | 没有自己的状态文件 |
| 短 | shift / sub-agent | 易失文件，下工即删 |

中间那条是关键：yan 不该有任何持久运行状态。 每次启动就是一次全量 reconcile—扫 `tasks/`、查终端、查树池，现实是什么就是什么。这样「关掉重开一个」永远是非事件，不需要交接、不需要 resume。

这也让 task 的状态大部分不用存：「从没派过 shift」看 `shifts/` 是否为空、「有 shift 活着」扫 `run/` 加查终端、「没 shift 活着但没完成」是两者的补集—全部可推导。只有「已宣布完成」必须存，因为那是 user 的决定，不是事实。所以 `task.json` 里只需要一个完成标记，零状态漂移。

## 5.2 一个 yan = 一个 task

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

## 5.3 shift 的生命周期

- 出生：yan 写 `shifts/<sid>/brief.md` → `yan tree get --base <集成分支> --branch <子分支>` 租树（holder = `<task>/<unit>/<sid>`）→ 起终端 → 注入 `YAN_TASK_DIR`
- 干活：只在自己的树里；稀疏地往 run/status 追加需要 yan 动作的事件
- 下工：子分支的 MR 已合回集成分支 → 写 `outcome.md` → `rm -rf run/` → `yan tree return` → 删远端子分支

下工条件为什么是「MR 合回集成分支」：  合了就意味着改动已经在集成分支上（远端有副本），树里的东西没有独占价值，还树是安全的。这比「活干完了」更强、更可验证，而且完全客观。

**判断「合没合」查 MR 状态，不查 git 祖先关系。** 内部 MR 若是 squash 合的，集成分支不含子分支的 HEAD，祖先关系会说谎—但活确实已经落了。删分支同理。这和 [§6.6](branching.md#66-yan-永不解析分支名)「不解析分支名、归属查权威源」是同一条原则的延伸。

还树必须排在删远端子分支之前，理由见 [§7](worktree.md#7-worktree)。

不等对外 MR 的 CI。  这是有意的：只要 shift 挂在那儿等，就必须持续判断「它是在等还是卡了」—而那正是 firstmate `fm-crew-state.sh` 那五步推导（run-step 归属校验、head 祖先关系判断、status log 陈旧性反证、ci 步骤下「还在等检查」vs「检查绿了在等合并」的歧义消解）存在的唯一原因。为省一次重启把这整块复杂度请回来不划算。CI 红了由 yan 查 GitLab 发现，再派新 shift 修—轮询一个权威数据源比监督一个挂着的 agent 便宜一个数量级。

shift 从不横跨 task。  一个 shift 可以横跨同一个 task 的多个 unit（比如同时动 auth 和 gateway，一个 sub-agent 持两棵树），但那意味着两个子分支、两个 MR。

## 5.4 通信

| 方向 | 机制 | 约束 |
| --- | --- | --- |
| yan → shift（出生） | `brief.md` 文件 | 长契约只在这里，一次性 |
| yan → shift（运行中） | `yan send` 包 `term_send`，单行短消息 | 长指令写成文件只发路径。文字和 Enter 分开发，文字只打一次、只重试 Enter（firstmate 的教训） |
| shift → yan | `yan report <state> "<note>"` | 脚本同时 append `run/status` + touch `run/signal` |

为什么 `yan report` 必须是个脚本，而不是「brief 里要求 agent 做两件事」：别指望 agent 记得做两步。包成一个命令还能顺带校验 state 只属于那五个词、加时间戳、原子写。这是 shift 唯一需要调的 yan 命令（外加自查用的 `yan scope-check`）。

三条铁律：shift 之间不通信（需要协调的活由同一个 shift 持多棵树完成）；shift 从不直接对 user 说话（所有汇报走 status，由 yan 翻译成人话）；*`run/status` 的每一行是事件，不是当前状态*—这条必须一开始就分清，否则会重演 firstmate「`tail -1` 报的是最后一个事件而不是当前状态」那个坑。

### 确定性的推进不要唤醒模型

一个事件到达时先问：这件事需要判断吗？  不需要判断的，脚本直接做完，模型根本不必醒。

| 脚本自己做完 | 需要判断 → 唤醒模型 |
| --- | --- |
| shift 报 done，写 `log.md` 一行 | 合并有冲突 |
| 子分支无冲突合回集成分支 | shift 报 `blocked` / `needs-decision` |
| 某个 unit 的 `needs` 已满足、还没派过 shift → 派下一个 | shift 死了 / 卡了 |
|  | CI 红了怎么修 |

落地顺序已经在 `task.json` 的 `needs` 里声明了，所以「A 落了 → 派 B」是纯编排，不是判断。这类推进由 `yan report` 自己完成，链条不必在每个环节停下来等模型。

右边那些需要判断的，恰好也都是 user 该知情的事—「唤醒模型」和「值得打扰 user」这两条线基本重合。

## 5.5 监督

监督这一节自己就占了很大一块，所以单独成篇：见 [`supervision.md`](supervision.md)。
它要回答的是「shift 干完了或者卡住了，谁来叫醒 yan」。

## 5.6 harness 要求

**yan 锁 Claude Code。Codex 及其他 harness 明确 out of scope。**

这是权衡后的决定。走 harness 无关的路要么付 send-keys 注入的代价（聊天记录里出现假装 user 打的字、composer 竞态、pane 静止判据），要么付有界前台 checkpoint 的代价（插话要按 Esc、每小时几千 token 的往返）。firstmate 那套 hook 方案比两者都干净，值得为它锁定一个 harness。

但这个锁定只针对 yan。shift 可以是任何 agent CLI。 shift 对 harness 的全部要求：

1. 启动时能接受一个初始 prompt（去读 brief）
2. 能在 pane 里跑
3. 能执行 shell 命令（调 `yan report`、git、跑测试）
4. 能接收 `tmux send-keys` 的文字输入（接受 steer）

没有 hook 要求，没有 background 要求。 Codex、Kimi Code、公司私域的 CLI 都满足。而 shift 才是烧 token 的大头（它在真正写代码），yan 只是编排—所以便宜模型、开源模型、私域模型的价值在 shift 这一层能完整吃到，yan 锁 Claude Code 是笔划算的交易。

跟 Herdr 不冲突：Herdr 是多路复用器（backend），Claude Code 是 harness。那三个 hook 是 Claude Code 自己的生命周期钩子，跟外面是 tmux 还是 Herdr 无关。两者是不同的轴。

## 5.7 终端拓扑

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

### 从 firstmate 的 Herdr 实践里直接继承的三条

1. **label 不是权威，记 id。** Herdr 不强制 workspace/tab 标签唯一（原话：*a label can never decide where a worker goes*）。所以 `run/meta.json` 记的是 id（tmux `$0` / `@3`，Herdr `workspace_id` / `tab_id` / `pane_id`），不靠名字找。这跟 [§6.6](branching.md#66-yan-永不解析分支名)「不解析分支名，靠存储」是同一条原则。
2. **close 要精确。** 只关自己记录的那个 window/pane，永不关 session/workspace（原话：*Cleanup closes only the exact recorded task pane and never calls `workspace close`*）。
3. **不偷焦点。** tmux 用 `-d`，Herdr 用 `--no-focus`。

### herdr-readiness 的正确形态

不做 backend 抽象层，那是 firstmate 支持 5 种 backend 的产物。这里做的只是内聚：把所有终端操作都收在 `bin/lib-term.sh` 这一个文件里，一共七个函数——

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
