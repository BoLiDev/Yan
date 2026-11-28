# What the modern toolchain can carry today

Research for ticket #103 (map #101). Facts as of 2026-11-28, from primary
sources: the projects' own announcements and docs, their GitHub repositories,
and the npm registry. It states readiness; it does not choose.

Where a claim could not be confirmed from a primary source it says so.

## Short answer

- **Vite on Rolldown is the stable default, and has been since March.** Vite 8
  (2026-03-12) has Rolldown as its only bundler and Oxc as its transformer;
  Rolldown itself went 1.0 on 2026-05-07. Current: vite 8.4.0, rolldown 1.3.4.
- **TypeScript 7 (the native compiler) is stable as `typescript@7.0.2`**
  (2026-07-08): checking, emit, declarations, `--build`, watch and incremental
  are all done. What it lacks is a programmatic API, which arrives in 7.1
  (beta 2026-10-20, RC due about now, not yet released).
- **oxlint is stable (1.95.0) and its type-aware linting is stable**
  (2026-07-22, 60 of 62 typescript-eslint type-aware rules). JS plugins
  (custom rules, ESLint plugins) are still alpha. **oxfmt is still 0.x**
  (0.80.0, beta since 2026-02-24).
- **Vitest 5** (2026-09-03, now 5.1.2) runs on Vite 6.4 to 8 and needs
  Node >= 22.12.
- **tsdown, the Rolldown bundler for a Node library or CLI, is still 0.x**
  (0.23.7).
- **No Vercel UI library fits a page that hosts a real terminal.** AI SDK UI
  is chat-state hooks; AI Elements is a chat component set whose "Terminal"
  only displays ANSI output, and Vercel's AI Elements is being retired at the
  end of this month in favour of a shadcn/ui version; Streamdown is the one
  piece usable alone, for Markdown, and its distinctive part is streaming.

**This repository is already on most of it**: `package.json` pins
vite 8.3.5, typescript 7.0.2, vitest 5.0.5, oxlint 1.90.0 and
@vitejs/plugin-react 6.1.2. See "What would change here".

## Versions on npm, 2026-11-28

| Package | Latest | Notes |
|---|---|---|
| vite | 8.4.0 | 8.0 on 2026-03-12; 8.1 on 2026-06-23 |
| rolldown | 1.3.4 | 1.0 on 2026-05-07 |
| @vitejs/plugin-react | 6.3.0 | v6 uses Oxc, no Babel |
| tsdown | 0.23.7 | released 2026-11-06 |
| typescript | 7.0.2 (`latest`) | `beta` 7.1.0-beta, `next` 7.1.0-dev.20261127.1, no 7.1 RC tag |
| @typescript/typescript6 | 6.0.2 | TS 6 side by side: `tsc6` and the old API |
| oxlint | 1.95.0 | weekly releases |
| oxlint-tsgolint | 7.0.2009 | tracks TypeScript 7.0.2 |
| oxfmt | 0.80.0 | |
| vitest | 5.1.2 | |
| vite-plus | 1.8.0 | VoidZero's all-in-one, see below |
| ai / @ai-sdk/react | 7.0.184 / 4.0.189 | |
| streamdown | 2.8.1 | |
| ai-elements (CLI) | 1.9.1 | last published 2026-10-14 |

Source: `npm view <package> version dist-tags`, and the GitHub releases of
oxc-project/oxc, rolldown/tsdown, voidzero-dev/vite-plus.

## Vite and Rolldown

**Stable, and not optional.** "Vite 8 ships with Rolldown as its single,
unified, Rust-based bundler." Before it, esbuild did dev transforms and
dependency pre-bundling and Rollup did the production build; Rolldown and Oxc
now do both. Requires Node 20.19+ or 22.12+. Vite 8 is about 15 MB larger to
install than Vite 7 (Lightning CSS, now a normal dependency, and the Rolldown
binary). [Vite 8 announcement](https://vite.dev/blog/announcing-vite8)

**Rolldown 1.0** (2026-05-07) locked the `^1.0.0` API under semver: option
names, types and plugin hook signatures. Excluded from that promise: features
marked experimental, which the announcement names as watch mode, native
MagicString and lazy barrel optimisation; and "output behavior may still
change" (chunking, dead-code and inlining heuristics).
[Rolldown 1.0](https://voidzero.dev/posts/announcing-rolldown-1-0)

**What it does not do that Rollup/esbuild did**, from the
[migration guide](https://vite.dev/guide/migration):

- `build.rollupOptions` is renamed `rolldownOptions`; the object form of
  `manualChunks` is gone, the function form deprecated for `codeSplitting`.
- Oxc does not lower native decorators; `esbuild.supported`, property mangling
  and `build.commonjsOptions` have no effect or no equivalent.
- Rollup hooks not supported: `shouldTransformCachedModule`,
  `resolveImportMeta`, `renderDynamicImport`, `resolveFileUrl`. Parallel hooks
  run sequentially. `system` and `amd` output are gone.
- CommonJS default-import interop changed (a `legacy.inconsistentCjsInterop`
  flag restores the old way for now).
- tsconfig `paths` are resolved only when `resolve.tsconfigPaths: true` is
  set; it is off by default.

Still experimental in Vite itself: full bundle mode in dev (added
experimentally in 8.1), and the Environment API is "still being stabilized".

**@vitejs/plugin-react 6** does React Refresh through Oxc and drops Babel; the
React Compiler is reached through `reactCompilerPreset` and
`@rolldown/plugin-babel`.

### tsdown, for the CLI

tsdown is "the elegant library bundler", an official Rolldown project, for
TypeScript libraries and by extension a CLI: ESM/CJS output, tree-shaking,
`.d.ts` generation and bundling, shims, an executable option, package-exports
generation. [tsdown guide](https://tsdown.dev/guide/)

- **It is 0.23.7, not 1.0.** The docs do not call it stable.
- Declarations come from rolldown-plugin-dts: with `isolatedDeclarations` on
  it uses oxc-transform; otherwise it falls back to the TypeScript compiler,
  and `typescript` must be installed.
  [tsdown dts](https://tsdown.dev/options/dts)
- Not confirmed: whether that fallback works against TypeScript 7.0, which
  ships no API. The page says nothing on TypeScript 7. A CLI that publishes no
  types (this one sets `declaration: false`) does not meet the question.

Rolldown can also be used directly, or Vite in library/SSR build mode; neither
adds anything tsdown does not for this shape.

### Vite+

VoidZero's `vite-plus` (1.8.0, weekly releases) wraps Vite, Vitest, Oxlint,
Oxfmt, Rolldown, tsdown and a task runner behind one `vp` CLI: `vp dev`,
`build`, `test`, `lint`, `fmt`, `check` (format, lint and type checks
together), `pack` (libraries and standalone artifacts), `run`. It also manages
Node and the package manager. It is the same tools under one config, not
different ones. [Vite+ guide](https://viteplus.dev/guide/)

## TypeScript 7

**Released 2026-07-08 as `typescript@7.0.2`**, binary `tsc` (the previews'
`tsgo` name and `@typescript/native-preview` package are over). It is the Go
port, about 10x faster. No 7.0.x patch has followed; nightlies are
`typescript@next`.
[Announcing TypeScript 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)

**Done**, by the port's own status table (microsoft/typescript-go README, the
staging repo, now closed and folded back into microsoft/TypeScript): program
creation, parsing, type checking ("same errors, locations, and messages as TS
6.0"), JSX, declaration emit, JS emit, watch mode, build mode and project
references, incremental build. New flags `--checkers` and `--builders`
parallelise checking and project-reference builds.

**Missing or different in 7.0:**

- **No programmatic API.** "While TypeScript 7.0 is here, it does not ship
  with an API." Anything that imports `typescript` to use the compiler
  (typescript-eslint, ts-morph, API-based dts bundlers, some loaders) cannot
  run on 7.0; the supported route is `@typescript/typescript6`, which
  re-exports the 6.0 API and a `tsc6` binary, aliased in as `typescript` for
  such tools.
- **No language-service plugins or embedded languages**: Vue, MDX, Astro,
  Svelte and Angular templates stay on 6.0 in the editor. Not relevant to a
  plain React page.
- **Removed options are hard errors**: `baseUrl`, `downlevelIteration`,
  `moduleResolution: node`/`node10`/`classic`, `module: amd/umd/systemjs/none`,
  `target: es5`. `strict` now defaults to true.
- JS-file declaration emit differs on purpose; error messages may print types
  differently.
- **Editor**: the language server is a new LSP implementation, listed "in
  progress, nearly all features implemented" in the port's table. In VS Code
  it came as the extension `TypeScriptTeam.native-preview`, with the
  announcement saying it "will ship as part of VS Code itself" in the
  following weeks. Whether it is now VS Code's built-in default was not
  confirmed from a VS Code release note.

**7.1** ([beta, 2026-10-20](https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/))
brings the API, new and not the old one: entry points `typescript/sync`,
`typescript/async`, `typescript/fs`, `typescript/ast` (with `/is` and
`/factory`), snapshot-based. It has no file watching of its own. It also adds
"content mappers", the replacement for embedded-language plugins (Volar's
model), plus `--target es2026`. The post put the RC "in about a month" and the
final "shortly thereafter"; as of 2026-11-28 npm has no 7.1 RC.

So for a project that only runs `tsc` to check and emit, 7.0 lacks nothing.
The gap is entirely for tools that embed the compiler, and they must be
rewritten against the 7.1 API, not merely upgraded.

## oxlint and oxfmt

**oxlint** has been 1.x since 2025-06-10 and is at 1.95.0. Native plugins, by
the ESLint plugin each covers: `eslint`, `typescript`, `unicorn`, `oxc` (on by
default), and `react`, `react-perf`, `nextjs`, `import`, `jsdoc`, `jsx-a11y`,
`node`, `promise`, `jest`, `vitest`, `vue`. Setting `plugins` replaces the
default set. [Built-in plugins](https://oxc.rs/docs/guide/usage/linter/plugins)

- **React**: the `react` plugin covers eslint-plugin-react,
  eslint-plugin-react-hooks and eslint-plugin-react-refresh.
  `react-hooks/rules-of-hooks` and `react-hooks/exhaustive-deps` are what this
  repository already runs. The **React Compiler rules** are implemented
  natively too ("run the React Compiler's analysis in lint-only mode") but are
  "experimental and off by default".
- **Type-aware linting is stable** since
  [2026-07-22](https://oxc.rs/blog/2026-07-22-type-aware-linting-stable):
  `oxlint --type-aware` with the separate package `oxlint-tsgolint`, which is
  built on TypeScript 7 and versioned with it (7.0.2009 = patch 9 for TS
  7.0.2). It covers 60 of typescript-eslint's 62 type-aware rules (59 of 61
  at the announcement); the two missing are not named in the docs. A second
  backend, `tsrs`, a Rust port based on TypeScript 7.1, is used automatically
  when installed. Legacy tsconfig options such as `baseUrl` are not supported.
  [Type-aware docs](https://oxc.rs/docs/guide/usage/linter/type-aware)
- **`--type-check`** reports compiler errors in the same run, sharing one
  program with the lint. It is not a full replacement for `tsc --noEmit`: it
  "reports type errors only in files Oxlint lints".
- **JS plugins are alpha** (since 2026-03-11, still described as alpha in the
  docs): ESLint v9-compatible plugins and one's own rules, through
  `jsPlugins`. "Almost the entirety of ESLint's plugin API is now
  implemented", including fixes, scope analysis, code paths and editor
  diagnostics. Not supported: custom parsers and file formats, and **rules
  that need type information**, so a custom rule cannot be type-aware.
  [JS plugins](https://oxc.rs/docs/guide/usage/linter/js-plugins)

What ESLint still does that oxlint does not: custom type-aware rules, custom
parsers, and a stable plugin API. For built-in rules on TypeScript and React
the coverage is near complete.

**oxfmt** is 0.80.0: alpha 2025-12-01, [beta 2026-02-24](https://oxc.rs/blog/2026-02-24-oxfmt-beta),
no 1.0 or RC announced. It takes Prettier's output as its baseline and is
tested against Prettier's own suite; differences not on its list of deliberate
divergences are treated as bugs. Built in, where Prettier needs plugins:
import sorting, Tailwind class sorting, `package.json` field sorting, embedded
CSS-in-JS and GraphQL. It formats JS/TS/JSX, JSON, YAML, TOML, HTML, CSS,
Markdown and more. What stands between it and 1.0, by the beta post, is
Prettier plugin support and remaining options; the docs still say to stay on
Prettier "if you still depend on exact plugin behavior not yet covered".
[Formatter docs](https://oxc.rs/docs/guide/usage/formatter)

## Vitest

[Vitest 5](https://vitest.dev/blog/vitest-5) (2026-09-03) "requires Vite >=
6.4.0 and Node.js >= 22.12.0"; its peer range is `^6.4.0 || ^7.0.0 || ^8.0.0`,
so on Vite 8 it transforms through Oxc and Rolldown with nothing extra.
Breaking changes worth knowing: `clearMocks` defaults to true, unawaited
`resolves`/`rejects` fail the test, browser-mode locators are strict. Browser
mode gained a trace view and speed.

Vitest does not type-check tests as it runs them (Oxc strips types), on any
TypeScript version. Its separate `--typecheck` mode shells out to `tsc` or
`vue-tsc` and parses the output; the docs do not mention TypeScript 7, and
whether its output parsing holds against TS 7's `tsc` was not confirmed. A
plain `tsc --noEmit` over the tests, as this repository does, is unaffected.

## A Vercel UI library for a page that hosts a terminal

The three candidates, and what each is:

- **AI SDK UI** (`@ai-sdk/react`, with `ai` 7): hooks, `useChat`,
  `useCompletion`, `useObject`, that hold chat messages and streaming state
  for a model endpoint. It draws nothing.
  [AI SDK UI](https://ai-sdk.dev/docs/ai-sdk-ui/overview) It brings a page
  nothing unless the page itself talks to a model through the AI SDK's stream
  protocol.
- **AI Elements** (Vercel): about 50 shadcn-registry components: chat
  (Conversation, Message, Prompt Input, Reasoning, Tool, Plan, Queue...), code
  (Code Block, File Tree, Stack Trace, Test Results, Terminal, Web
  Preview...), voice, and workflow canvas. Two facts decide it:
  - Its **Terminal is a display, not a terminal**: "displays console output
    with ANSI color support, streaming indicators, and auto-scroll", from an
    `output` string, parsed with `ansi-to-react`. No input, no cursor
    addressing, no resize, no PTY. It cannot stand in for xterm.js hosting a
    live program. [Terminal](https://elements.ai-sdk.dev/components/terminal)
  - **It is being retired.** The repository's README: "AI Elements is moving
    to shadcn/ui. This project will be deprecated at the end of November 2026
    and replaced by AI Elements from shadcn/ui." Its prerequisites also name a
    Next.js project with the AI SDK installed.
    [vercel/ai-elements](https://github.com/vercel/ai-elements)
- **AI Elements from shadcn/ui**, the successor: 23 "patterns for agentic
  interfaces, built from shadcn/ui components". "There is no package to
  install. The code is yours": patterns are copied in, their supporting
  components added with the shadcn CLI. Its docs sit under a `base/` path,
  which suggests Base UI variants. Its Terminal is again "a command the agent
  runs, with its output as it streams". This is shadcn's, not Vercel's.
  [shadcn AI Elements](https://ui.shadcn.com/docs/ai-elements)
- **Streamdown** (2.8.1): a React Markdown renderer, "a drop-in replacement
  for react-markdown, designed for AI-powered streaming": it completes
  unterminated syntax as text arrives, with code, math, Mermaid and CJK as
  optional plugin packages (`@streamdown/code`, ...). Needs React (19.1.1+
  stated, 18+ compatible) and Tailwind, with an `@source` line pointing
  Tailwind at its `dist/`. It needs neither the AI SDK nor a chat.
  [Streamdown](https://streamdown.ai/docs/getting-started)

**Fit.** For the terminal itself, none: every "terminal" here is a read-only
log view, and a hosted terminal stays on xterm.js. For the rest of a page that
is not a chat, AI SDK UI and the chat half of AI Elements have nothing to
attach to. What could carry over:

- Streamdown, as the Markdown renderer, where the page shows Markdown. Its
  particular strength, half-arrived text, matters only if Markdown is shown
  while still being written; for finished files it is one more renderer.
- Single display patterns from the shadcn successor (code block, file tree,
  test results, stack trace, plan, queue), copied in as source, with no
  dependency on Vercel or the AI SDK.

## What would change here

Read from `package.json`, the two `tsconfig`s, `web/vite.config.ts`,
`vitest.config.ts` and `.oxlintrc.json` at the time of writing.

Already in place, so nothing to adopt:

- **Vite 8.3.5 on Rolldown**, with @vitejs/plugin-react 6.1.2 and
  @tailwindcss/vite. The config uses nothing the migration guide removes.
- **TypeScript 7.0.2**: `tsc -p tsconfig.json` emits the CLI into `dist/`,
  and `tsc` type-checks the tests and the page. The configs use no removed
  option (`paths` without `baseUrl`, `nodenext` and `bundler` resolution).
  Nothing in the build imports the compiler API.
- **Vitest 5.0.5**, node and browser (Playwright) projects.
- **oxlint 1.90.0**, on `web/src` only, with the `react`, `typescript` and
  `oxc` plugins, `correctness` as errors, the two hooks rules and `max-lines`.

Not in place, and what each is today:

| Not used here now | State | Note |
|---|---|---|
| A formatter | oxfmt 0.80.0, beta | The repository has no formatter at all |
| Type-aware lint | stable | Needs `oxlint-tsgolint`; `--type-check` could fold in the page's `tsc` pass, for linted files only |
| Lint of `src/` and `tests/` | stable | oxlint runs on `web/src` only |
| React Compiler lint rules | experimental, off by default | |
| Custom lint rules (the module-boundary check is a script, `scripts/check-module-boundaries.mjs`) | JS plugins alpha | Cannot be type-aware |
| Bundling the CLI (it is emitted file-for-file by `tsc`) | tsdown 0.23.7, pre-1.0 | `bin/yan.mjs` spawns `dist/cli/yan.js`, and tests run against `dist/` |
| TypeScript compiler API | 7.1 beta | Nothing here uses it |
| One CLI over all of it | vite-plus 1.8.0 | Same tools |

One mismatch in the present setup: `engines.node` is `>=20.12.0`, while
Vite 8 needs 20.19+ or 22.12+ and Vitest 5 needs 22.12+. That binds building
and testing, not running the built CLI.

## Not confirmed

- Whether VS Code now ships the TypeScript 7 language server as its built-in
  default.
- Whether tsdown's non-isolated declaration path, and Vitest's `--typecheck`,
  work against TypeScript 7.0.
- The names of the two typescript-eslint type-aware rules oxlint lacks.
- Whether the shadcn AI Elements patterns come in both Radix and Base UI
  forms; only the `base/` path was seen.
- The date a 7.1 RC or final will land; the only statement is the beta post's
  "about a month".
