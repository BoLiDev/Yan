# 实现计划：七个阶段，17 个 `task`

> 依据：[`design/INDEX.md`](design/INDEX.md) 的决策，[`design/architecture.md`](design/architecture.md) 的分层。
> 定位：这份说「按什么顺序做、每块怎么测」。
> 本文里裸写的 `§x` 指本文；指别的文档时一律写成 `design §x` / `architecture §x`。

---

## 0. 切分原则

**不按层自底向上做。** 自底向上的问题是到最后一刻之前什么都不能用，没有任何反馈，
而且等到发现监督那层跑不通的时候，已经有一大堆代码建立在它能工作这个假设上了。

改成：**先撑起最小骨架（很小），然后每个阶段交付一个能真正跑起来、能独立验证的东西。**
这也是设计原则 6「每一步只加当前真实疼痛所需要的机制」在实现顺序上的样子。

三个刻意的排序决定：

1. **池排在第二个，不是最后。** 它是最大的一块 primitive，而且它自己就能用——
   `yan tree get` 手敲就有价值，不需要任何 agent。早做等于早拿到一个真实用户，也就是造它的人自己。
2. **监督排在第四，不排最后。** 它是风险最高、最不能增量验证的一块。
   排最后意味着在整个系统都压在它身上之后才发现 hook 不工作，那是致命的。
   排第四是因为到那时刚好有东西可以被监督。
3. **`AGENTS.md` 最后写，但要早读。** 它最后落地，可是 CLI 的形状应该被它塑造——
   写每个子命令时都问一句「模型会怎么调它」。

---

## 1. 阶段总览

| 阶段 | 交付的能力 | `task` 数 | 阶段结束时成立的事 |
| --- | --- | --- | --- |
| **P0 地基** | 骨架 + 测试台 | 2 | 跑 `yan`，跑测试，CI 是绿的 |
| **P1 池** | worktree 池 | 1 | **手动租树还树，热复用真的省掉冷装** |
| **P2 记账与终端** | 存储 + 终端 | 3 | 建 `task`、看队列、在 tmux 里起进程 |
| **P3 派工** | 派出第一个 `shift` | 2 | **第一个 sub-agent 真的在树里干活**（此时还要人工盯 pane） |
| **P4 监督** | hook + watcher | 2 | `shift` 干完会自己发出通知 |
| **P5 交付** | forge + 合并链路 | 5 | 子分支 MR、对外 MR、下工还树 |
| **P6 AGENTS.md 与验收** | 判断 + 自举 | 2 | **[design §11](design/scope.md#11-01-范围) 的验收链在 Yan 自己身上跑通** |

依赖图（同一列内可并行）：

```mermaid
graph LR
    S[yan-skeleton] --> J[yan-json]
    S --> P[yan-pool]
    J --> P
    J --> ST[yan-store]
    S --> TM[yan-term-tmux]
    ST --> RG[yan-registry]
    RG --> U[yan-unit]
    P --> SN[yan-shift-new]
    TM --> SN
    U --> SN
    SN --> W[yan-wait]
    W --> H[yan-hooks]
    S --> FG[yan-forge-github]
    FG --> FL[yan-forge-gitlab]
    FG --> SY[yan-sync-mr-land]
    U --> SY
    SY --> SD[yan-shift-done]
    P --> SD
    SD --> SS[yan-session-start]
    H --> SS
    SS --> AG[yan-agents-md]
    AG --> AC[yan-acceptance]
```

---

## 2. `task` 清单

每个 `task` 一个 `unit`，粒度按 [design §6.7](design/branching.md#67-unit-粒度的判据) 的判据定：**一个对外 MR 的粒度 = 一次 review 能吃下的量。**

「测试」一列写的是**这个 `task` 必须自带的用例**，不是泛泛的「要写测试」。
测试台的形状（`tests/` 布局、`YAN_LIB` 替身机制）见 [architecture §7](design/architecture.md#7-可测性)，由 P0 定死，后面沿用。

### P0 · 地基

| id | 交付 | 测试 |
| --- | --- | --- |
| `yan-skeleton` | `bin/yan` 入口（解析子命令 → exec `yan-<cmd>.sh`）、`lib-git.sh`、`tests/` 测试台、shellcheck、GitHub Actions | 未知子命令给出可用的错误和候选；`lib-git` 的每个函数只接受显式目录、**不依赖 cwd**（在别处 cd 之后调用仍然正确）；shellcheck 零告警 |
| `yan-json` | `lib-json.sh`：读、原子写（`tmp → mv`）、`version` 字段 | **写到一半 kill -9，原文件完好无损**（这是这个模块存在的唯一理由，必须直接测它）；缺 `version` 的文件被拒绝 |

### P1 · 池

| id | 交付 | 测试 |
| --- | --- | --- |
| `yan-pool` | `lib-pool.sh` + `yan tree get\|return\|status`：租约（随机 `lease_id`）、条件还树、`--json`、热复用、背压、孤立 commit 守卫 | 见下面八条 |

这是整个项目测试密度最高的一个 `task`，八条一条都不能少：

1. `get --base X --branch Y` → 路径存在、在 Y 分支上、基于 X
2. **`return` 之后一个 gitignored 目录仍然在**（`node_modules` 替身）——
   防的是某天有人给 `clean` 加 `-x`，池静默退化成每次冷装，**不报错，只是变慢**
3. `return --if-lease-id <错的>` → **非零退出，且树完全没被动过**（不杀进程、不 reset、不清状态）
4. 有未提交改动 → `return` 拒绝
5. 有已 commit 未 push 的 commit → `return` 拒绝（孤立 commit 守卫）
6. **池满 → `get` 失败，且不创建第 N+1 棵树**（这条守的是「池保持 N 棵热树」）。
   N 取自 `repos.json` 的 per-repo 配置，默认 8
7. 两个并发 `get` → 永远不会拿到同一棵树
8. 池满时 `yan sync` 的错误信息说的是**「池满，开不了新 `shift`」**，不是「sync 失败」

**阶段里程碑：这时候池已经能手动用了。** 建议真的用一阵子再往下走。

### P2 · 记账与终端（三个 `task` 可并行）

| id | 交付 | 测试 |
| --- | --- | --- |
| `yan-store` | `lib-task.sh`（`task.json` 读写、四个当前标量、`history[]`）+ `lib-log.sh`（append 一行） | `history[]` 写进去之后任何操作都不改动它；`log.md` 的历史行永不被改写；`task.json` round-trip 不丢字段 |
| `yan-term-tmux` | `lib-term.sh` 的 tmux 实现，七个函数 | **对真实 tmux 测**：起一个 `sleep 300` → `alive` 为真 → `send` 的文字真的到了 → `read` 读得到 → `close` 只关掉记录的那个 pane、**session 还在** → `list` 少一个。另测：`term_agent_alive` 在「pane 在但进程死了」时的返回值是明确的 |
| `yan-registry` | `yan repo-add` / `task new` / `ls` / `open` | `repo-add` 是 `repos.json` 的唯一写入口；`ls` 扫目录得到的队列 = 目录真实内容（删掉一个 `task` 目录，`ls` 立刻少一个，**不需要任何同步**） |

`term_agent_alive` 在 tmux 下只能靠猜进程名，这是已知的近似（[design §5.7](design/agents.md#57-终端拓扑)）。**在代码里注明**，
等 Herdr 那份实现（2→10）才变成「问」而不是「猜」。

### P3 · 派工

| id | 交付 | 测试 |
| --- | --- | --- |
| `yan-unit` | `yan unit add`（`target` 必须显式给）+ `lib-hook.sh`（`branch-name` 接缝） | hook 非零退出 → **停下报错，绝不 fallback 到内置默认**；hook 缺失 → 用内置默认 `yan/<task>-<unit>-r<n>`，且 `n` = `history` 长度 + 1；hook 返回的分支已存在 → checkout 而不是重建 |
| `yan-shift-new` | `yan shift new` + `yan send` + `yan report` + `yan scope-check` + brief 模板 | **cwd 断言：指向主 clone 时真的拒绝启动**（[design §7](design/worktree.md#7-worktree) 的硬不变量）；brief 里所有占位符都被替换（残留 `{...}` 直接失败）；`yan report` 只接受那五个 state，第六个词被拒；`report` 同时写了 status 和 signal；`scope-check` 越界时**只报告不拦** |

**阶段里程碑：第一个 sub-agent 真的在树里干活了。** 这时还没有监督，pane 要靠人工盯。
这是刻意的——先证明派工路径本身是对的，再上 hook 的复杂度。

### P4 · 监督

| id | 交付 | 测试 |
| --- | --- | --- |
| `yan-wait` | `yan wait`（三个 source + wake 文件 + beacon）+ `yan drain` | 三个 source 各自单独触发一次，断言退出码和 wake 文件内容；三个都没动静 → 静默 exit 非 0；wake 文件在「watcher 退出」到「模型下一个 turn」之间**活下来**；beacon 每轮都被 touch |
| `yan-hooks` | `hook-autoarm.sh` + `hook-turnend-guard.sh` + `.claude/settings.json` | guard **完全不读 stdin**（喂它空 stdin 也照常工作）；拦 3 次后 fail open **并打印明确的告警**；watcher 恢复健康时计数清零；单飞锁：两个并发 autoarm 只起一个 watcher；「watcher 健康」的三个条件各自单独失败时都能拦（锁里的 pid 活着但 beacon 陈旧 → 拦；beacon 新鲜但锁没了/身份不匹配 → 拦） |

**这一阶段的集成测试没法做成单元测试**，需要一次手动彩排：
用一个假 `shift`（就是 `sleep 60 && yan report done "fake"`）跑完整条链路，
确认「turn 结束 → watcher 起来 → 假 `shift` 报告 → 模型被唤醒」这条链走得通。跑一次就够，然后把结果记录下来。

### P5 · 交付

| id | 交付 | 测试 |
| --- | --- | --- |
| `yan-forge-github` | `lib-forge.sh` 接口定义 + GitHub 实现（四个动词） | 四个 `forge_mr_state` 返回值各触发一次；**返回值只可能是那四个之一**（喂它一个古怪的 API 响应，必须回 `unknown` 而不是漏出原文）；`forge_ci_state` 把 N 个 check run 归约成一个绿红 |
| `yan-forge-gitlab` | GitLab 实现 | 同上一套用例，换一份 fixture。**需要 `glab` 和一个真实 GitLab 目标，见 §4** |
| `yan-sync-mr-land` | `yan sync` + `yan mr` + `yan land` + `yan unit set` | `sync` 遇到冲突**真的退出**，不留下半个 rebase；`unit set --branch` 对 forge 四种状态各判一次 `end`（merged→delivered，closed/空→abandoned，open→问 `user`，查不到→问 `user`）；换赛道是原子的（判定 → 归档 → 覆盖 → log 一行，中途失败不留半成品）；`land` 没有明确授权时拒绝 |
| `yan-shift-done` | `yan shift done` + `yan state` | **squash 场景下先还树后删分支**（这条单独立一个用例，见 §3）；`state` 从 meta + 终端 + git + forge 推导，**不读 `run/status` 的最后一行** |
| `yan-session-start` | `yan session-start` 全量 reconcile | 硬 kill 掉 `yan` 之后重启，reconcile 得到的现实 = 实际现实（`shift` 还活着就是活着，死了就是死了）；**没有任何一条状态来自对话记忆** |

### P6 · AGENTS.md 与验收

| id | 交付 | 测试 |
| --- | --- | --- |
| `yan-agents-md` | `AGENTS.md`：模型读的那一份判断 | 通读一遍：每条指令都指向一个真实存在的 `yan` 子命令；**没有任何一条要求模型 source 一个 lib** |
| `yan-acceptance` | 在 **Yan 自己这个仓库**上跑通 [design §11](design/scope.md#11-01-范围) 的验收链 | [design §11](design/scope.md#11-01-范围) 的验收链整条走通，一步不落 |

---

## 3. 测试策略

成本从低到高，跑的频率从高到低：

| 层级 | 对象 | 依赖 | 什么时候跑 |
| --- | --- | --- | --- |
| **shellcheck** | 每个脚本 | 无 | 每次 commit。bash 里它能挡掉的东西多得惊人 |
| **stub 级单元** | 子命令 | 无（接缝全替身） | 每次 commit，秒级。`tests/run.sh --fast` |
| **真实权威接缝** | `lib-git` / `lib-pool` / `lib-term` | 一个临时 git 仓库、一个真实 tmux | 每次 PR。CI 上跑得动（runner 有 tmux） |
| **真实 forge** | `lib-forge` | 网络 + token + 一个 scratch 仓库 | 本地手动 + PR 上打了标签才跑。**不进默认 CI** |
| **顺序回归** | 那四条 | 视情况 | 每次 PR。见下 |
| **手动彩排** | 监督整链 | 一个真实 Claude session | P4 一次，之后改 hook 时重跑 |
| **验收** | 整个系统 | 全部 | P6 一次 |

**四条顺序回归用例**，都是「错了不报错、只是悄悄坏掉」的类型，所以必须有用例守着：

1. `pool_return` 之后 gitignored 目录仍然在（加了 `-x` → 静默退化成每次冷装）
2. `yan shift done` 先还树后删分支（顺序反了 → squash 时树还不回去）
3. `yan shift new` 的 cwd 断言真的拒绝（失效 → sub-agent 在主 clone 里乱改）
4. `yan sync` 冲突时真的退出（失效 → 留下半个 rebase，下一个 `shift` 从烂摊子上切分支）

CI（GitHub Actions）跑的是 `shellcheck` 加 `tests/run.sh`，而真实 forge 那一层默认跳过。

---

## 4. 三个会挡路的东西

| | 挡住什么 | 现在能做什么 |
| --- | --- | --- |
| **`task` id 格式没定** | `yan-registry`（P2） | 选一个就行，选项和倾向见 [design §12](design/scope.md#12-待定) |
| **`glab` 没装，也没有可测的 GitLab 目标** | `yan-forge-gitlab`（P5） | **不挡主线。** GitHub 那份就够跑通 [design §11](design/scope.md#11-01-范围) 的验收（Yan 自己在 GitHub 上）。GitLab 那份等有了靶子再单独做，接口已经被 GitHub 那份定死了 |
| **Yan 仓库自己的交付姿态没定** | 怎么造 `yan` | 三选一，见下 |

最后一条要在三个里挑一个：`no-mistakes`（每次改动过完整的自动化流水线：review / 测试 /
文档 / CI，再开 PR）、`direct-PR`（直接推分支开 PR，质量把关靠 `user` + CI）、
`local-only`（不开 PR，本地分支）。**暂按 `no-mistakes` 注册（默认值），随时可改。**

有点意思的是：**`yan` 自己的设计明确不引入 no-mistakes**（[design §11](design/scope.md#11-01-范围)），
理由是「质量把关落回 `user` + CI + 同事 review，这本来就是正常团队的做法」。
在 `yan` 这个仓库上用不用它，是另一件事，但值得一起想。

---

## 5. 并行度

如果用 sub-agent 来造 `yan`，可并行的地方：

- **P2 的三个 `task` 完全独立**（`yan-store` / `yan-term-tmux` / `yan-registry`），三棵树同时开
- **`yan-forge-github` 从 P0 之后就能开始**，不必等 P1–P4，可以和整条主线并行
- **`yan-forge-gitlab` 随时可以插进来**，只要接口定了

其余是真串行——`yan-shift-new` 必须等池和终端，`yan-hooks` 必须等 `yan-wait`。

**建议第一个阶段（P0+P1）自己手写。** 不是因为 sub-agent 干不了，
而是这段代码定下了后面所有 `task` 的形状：测试台长什么样、子命令怎么 source lib、
错误怎么报。这些约定由造 `yan` 的人亲手定一次，比写在 brief 里让别人猜要准得多。
