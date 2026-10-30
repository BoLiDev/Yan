/**
 * What the agent tab shows while the task being read keeps no agent. yan
 * serve sends the tab beside it to each task's agent as the task is gone
 * to; for one with none it sends the tab here, so the tab never shows
 * another task's agent as if it were this one's.
 */

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

const CLOUD = '<path d="M17.5 19H8a6 6 0 1 1 5.66-8h1.84a4.5 4.5 0 0 1 2 8.5"/>';

export function noAgentPage(id: string, title: string | undefined): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(id)} · 没有 Agent</title>
<style>
@font-face{font-family:"Yan Round";src:local("ChillRoundFRegular"),local("ChillRoundF Regular"),url("/fonts/yan-round-regular.woff2") format("woff2");font-weight:400}
@font-face{font-family:"Yan Round";src:local("ChillRoundFBold"),local("ChillRoundF Bold"),url("/fonts/yan-round-bold.woff2") format("woff2");font-weight:700}
html,body{height:100%;margin:0}
body{display:flex;align-items:center;justify-content:center;background:#fff;color:#66655f;font:15px/1.5 "Yan Round",system-ui,sans-serif;text-align:center}
main{padding:40px;max-width:420px}
svg{color:#a3a29b}
h1{margin:10px 0 4px;font-size:18px;color:#1b1b19}
p{margin:0}
.hint{margin-top:16px;font-size:13px;color:#8d8c86}
</style>
</head>
<body>
<main>
<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${CLOUD}</svg>
<h1>${esc(id)} 没有 Agent</h1>
${title ? `<p>${esc(title)}</p>\n` : ''}<p class="hint">切到有 Agent 的任务时，这里会跟着换过去</p>
</main>
</body>
</html>
`;
}
