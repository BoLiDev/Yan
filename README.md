# `yan`

A work orchestration system for one person: you describe something that needs doing, `yan`
breaks it into pieces that can be handed out, each piece goes to a single-use sub-agent
working in an isolated git worktree, and the result is delivered as a merge request.

Status: **design**. Implementation has not started.

## Where to start reading

The backbone of the MVP technical design is [docs/mvp/td/INDEX.md](docs/mvp/td/INDEX.md). It walks through
the system one part at a time, and the details of each part live in a separate document
under `docs/mvp/td/`.

The other documents, listed by the question they answer:

| Question | Document |
| --- | --- |
| Why is it designed this way, and what is each part responsible for | [docs/mvp/td/INDEX.md](docs/mvp/td/INDEX.md) |
| The full argument for one part (memory, agents, supervision, branching, worktrees, delivery, boundaries, scope) | the matching file under `docs/mvp/td/`; every section of INDEX ends with a link |
| Where the code goes, what may call what, and how it is tested | [docs/mvp/td/architecture.md](docs/mvp/td/architecture.md) |

## Conventions

- The MVP technical design (`td`) is split by topic across `docs/mvp/td/`. Section numbers are part of each
  heading, and one numbering scheme runs across all of the files, so a given section number
  appears exactly once in the whole set. A reference from one `td` file to another
  therefore gives only the section number plus a link to click, and the reader does not have
  to know which file that section lives in.
- A reference that crosses out of `td` says which document and which section: the
  document name followed by the section number, again with a link. For example
  [`architecture.md` §3](docs/mvp/td/architecture.md#3-repository-layout).
  Keeping the document name and the anchor together stops the two from drifting apart.
- Documents that do not share `td`'s numbering are the exception when they point into
  it: they use the prefix `td` instead of a file name, for example
  [td §7](docs/mvp/td/worktree.md#7-worktrees). Since the section numbers run
  across every file, the number alone is enough to identify the section, and the link answers
  which file it is in.
- A bare section number with no link refers to a section of the current document. References
  within a single document are always written this way. `docs/mvp/td/architecture.md` (1–7)
  carries its own numbering and says so at the top.
- `docs/` is also the working area for design discussions. Anything a discussion produces
  (Markdown or HTML) goes here.
