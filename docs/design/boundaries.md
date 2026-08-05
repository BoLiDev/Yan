# 边界：谁能写什么、什么委托出去

## 9. yan 的可写范围

### 9.1 文件系统

yan 写的只有自己的记账层：`task.json`、`log.md`、各级 `brief.md`、`run/meta.json`、`mem/learnings/`、`mem/repos.json`。

yan 不写的有四类：`repos/` 主 clone（唯一允许的写是 `git fetch`，永不 checkout、永不改工作区、永不 commit）、shift 自己写的 `status` / `outcome.md` / `artifacts/`、user 的本地选择 `conf/`、以及 yan 自己的 `bin/` 和 `AGENTS.md`（运行时不自改）。其他 task 的目录也不读（[§5.2](agents.md#52-一个-yan--一个-task)）。

逐条清单见 [附录 B](appendix.md#附录-b--yan-的文件系统边界)。

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
| 删已合并的子分支 | yan | 自主。必须排在还树之后（[§7](worktree.md#7-worktree)） |
| 删未合并的任何分支 | — | 禁止 |
| `yan unit set`（改 branch / target / mode / scope） | yan | 必须 user 明说—改的全是决策 |
| MR 上留评论、@人 | — | 必须 user 明说，会打扰同事 |

> 在自己的分支和本机范围内 = 自主；一旦影响 target 或者同事会看见 = user 明说。

### 9.3 shift 的范围

shift 只写三处：自己 `shifts/<sid>/` 下的 status 和 outcome、`tasks/<id>/artifacts/`、以及它租来的那棵树里的代码。`mem/`、`task.json`、集成分支、主 clone 一律不碰。

反过来，yan 从不进 worktree 改代码。唯一进树的场合是 `yan sync`，那是脚本动作，有冲突就立刻退出交给 shift。这条让「谁改了什么」永远可归因。

---

## 10. 外部权威接缝（okt 等）

> 跟 [§5.5](supervision.md#55-监督) 的 Claude Code hook 区分开：那是 harness 的生命周期钩子，这里是把「分支该叫什么名、能不能合」这类决策委托给外部权威的接缝。两者同名不同物。

user 的团队用 okt 管分支命名和可合并性。yan 的代码里不出现 `okt` 三个字母，通过一个 opt-in 接缝委托出去。

```
conf/hooks/
  branch-name      给集成分支起名（或直接建好它）
  merge-check      判断能不能合   ← 留位置，0→1 不实现
```

`conf/` 是 LOCAL、gitignored—这是这台机器、这个团队的选择，不是 yan 的一部分。

### branch-name 契约

只在集成分支上调用。 子分支永远由 yan 自己命名（[§6.5](branching.md#65-两级分支有两个不同的命名权威)）—okt 不认识 shift，让它命名没有意义。

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
