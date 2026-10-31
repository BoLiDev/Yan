import hljs from 'highlight.js/lib/common';
import type { LanguageFn } from 'highlight.js';
import { baseName, ext } from './files';

/**
 * Colour by language. highlight.js's common languages come with the page;
 * one outside them that a file here can be in is loaded the first time a
 * file needs it, and a file whose language is not known, or too long to
 * colour quickly, stays plain. The colours are the page's own, `.hljs-*` in
 * index.css, chosen to read on the add and del tints as well.
 */

const LANGS: Record<string, string> = {
  javascript: 'js mjs cjs jsx',
  typescript: 'ts tsx mts cts',
  json: 'json jsonl jsonc json5',
  css: 'css',
  scss: 'scss',
  less: 'less',
  xml: 'xml html htm xhtml svg vue svelte xsl plist',
  python: 'py pyi',
  bash: 'sh bash zsh env',
  powershell: 'ps1 psm1',
  dos: 'bat cmd',
  ruby: 'rb rake gemspec',
  go: 'go',
  rust: 'rs',
  java: 'java',
  kotlin: 'kt kts',
  swift: 'swift',
  c: 'c h',
  cpp: 'cpp cc cxx hpp hh hxx',
  csharp: 'cs',
  objectivec: 'm mm',
  php: 'php',
  perl: 'pl pm',
  lua: 'lua',
  r: 'r',
  dart: 'dart',
  scala: 'scala sbt',
  elixir: 'ex exs',
  erlang: 'erl',
  haskell: 'hs',
  clojure: 'clj cljs edn',
  ocaml: 'ml mli',
  julia: 'jl',
  yaml: 'yaml yml',
  ini: 'ini toml cfg',
  sql: 'sql',
  graphql: 'graphql gql',
  protobuf: 'proto',
  diff: 'diff patch',
  makefile: 'mk',
  cmake: 'cmake',
  dockerfile: 'dockerfile',
  nginx: 'nginx',
  markdown: 'md markdown',
  latex: 'tex',
  vim: 'vim',
  groovy: 'groovy gradle',
};
const LANG_OF_EXT: Record<string, string> = {};
for (const [lang, list] of Object.entries(LANGS)) for (const e of list.split(' ')) LANG_OF_EXT[e] = lang;

/** Files known by their whole name rather than an extension. */
const LANG_OF_NAME: Record<string, string> = {
  makefile: 'makefile', gnumakefile: 'makefile', dockerfile: 'dockerfile', containerfile: 'dockerfile', 'cmakelists.txt': 'cmake',
  '.bashrc': 'bash', '.bash_profile': 'bash', '.zshrc': 'bash', '.zprofile': 'bash', '.profile': 'bash',
  '.npmrc': 'ini', '.gitconfig': 'ini', '.editorconfig': 'ini', '.gitignore': 'plaintext', '.gitattributes': 'plaintext',
};

/** The languages above that highlight.js's common set leaves out, each its own chunk of the build. */
const MORE: Record<string, () => Promise<{ default: LanguageFn }>> = {
  powershell: () => import('highlight.js/lib/languages/powershell'),
  dos: () => import('highlight.js/lib/languages/dos'),
  dart: () => import('highlight.js/lib/languages/dart'),
  scala: () => import('highlight.js/lib/languages/scala'),
  elixir: () => import('highlight.js/lib/languages/elixir'),
  erlang: () => import('highlight.js/lib/languages/erlang'),
  haskell: () => import('highlight.js/lib/languages/haskell'),
  clojure: () => import('highlight.js/lib/languages/clojure'),
  ocaml: () => import('highlight.js/lib/languages/ocaml'),
  julia: () => import('highlight.js/lib/languages/julia'),
  protobuf: () => import('highlight.js/lib/languages/protobuf'),
  cmake: () => import('highlight.js/lib/languages/cmake'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  nginx: () => import('highlight.js/lib/languages/nginx'),
  latex: () => import('highlight.js/lib/languages/latex'),
  vim: () => import('highlight.js/lib/languages/vim'),
  groovy: () => import('highlight.js/lib/languages/groovy'),
};

/** highlight.js's name for the language of a file, or null when it is not known here. */
export function langOf(path: string): string | null {
  const n = baseName(path).toLowerCase();
  return LANG_OF_NAME[n] ?? LANG_OF_EXT[ext(n)] ?? null;
}

/** The language a fenced block names: highlight.js's own names and aliases, or an extension. */
export function langOfFence(info: string | undefined): string | null {
  if (!info) return null;
  return hljs.getLanguage(info) ? info : LANG_OF_EXT[info] ?? LANG_OF_NAME[info] ?? null;
}

/** Whether `lang` can be coloured now, without loading anything. */
export const langLoaded = (lang: string | null): boolean => !lang || !!hljs.getLanguage(lang);

const loads = new Map<string, Promise<void>>();
/** Resolves once highlight.js can colour `lang`, or once it is clear that it cannot. */
export function langReady(lang: string | null): Promise<void> {
  if (!lang || hljs.getLanguage(lang)) return Promise.resolve();
  let p = loads.get(lang);
  if (!p) {
    const load = MORE[lang];
    p = load ? load().then((m) => hljs.registerLanguage(lang, m.default), () => undefined) : Promise.resolve();
    loads.set(lang, p);
  }
  return p;
}

/** Long enough for any file a person reads in colour; past it, plain text comes faster. */
const COLOUR_LIMIT = 400_000;

/**
 * `text` coloured as `lang`, one HTML string per line, or null when it
 * cannot be. The whole text is coloured at once, so a comment or a string
 * that runs over several lines is right on every one of them; the markup is
 * then cut at each newline, closing every span still open and reopening it
 * on the next line.
 */
export function colourLines(lang: string | null, text: string): string[] | null {
  if (!lang || !hljs.getLanguage(lang) || text.length > COLOUR_LIMIT) return null;
  let html: string;
  try {
    html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
  const lines: string[] = [];
  const open: string[] = [];
  let line = '';
  for (const piece of html.match(/<span class="[^"]*">|<\/span>|\n|[^<\n]+/g) ?? []) {
    if (piece === '\n') {
      lines.push(line + '</span>'.repeat(open.length));
      line = open.join('');
    } else {
      if (piece === '</span>') open.pop();
      else if (piece.startsWith('<span')) open.push(piece);
      line += piece;
    }
  }
  lines.push(line + '</span>'.repeat(open.length));
  return lines.length === text.split('\n').length ? lines : null;
}
