/** Something new where it would otherwise be found by nobody. */
export function Dot({ title }: { title: string }) {
  return <span className="size-[7px] flex-none rounded-full bg-brand" title={title} />;
}
