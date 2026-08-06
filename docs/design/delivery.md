# 8. 交付模式

## 8.1 `mode` 与 authority

firstmate 那三种模式（no-mistakes / direct-PR / local-only）不是权限等级，是「做到哪一步就停」；合并权限在它那里是另一个正交维度。`yan` 显式分开：轴 1 · `mode` 管干到哪一步停下来，轴 2 · authority 管谁能按 merge（[§9.2](boundaries.md#92-外部副作用)）。

## 8.2 `scout` / `branch` / `mr`

| `mode` | 改代码 | commit | push | 开 MR | 交付物 | 终态 |
| --- | --- | --- | --- | --- | --- | --- |
| `scout` | × | ✓（scratch） | × | × | `report.md` + `artifacts/` | `done: report` |
| `branch` | ✓ | ✓ | × | × | 本地干净分支 | `done: branch <name>` |
| `mr` | ✓ | ✓ | ✓ | ✓ | GitLab MR | `done: mr <url>` |

层级：`kind: scout | ship` 是 `task` 级（交付物类型不同）；`mode: branch | mr` 是 `unit` 级（不同 repo 的交付姿态不同）。per-repo 默认写在 `repos.json`，per-unit 覆盖写在 `task.json`。

`scout` 的树是「声明为可丢弃的 scratch」（抄 firstmate）：允许随便脏、随便 commit（跑复现、试探性改动都需要），但不许 push、不许落地，report 写完整棵树直接丢。比「禁止改任何东西」实用得多。

默认 `mode` 是 `mr` 而不是 `branch`，因为 push 到远端就是最好的备份。`branch` 只在「这个仓库不能随便推分支」时才用（分支保护、命名规范、推一次触发昂贵 CI）。

`mode` 管的是集成分支的对外交付方式；子分支那一级恒定走「MR 合回集成分支」。

## 8.3 强制手段

0→1 不花预算做隔离机制，用启动参数就够：

| 目标 | 手段 |
| --- | --- |
| 不乱改 + 省上下文 | cwd 设成 `scope` 主路径，其余 `scope` 用 `--add-dir` 加进来。agent 的世界就是那几个目录 |
| `scout` 不改代码 | plan mode（其他 harness 对应只读 sandbox） |
| `branch` 不许 push | 只在 `brief` 里写一句 |

最后一条的理由：GitLab 服务端的分支保护本身就是最后一道防线。 误推一个分支是廉价可逆的（删掉就行），真正严重的情况服务端会直接拒。客户端 hook 只是锦上添花。

具体的 flag 以各 harness 当时的 `--help` 为准，所以 spawn 脚本里维护一张小映射表就够了（harness → 设 cwd / 加目录 / 只读模式），不要为它做一层抽象。

保留一条最便宜的校验：`yan scope-check <sid>` 用 `git diff --name-only` 加前缀匹配，在 land 之前跑一次。它不约束 agent 干活，只在落地前报告越界。语义是「越界必须显式扩，不是禁止」：

> 改 `apps/auth` 时发现必须动 `apps/common` 的一个类型—这在真实工作里天天发生。直接拒绝会让 agent 卡死或者偷偷绕过。规则是改 `task.json` 扩 `scope`，并在 `log.md` 记一行。

这样既挡掉乱改，又能看到范围是怎么长大的—`scope` 频繁膨胀通常意味着任务拆错了。

`sparse-checkout` 归档：它需要先解决「编辑范围 ≠ 构建闭包」这个问题（monorepo 里 `apps/auth` 编译通常需要 sibling 包在场），成本很高，所以等上下文真的开始疼了再做。

## 8.4 forge 层：`lib-forge.sh`

**GitLab 和 GitHub 都支持**，因为两个都是真实需求：工作用 GitLab，日常用 GitHub。
附带一个不小的收益：支持 GitHub 之后，0→1 的验收标准可以在 `yan` 自己身上跑通。

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
是 deep 的反面。我能想到的避法只有一条：接口用 `yan` 自己的词汇定义，不是两个 forge 的并集。

三条具体约束：

1. **返回值是 `yan` 的封闭集合。** `forge_mr_state` 的四个值不是随便挑的—
   它们正是 [§6.4](branching.md#64-unit-的结构) 判定 `end` 需要的那四种情况，一一对应。不要漏第五种。
2. **CI 只回答绿红。** GitLab 是一条 pipeline 一个状态，GitHub 是 N 个独立 check run
   加 legacy status，「哪个 job 挂了」两边不对称，强行统一就会漏。而 [§5.3](agents.md#53-shift-的生命周期) 需要的
   只是「CI 红了 → 派新 `shift` 修」。要看细节是 `shift` 的事——`shift` 可以知道自己在
   哪个 forge 上，因为它是在读，不是在做决定。
3. **归属放 `repos.json` 的 per-repo 字段，不是全局开关。** 一个 `task` 完全可能同时
   动公司 GitLab 的 monorepo 和 GitHub 上的个人仓库，所以按仓库分派，不按 session。

鉴权这一层不统一。因为 `gh` 和 `glab` 各自管自己的登录，所以这一层不去试图抹平它们：
bootstrap 会检查两个 CLI 是否都已认证，缺哪个就明确报哪个。如果用的是自建 GitLab 实例，
还需要额外跑一次 `glab auth login --hostname`。

这不是 [§11](scope.md#11-01-范围)「明确不做」里禁的 backend 抽象层。那条禁的是插件框架，而这里和 [§5.7](agents.md#57-终端拓扑) 的
`lib-term.sh` 是同一个形状：**内聚成一个文件里的几个函数，不是框架。**
