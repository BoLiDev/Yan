import { RemoteGit, type MrRef, type MrState } from '../../externals/remote-git/index.js';

/**
 * How a command asks the forge what state one merge request is in. Every
 * command that asks takes one of these as its injection point, and the tests
 * hand in a fake of the same shape.
 */
export type MrStateReader = (ref: MrRef) => MrState;

/**
 * The real forge. `RemoteGit.mrState` itself never throws for an unreachable
 * host, but building a `RemoteGit` does when no forge is configured, and a
 * missing `mr` or a `dir` that is not a directory is a usage error.
 */
export const remoteMrState: MrStateReader = (ref) => new RemoteGit().mrState(ref);

/**
 * The state, with anything thrown on the way turned into `unknown` - for a
 * caller that goes on without the answer rather than failing on it.
 *
 * @param read defaults to the real forge.
 */
export function mrStateOrUnknown(ref: MrRef, read: MrStateReader = remoteMrState): MrState {
  try {
    return read(ref);
  } catch {
    return 'unknown';
  }
}
