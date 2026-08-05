# yan

单人用的软件工作编排系统：提出一件要做的事，yan 把它拆成可派发的活，
派给一次性的 sub-agent 在隔离的 git worktree 里完成，最后交付成 MR。

状态：**设计阶段**，尚未开始实现。

## 四份文档，四个问题

| 想知道 | 看 |
| --- | --- |
| 为什么这么设计 | [docs/yan-design.md](docs/yan-design.md) |
| 代码放在哪、谁能调谁、怎么测 | [docs/architecture.md](docs/architecture.md) |
| 按什么顺序做、每块必须自带哪些用例 | [docs/implementation-plan.md](docs/implementation-plan.md) |
| 某个决定是什么时候定的、当时手上有什么 | [docs/decisions.md](docs/decisions.md) |

`yan-design.md` 是主文档，其余三份都指向它。它开头有目录，
不用从头读——`design §2 三条判据` 和 `design §6 分支模型` 是理解其他所有节的前提。

## 约定

- 文档之间引用小节时写全：`design §7`、`architecture §5`。裸写的 `§x` 指本文档。
- `docs/` 也是设计讨论的工作区，讨论产生的 artifact（MD / HTML）都放这里。
