/**
 * What a context remembers between sessions, as an index: the skills `user`
 * wrote for this environment, and `mem/learnings/`. Reads only front matter —
 * a file's text is for whoever opens it.
 */

export { readLearnings, readSkills } from './memory.js';
export { frontMatter } from './front-matter.js';
export type { Indexed } from './types.js';
