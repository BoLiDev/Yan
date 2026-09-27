/** Can a person answer a prompt right now? Asked of stdin only. */
export function isTty(): boolean {
  return process.stdin.isTTY === true;
}
