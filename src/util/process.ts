/**
 * What running another program leaves behind. Every seam that spawns one —
 * git in `util/git.ts`, `gh` / `glab` in `externals/remote-git`, `herdr` in
 * `externals/herdr` — hands back the same three fields, and a non-zero `code`
 * is a value at each of them rather than a throw.
 */
export interface ProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
