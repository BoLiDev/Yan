/**
 * Small copies of a task's pictures, for every place the page shows one
 * small: a row of a list, a card of a folder's grid. A screenshot shown 30 px
 * wide from its own 2880 × 2000 pixels costs the browser 23 MB decoded; a
 * folder of them is more than Chrome keeps, so it decodes them again on
 * every redraw and each click waits for that. A copy is made once per blob
 * and size, and kept for as long as the server runs; the browser keeps it
 * for good, since a blob never changes.
 */

/** A row's copy fills a 30 × 22 box cropped, so its shorter side is enough; a card's is shown whole, so its longer side is. */
export const THUMB_SIZES = {
  row: { width: 72, height: 72, fit: 'outside' },
  card: { width: 520, height: 520, fit: 'inside' },
} as const;
export type ThumbSize = keyof typeof THUMB_SIZES;

/** Enough for every picture of the tasks a person looks at in a sitting; the oldest made goes first. */
const KEPT = 2000;

type Sharp = typeof import('sharp').default;
let loaded: Promise<Sharp | undefined> | undefined;

/** sharp, loaded the first time a copy is asked for: every other command of yan does without it. */
function sharp(): Promise<Sharp | undefined> {
  return (loaded ??= import('sharp').then((m) => m.default, () => undefined));
}

export class Thumbs {
  private readonly made = new Map<string, Promise<Buffer | undefined>>();

  /** The copy of `bytes` at `size`, as WebP; undefined for what sharp cannot read, which is then shown as it is. */
  public of(sha: string, size: ThumbSize, bytes: () => Promise<Buffer | undefined>): Promise<Buffer | undefined> {
    const key = `${size}:${sha}`;
    let copy = this.made.get(key);
    if (copy === undefined) {
      copy = (async () => {
        const [lib, original] = await Promise.all([sharp(), bytes()]);
        if (lib === undefined || original === undefined) return undefined;
        // The first frame of an animation, turned as its camera held it, never larger than it is.
        return lib(original, { limitInputPixels: 1e8 })
          .rotate()
          .resize({ ...THUMB_SIZES[size], withoutEnlargement: true })
          .webp({ quality: 78 })
          .toBuffer()
          .catch(() => undefined);
      })();
      this.made.set(key, copy);
      if (this.made.size > KEPT) this.made.delete(this.made.keys().next().value as string);
    }
    return copy;
  }
}
