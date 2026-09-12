/**
 * One indexed markdown file — a skill, or a learning. Only its front matter is
 * read: what the file says is for whoever opens it, and an index that carried
 * the text would be the file.
 */
export interface Indexed {
  /** Relative to the directory it was found in, so it can be opened. */
  readonly path: string;
  /** From the front matter, or the file name when it declares none. */
  readonly name: string;
  /** From the front matter. Empty when it declares none. */
  readonly description: string;
}
