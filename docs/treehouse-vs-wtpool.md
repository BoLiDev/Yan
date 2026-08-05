# treehouse vs wtpool 调研

> 状态：调研记录，2026-08-05。
> 目的：回答「treehouse 能不能直接替代 wtpool 作为 yan 的 worktree 层」（对应 `yan-design.md` §7）。
> 结论：**不能直接替代。但它的 lease 身份机制值得抄回 wtpool。**

---

## 0. 调研对象

假定指的是 [kunchenguid/treehouse](https://github.com/kunchenguid/treehouse)：Go 写的 git worktree 池，和 wtpool 是同类物（`get` / `return` / `status` / 池 + 复用 + 保留依赖缓存）。

| | |
| --- | --- |
| 版本 | v2.1.0（2026-07-20） |
| 活跃度 | 22 个 release、约 1k star、108 fork，在活跃开发 |
| 形态 | 单二进制，macOS / Linux / Windows |
| 一句话定位 | Manage worktrees without managing worktrees —— 给 agent 用的「即时隔离」，复用池里的树以保留依赖和构建缓存 |

同名项目还有 `mark-hingston/treehouse-worktree`（npm + MCP server）和 `joelwohlhauser/treehouse`（VS Code 扩展）。**若文档里指的是那两个，本结论不适用。**

---

## 1. 结论速查

| 维度 | wtpool（按 `yan-design.md` 所述） | treehouse v2.1.0 | 判定 |
| --- | --- | --- | --- |
| 分支模型 | 树上是真实分支，从集成分支切子分支 | 恒定 detached HEAD，reset 到 default branch | ✗ 结构性不匹配 |
| 落地判据 | 「远端有副本」即可还树（弱判据） | `unlanded` = 未提交 / HEAD 未并入 **default branch** / 无法验证 | ✗ 口径对不上 |
| 状态存储 | 零状态文件 | 持久 `treehouse-state.json` | △ 与设计原则 1 有张力 |
| holder 标签 | `WTPOOL_HOLDER=<task>/<unit>/<sid>` | `--lease-holder` / `$TREEHOUSE_LEASE_HOLDER` | ✓ 等价 |
| 非交互取树 | 有 | `get --lease`（路径→stdout，消息→stderr） | ✓ 等价 |
| 租约身份 | 无 | 每次 acquire 一个随机 `lease_id` | ✓ **treehouse 更好** |
| 条件还树 | 无 | `return --if-lease-id` / `--if-lease-holder` | ✓ **treehouse 更好** |
| 机器可读状态 | 文本 `status` | `status --json` | ✓ **treehouse 更好** |
| 孤立 commit 守卫 | 有，且是「最后一道防线」（§7） | 未文档化，需读源码 | ? 待查 |
| 池满行为 | `get` 自己失败（§7 明确要这个语义） | 只文档化 `max_trees = 16` | ? 待查 |

---

## 2. 三处结构性不匹配

### 2.1 分支模型对不上（致命）

treehouse 的原话是 worktree 使用「detached HEAD mode, reset to whichever of the local or remote default branch is further ahead, **avoiding branch name conflicts entirely**」。它把「不碰分支名」当成卖点。

而 yan 要的恰恰是分支（§6.1、§6.5）：

- 子分支从**集成分支**切出，集成分支可能叫 `2.0.4` 或 `yan/t042-auth-r2`，都不是 default branch
- 子分支有固定命名格式 `yan/<task>-<unit>-<sid>`，要 push、要开 MR、要合回集成分支

treehouse 没有「给我一棵基于 X 的树」的入口。接进来的话，必须在租到的树里自己做：

```sh
tree=$(treehouse get --lease --lease-holder "$task/$unit/$sid")
git -C "$tree" fetch origin
git -C "$tree" checkout -b "yan/$task-$unit-$sid" "origin/$branch"
```

——treehouse 全程不知情。它退化成一个「目录复用 + 依赖缓存保留」的工具，分支这一层完全自理。

**这才是「不用 treehouse」的真正理由**，比文档 §7 现在写的「零状态文件设计」更硬。建议改 §7 的措辞。

### 2.2 落地判据的口径和 yan 反向

treehouse 把 worktree 判为 `unlanded` 的条件是：「uncommitted changes, a HEAD **not merged into the default branch**, or contents treehouse cannot verify」。

yan §7 的判据明确更弱——「有副本」和「已落地」是两个不同强度的判据，yan 有意拆开了，还树只需要那个更弱的（远端有副本就够）。而且 yan 的子分支是合回**集成分支**，不是 default branch。

后果：**在 yan 的模型里正常下工的树，在 treehouse 眼里永远是 unlanded**（集成分支合进 target 之前都不成立）。于是：

- `treehouse prune` 基本失效——它只回收「HEAD 已并入 default branch 且工作区干净」的 stale idle 树
- `destroy` 要一直带 `--include-unlanded`，而那个 flag 的文档写着 *(irreversible data loss)*

方向是保守安全的，不会误删。但它多出来的那套判据在 yan 下产生不了价值，等于白背一层复杂度。

### 2.3 零状态 vs 状态文件

treehouse 有持久的 `treehouse-state.json`：原子写；文件为空或截断时不报错，而是**从磁盘上还在的 worktree 目录重建条目，并把每个恢复项一律标记为 `leased`**（保守，宁可占着）。

`yan-design.md` §7 选 wtpool 的理由原文是「wtpool 的零状态文件设计正好能被完整复用」，和设计原则 1「状态能推导就不要存」一脉相承。

但公道地说，**这是三条理由里最弱的一条**：

- treehouse 需要状态文件，是因为它要表达「没有活进程但树仍被占用」这个语义——这个语义不可推导，必须存
- 而 yan 两种都要：shift 干活期间树里一直有活进程（进程扫描就够），但 `yan sync` 是**无进程的短租**（§7：「集成分支不常驻任何树，`yan sync` 临时租、用完就还」），那段时间只能靠 lease 表达占用

所以这条不构成拒绝理由，只是设计取向的差异。真正的理由是 2.1。

---

## 3. 一处 treehouse 明显更好：lease 身份

treehouse 的 lease 机制几乎精确命中 §7 的「池本身就是运行时注册表」，而且比 wtpool 多三样：

**（a）随机 `lease_id`。** 「Every acquisition receives a new random `lease_id`」。

**（b）条件还树。** `return --if-lease-id "$lease_id"` / `--if-lease-holder "$holder"`：

> Treehouse compares supplied conditions while holding the pool state lock. A missing lease or mismatch exits nonzero **before** process termination, worktree reset, or state clearing.

即：不匹配就非零退出，**不杀进程、不重置、不清状态**。这对自动化重试是安全的。

**（c）`--json` 输出。**

```json
// get --lease --json
{"path":"...","lease_id":"...","lease_holder":"...","leased_at":"..."}

// status --json  →  数组
{"name":..,"path":..,"status":..,"lease_id":..,"lease_holder":..,"leased_at":..,"processes":..}
```

（非 leased 条目的 lease 字段为空串，`leased_at` 为 `null`。）

### 为什么值得抄

(a)+(b) 解决的正是 §5.5 里 guard 做「身份匹配（那个 pid 真是我们的 watcher，不是 pid 复用后的别人）」的同一类问题。yan 在监督层已经认真处理过一次陈旧身份的坑，**池层现在还是裸的**：`wtpool return` 只认 holder 标签，一个重试的、或者上一轮遗留的调用，可能还掉别人刚租到的树。

改动成本很低：`get` 时生成一个随机 id 写进池的运行时记录并回显，`return` 加两个可选比对参数，比对必须在持锁状态下做。

顺手把 §12.3 那个 `wtpool get --help` 被当成 holder 标签租走一棵树的 bug 一起修——加了条件还树之后，标签污染的后果更严重。

---

## 4. 其余对照

| 项 | treehouse | 对 yan 的意义 |
| --- | --- | --- |
| `get --lease` | 只把路径打到 stdout，消息走 stderr | 能直接进 `bin/lib-*.sh`，不像默认 `get` 会开 subshell |
| `enter <name>` | 按编号进已有树的 subshell | yan 用不上（agent 自己在 pane 里） |
| `return` | 「Release any lease, terminate lingering worktree processes, and return it to the pool」 | **要查**：会不会杀掉 shift 的 agent 进程 |
| `return --force` | 「Clean, reset, and return without prompting」；另有说法是 skips prompts but does not bypass safety | §9.2 把 `wtpool return --force` 列为禁止动作，语义要对齐 |
| `prune` | 默认 dry-run；有 origin 时会 fetch 并对着远端 default branch tracking ref 验证每个 HEAD；`--all` / `--global` 跨池；`--prune-orphans`；`--yes` 才真删 | 因 2.2，在 yan 下基本不触发 |
| `destroy` | 默认安全；`--include-unlanded` / `--include-in-use` / `--include-leased`（后者必须指名确切路径，`--all` 永不删 leased 树） | 边界设计得不错，可参考 |
| 池根目录 | `~/.treehouse/<repo>/<id>/<repo>`，可用 `root` 改 | 和 wtpool 的 `~/.wtpool/<repo>-<hash>/N/<repo>` 同构 |
| 配置 | repo 级 `treehouse.toml` + 用户级 `~/.config/treehouse/config.toml`；`max_trees`（默认 16）、`root` | — |
| hooks | 仅用户级配置生效，**repo 级 hooks 出于安全被忽略**；`post_create`（provision/reset 后、交付前）、`pre_destroy`；在 worktree 目录里顺序执行 | 和 yan 的 `conf/hooks/`（§10）是不同的东西。`post_create` 可用来装依赖，正好对上 §7 末尾「首次撑开 3 棵新树要装 3 次」那个成本 |
| in-use 检测 | 扫描运行中进程 + 短命 owner reservation + 持久 lease | 比 wtpool 多一层 lease |

---

## 5. 决定替换前必须读源码确认的三点

1. **`return` 对未推送 commit 的行为。** 文档只说清了 lease 和杀进程，没写 prompt 的触发条件。而 §7 把 wtpool 的孤立 commit 守卫当「最后一道防线」，§9.2 把 `--force` 列为禁止动作。这是安全性的核心，不能靠推测。
2. **池满时是阻塞还是失败。** §7 明确要「池满时 `get` 自己失败，这是准确的信号，不需要提前预测」。treehouse 只文档化了 `max_trees = 16`，没说满了怎么办。
3. **「lingering processes」的扫描范围。** shift 的 agent 进程 cwd 就在树里。如果 `return` 会杀它，需要和 §5.3 的下工顺序（写 `outcome.md` → `rm -rf run/` → 还树）重新对一遍——正常路径下 agent 应该已经结束，但异常路径下的语义要明确。

---

## 6. 建议

1. **不整体替换。** §7 保持用 wtpool。
2. **改 §7 的措辞**：把「不用 treehouse」的理由从「零状态文件设计」换成「分支模型不匹配」——treehouse 恒定 detached HEAD 并把「不碰分支名」当卖点，而 yan 的整个两级分支模型（§6）建立在树上有真实分支之上。零状态那条降级为次要理由。
3. **给 wtpool 加两样**：随机 `lease_id` + `return --if-lease-id` / `--if-lease-holder` 条件还树（持锁比对、不匹配则在任何破坏性动作之前退出），以及 `--json` 输出。同时修 §12.3 的 `--help` 标签 bug。
4. **可选**：借鉴 `post_create` hook 的位置，解决「首次撑开 N 棵新树要装 N 次依赖」。

---

## 参考

- <https://github.com/kunchenguid/treehouse>
- <https://raw.githubusercontent.com/kunchenguid/treehouse/v2.1.0/README.md>
- <https://raw.githubusercontent.com/kunchenguid/treehouse/v1.4.0/README.md>

本文档中关于 wtpool 的一切描述，均来自 `yan-design.md`（§7、§9.2、§12.3），**未读过 wtpool 源码**。若与实现有出入，以实现为准。
