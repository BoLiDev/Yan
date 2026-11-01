/**
 * What the agent tab is showing while this page holds it: a light passes
 * over its name. Asked for less motion, the name is the brand's colour and
 * stays still.
 */
export const SHIMMER = [
  'bg-[linear-gradient(100deg,var(--brand)_0%,var(--brand)_38%,var(--brand-glint)_50%,var(--brand)_62%,var(--brand)_100%)]',
  'bg-size-[250%_100%] bg-position-[100%_0] bg-clip-text text-transparent animate-shimmer',
  'motion-reduce:animate-none motion-reduce:bg-none motion-reduce:text-brand',
].join(' ');

/**
 * A task whose agent is at work in its terminal: a light passes over its
 * title, in the title's own ink rather than the brand's, so a list of busy
 * tasks stays quiet to read. Asked for less motion, the title stays still.
 */
export const WORKING = [
  'bg-[linear-gradient(100deg,var(--ink)_0%,var(--ink)_40%,var(--ink-4)_50%,var(--ink)_60%,var(--ink)_100%)]',
  'bg-size-[250%_100%] bg-position-[100%_0] bg-clip-text text-transparent animate-shimmer',
  'motion-reduce:animate-none motion-reduce:bg-none motion-reduce:text-inherit',
].join(' ');
