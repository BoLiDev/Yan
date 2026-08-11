import { YanError, type YanErrorOptions } from '../../util/error.js';

/** What talking to the remote git host can fail with. */
const CODES = {
  usage: 'remote_git_usage',
  config: 'remote_git_config',
  failed: 'remote_git_failed',
} as const;

export type RemoteGitErrorKind = keyof typeof CODES;

export class RemoteGitError extends YanError {
  public static readonly codes = CODES;

  public constructor(kind: RemoteGitErrorKind, message: string, options?: YanErrorOptions) {
    super(CODES[kind], message, options);
  }

  /** The caller passed something impossible. Exit 2: a bug, not a condition. */
  public static usage(message: string): RemoteGitError {
    return new RemoteGitError('usage', message, { exitCode: 2 });
  }

  /** conf/config.json cannot be acted on. Exit 2: nothing will work until it is fixed. */
  public static config(message: string): RemoteGitError {
    return new RemoteGitError('config', message, { exitCode: 2 });
  }
}
