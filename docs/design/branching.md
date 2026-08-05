# 6. 分支模型

## 6.1 两级结构

```
target (master / release/x / 任意分支)
 └─ 集成分支（当前这一轮的 working 分支）———→ 对外 MR —→ target
      ├─ 子分支 s1  → MR → 合回集成分支 → shift s1 下工
      ├─ 子分支 s2  → MR → 合回集成分支 → shift s2 下工
      └─ 子分支 s3  ...（可并发，各自一棵 worktree）
```

这个结构一次解决三件事：shift 的生命周期有了客观的绑定物（子分支合了就下工）、多 agent 并发有了隔离（各自的子分支加各自的树）、前进有了载体（新 shift 从集成分支当前 head 切出）。

注意集成分支只代表当前这一轮—它会被整个替换，见 §6.3。所以「在同一轮里继续改」跟「上一轮已经交付或废弃了」是两种不同的机制，别当成一回事。

## 6.2 两级分支 = 两级 review

这是结构自带的，不是额外加的：

| MR | 合到 | 谁 review | 性质 |
| --- | --- | --- | --- |
| 子分支 → 集成分支 | user 自己 own 的分支 | user + CI，不需要同事 | 内部验收关口 |
| 集成分支 → target | target | 同事正式评审 | 对外交付 |

同事只看到一个 MR，不会被噪音淹。

## 6.3 集成分支怎么变

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

后两种都用 `yan unit set --branch <新分支>` 来做，区别只在于 history 里怎么记。

`target` 变更也不是纯记账：如果从 `release/x` 换成 `master`，集成分支就要 rebase 到新的 target，可能会撞上一堆冲突，也可能需要派一个 shift 去解。

## 6.4 unit 的结构：当前是标量，历史是 append-only

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
| `end` | delivered 还是 abandoned。没有它，history 里躺着一串分支，看不出哪个真上线了、哪个是半路扔掉的 |
| `mr`（可选） | 唯一查起来麻烦的：分支删了之后要 `glab mr list --source-branch` 才找得到，同一分支开过多个 MR 还有歧义。而 URL 是不变的事实，存它不违反判据（[§2](INDEX.md#2-三条判据)）。废弃的轮次可能压根没开过 MR，所以这个字段可选 |

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

废弃的那一行 `log` 必须写清原因。 正常轮换的原因摆在那儿（上线了、有反馈）；废弃的原因才是最容易忘的—半年后再看到 `2.0.3` 断在那儿，已经想不起来当初为什么扔掉它了。

```
- 08-25  auth  废弃 2.0.3 → 2.0.4（基于 2.0.3; 上游 proto 改了接口，这条线的 MR 没法 review 了）
```

`target` 没有默认值，`yan unit add` 必须显式给—user 的实际工作方式是大项目期团队短期维护一个分支大家往里合，平稳期各自往 master 合，没有一个安全的默认。

`needs` 是落地顺序，`yan land` 按它拓扑排序。同一个 repo 可以在 units 里出现多次—team 的 monorepo 子应用各改各的，不能用同一个分支改两个应用，所以一个 unit = 一个子应用 = 一个分支 = 一棵树。

## 6.5 两级分支有两个不同的命名权威

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

## 6.6 yan 永不解析分支名

因为集成分支的命名可能由 okt 接管，yan 不能假设它有任何结构：不靠前缀 glob 推断归属，而是 `task.json` 存 `unit.branch`、`run/meta.json` 存 shift 的子分支名。反向查询（「这分支是谁的」）查存储，不拆字符串。

例外：`git branch --list 'yan/*'` 可以用来找出所有 yan 造的分支做运维清理。那是「枚举自己的东西」，不是「从名字推断归属」，不违反这条。

## 6.7 unit 粒度的判据

集成分支合到 target 时，那个 MR 的 diff 是所有 shift 的总和。shift 攒多了，同事就 review 不下去了。这个成本反过来给了 unit 粒度一个明确标准：

> 一个 unit 的粒度 = 一个对外 MR 的粒度 = 同事一次 review 能吃下的量。

一旦攒到 review 不下去，就说明它该拆成两个 unit 了（两个集成分支、两个对外 MR）。
