# 5.5 监督

监督机制 1:1 照搬 firstmate 的三个 hook（都注册在 `.claude/settings.json`），但不抄它的 triage 层。

| hook | 类型 | 干什么 |
| --- | --- | --- |
| SessionStart | nudge | 注入一句「先跑 `yan session-start`」 |
| Stop（autoarm） | `asyncRewake: true`，长 timeout | 拿单飞锁 → 在自己前台跑 `yan wait` → 翻译成 exit 0/2 |
| Stop（turnend guard） | 阻塞式 | 监督不健康就拦住结束 turn，有界后 fail open |

autoarm 负责起监督，guard 负责验证监督真的起来了。

`yan wait` 是 watcher 本体，由 autoarm 在前台启动；模型从不调用它—所以「模型忘了起监督」这个失败模式不存在。它的输出契约是给 hook 读的（退出码加一行 reason），不是给模型读的 stdout：有事就写 wake 文件、打印 reason、exit 0；无事就静默 exit 非 0。它同时是纯观察者，不持有任何状态：超时、被杀、随 hook 进程树死掉，都不丢任何东西—`shift` 还在自己的终端里，状态全在文件里。这是「重启是非事件」在监督层的体现。

SessionStart 是「重启即对接」的保障。这个能力本身来自 durable state 加全量 reconcile（[§5.1](agents.md#51-寿命分层)），不来自任何 hook—firstmate 的原话：

> A restart must be a non-event because durable state and live backend inventory, not conversation memory, are authoritative.

hook 的作用只是让它不依赖模型记得去做，启动就注入一条指令要求先 reconcile。firstmate 用的就是这个（`FIRSTMATE_OP: v1 session-start: Run bin/fm-session-start.sh now, exactly once, before executing any other instructions`）。

## 完整流程

```
user 说话 → yan 处理完 → 准备结束 turn
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

## 基础设施

|  | 为什么 |
| --- | --- |
| 单飞锁 | Claude 对 async hook 不去重，每次 Stop 都触发一次。没有锁就会起多个 watcher |
| wake 文件 | 唤醒原因必须从「watcher 退出」活到「模型下一个 turn」。exit 2 只带一行 banner 不够。firstmate 原话：*The durable wake queue preserves actionable events between a rewake and the next Stop-launched arm* |
| beacon | `yan wait` 每轮 touch 一个时间戳文件，因为 pid 活着 ≠ watcher 在工作 |

所以「watcher 健康」不是「进程还活着」，而是三件事同时成立：lock 存在且其中的 pid 活着、身份匹配（那个 pid 真是我们的 watcher，不是 pid 复用后的别人）、beacon 新鲜（默认 300 秒）。firstmate 两个方向都拦：*A stale beacon blocks even when a watcher pid is live; A fresh leftover beacon blocks when the lock is missing, dead, or identity-mismatched.*

autoarm 的关键结构是 `asyncRewake: true` 加一个很长的 timeout（firstmate 用 `timeout: 28800`，8 小时），让 hook 本身能活几小时；watcher 跑在 hook 的前台（绝不用 shell &），所以 harness 拥有进程组，超时或会话销毁时两者一起被杀。timeout 必须设长，否则 hook 被杀 watcher 就跟着死。

## guard 的设计要点

**一、它的价值在 autoarm 根本没跑的时候。** 如果 autoarm 跑了但失败了，它自己会留下失败记录。但如果它压根没被调用（`.claude/settings.json` 被改坏、hook 路径错了、harness 跳过了它），它连「失败」都不会留下—什么记录都没有，看起来跟一切正常一模一样。这时 guard 是唯一的探测手段。

> 这就是它必须是独立的第二个 hook—一个没跑的 hook 没法报告自己没跑。

**二、不能用 `stop_hook_active` 防死锁。** 一般 harness 靠它—含义是「这次 stop 紧跟在一次 hook 拦截之后」，读到 true 就放行，从而保证每个 turn 最多被拦一次。Claude 下这样做是错的，firstmate 的 `docs/turnend-guard.md` 原话：

> *Claude Code sets `stop_hook_active=true` on every stop after any stop-hook continuation, including `asyncRewake` rewakes, which re-opened the 2026-07-21 blind window under the default one-shot behavior.*

根源是两件完全不同的事共用了一个标志：guard 拦截的含义是「我刚拦过你，别再拦」（需要计数），autoarm rewake 的含义是「有事了，醒醒」（跟防死锁完全无关）。被 autoarm 唤醒的那个 turn，它的第一次 stop 就已经带 true 了—按本意该是 false，guard 从没拦过它。于是 guard 直接放行，而那个 turn 结束时恰恰需要起新 watcher。盲窗。这是踩过的实伤，不是理论风险。

所以自己数：计数写 `run/guard-failures`，watcher 恢复健康时清零，autoarm 的 rewake 碰不到它。两个额外收获：

- guard 完全不需要读 hook 的 stdin—它要的信息（有没有活、watcher 健康否、拦过几次、哪个 `task`）全在文件系统和 `YAN_TASK` 环境变量里。于是不依赖 `jq`，也没有 firstmate 那两个「jq 没装 / stdin 是空的」的 fail-open 分支。好测试，也不会被 harness 改 payload 悄悄搞坏。
- 语义更合适：`stop_hook_active` 是「每 turn 拦一次、无限期唠叨」；自己数是「整个故障期间拦 3 次，然后明确报警并闭嘴」。autoarm 的 rewake 会频繁产生新 turn，前者会很吵而且没用。

预算设 3，留在 Claude 自身那个 8 次上限以下（`fm-turnend-guard.sh` 注释：*below Claude's 8-block override*）—由我们自己决定何时放弃并打印有意义的警告，而不是被 harness 静默强行放行。

**三、用完预算必须 fail open。** 含义不是「算了不管了」，而是「进入盲跑，并且大声告诉 `user`」：`shift` 还在干活一切照旧，事件还在往 `run/status` 里写一条不丢，只是没人在盯—干完了不会有人叫 `user`。所以那次放行必须打印一句明确的话：自动监督坏了，从现在起得 `user` 自己看。那时的选择是自己 `yan ls` 看看，或者重启 `yan`（SessionStart 会 reconcile，往往顺手就恢复了）。

为什么不能一直拦：一直拦 = 整个 session 废掉，`user` 连话都说不上，而且每一轮循环都是一次完整的模型推理在烧 token。盲跑的后果是「晚点才知道」，卡死的后果是「完全不可用」。前者可以接受。

## `yan wait` 的 source

只看 signal 不够，因为 agent 会死、会卡、会忘记报告—一个卡死的 `shift` 会让 `user` 一直干等到超时。这三条直接移植 firstmate 的教训：

| source | 抓什么 | 成本 |
| --- | --- | --- |
| `run/signal` | `shift` 主动报告 | 文件存在检查 |
| `term_agent_alive` | agent 死了—它不可能自己报告这件事 | 一次终端查询 |
| pane 内容 hash 长时间不变 | agent 停下来但没报告—卡住、等确认对话框、忘了 report | `term_read` + `md5` |

第三条值得有，因为「忘记报告」是 agent 最常见的失败模式，而它要付的成本上表已经写了：一次 `term_read` 加一次 `md5`。`yan` 不需要 firstmate 的第四个 source（PR 轮询），因为 `shift` 下工不等 CI（[§5.3](agents.md#53-shift-的生命周期)）。

## wake 插入时的规则

hook 用 exit 2 唤醒模型时，`user` 可能正在跟 `yan` 聊别的，`shift` 的通知会插进当前话题。这是想要的行为，但 `AGENTS.md` 必须有一条：

> 收到 `shift` 通知时先处理它，再回到 `user` 当前的话题。不能因为正在聊别的就丢掉或拖延。

否则会出现「`shift` 报了 blocked，但 `yan` 当时在讨论方案，就忘了」这种失败。

顺带一个 per-task 设计的收益：因为一个 `yan` 只管一个 `task`，`user`「聊别的」通常也在这个 `task` 范围内，所以 wake 插进来天然不跑题。firstmate 那种全局主 agent 会在 `user` 聊 t051 时插进 t042 的 blocked，那才叫割裂。

## 成本、缺口、以及砍掉了什么

多小时的任务不会因此多烧 token。 `yan wait` 单次寿命有界（30 分钟起），一个 3 小时的 `shift` 会有 6 次无事退出；wait 无事退出 → hook 跟着 exit 0（不是 exit 2），模型根本不被唤醒。「进程寿命有界、覆盖无界」靠的是 hook 每次 Stop 都重新触发；但如果模型一直没有新 turn，hook 也不会重新触发—这就是为什么单次寿命要设够长，以及为什么 guard 要检查 beacon 新鲜度（它是「autoarm 静默失效」的唯一探测手段）。

一个明确接受的缺口：所有 `shift` 下工之后、对外 MR 的 CI 在跑时，没有任何 agent 在工作，三个 source 都没东西可等。0→1 的答案是 `yan` 结束 turn，不等 CI，结论在 `user` 下次开 `yan` 时由 reconcile 查 GitLab 得到。代价是 CI 红了不会主动通知 `user`。想要主动通知就加第四个 source（轮询 GitLab）—机制现成，排到 1→2。

砍掉的部分：firstmate 那 20 个文件不是花在管道上（管道就是上面这三个 hook），而是花在一层独立的 triage 上—吸收无害唤醒、「可证明在工作」判据、wedge 计时器、连续升级计数、demand-deep-inspection 标记、busy-turn 上界。`yan` 的 triage 就是那三个 source，长在 `yan wait` 里，不是单独一层。它能这么瘦，是因为它膨胀的原因我们都没有：多 backend 的忙碌判据、no-mistakes 的 run-step 归属校验、多 home 冲突、procevent、X-mode。

同样砍掉的还有：primary scope 判断（验 marker、比 git dir 和 git common dir—一个 `yan` 一个 `task`，没有 agent 树）、六个 harness 各一份适配（只 Claude，[§5.6](agents.md#56-harness-要求)）、hook payload 解析（不读 stdin）。

两个 hook 的实现都很小，guard 尤其小。
