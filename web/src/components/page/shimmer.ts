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
