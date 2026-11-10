import { afterEach, describe, expect, it } from 'vitest';
import { forgetSpots, keepSpot, spotIn } from './reading';

const text = ['# Notes', '', 'The first part.', '', '## Retries', '', 'Each retry waits twice as long.', 'At most five.', '', '## Limits', '', 'None yet.'].join('\n');

describe('where a Markdown file was being read', () => {
  afterEach(forgetSpots);

  it('is nowhere for a file not read here', () => {
    expect(spotIn('t1/notes.md', text)).toBeNull();
  });

  it('is the same line, and as far into it, while the file is as it was', () => {
    keepSpot('t1/notes.md', text, 4.5);
    expect(spotIn('t1/notes.md', text)).toBe(4.5);
    expect(spotIn('t1/other.md', text), 'kept for its own file').toBeNull();
  });

  it('follows the words it was at when an agent writes above them', () => {
    keepSpot('t1/notes.md', text, 5.25);
    const grown = ['# Notes', '', 'A new opening.', '', 'Another paragraph,', 'over two lines.', '', ...text.split('\n').slice(2)].join('\n');
    expect(spotIn('t1/notes.md', grown)).toBe(5.25 + 5);
  });

  it('stays at the line it was at when the words there are gone, and inside the text', () => {
    keepSpot('t1/notes.md', text, 9);
    expect(spotIn('t1/notes.md', text.replace('## Limits', '## Bounds'))).toBe(9);
    expect(spotIn('t1/notes.md', '# Notes\n')).toBe(1);
  });

  it('of two places alike, takes the nearer', () => {
    const twice = [...text.split('\n'), '', '## Retries', '', 'Each retry waits twice as long.', 'At most five.'].join('\n');
    keepSpot('t1/notes.md', twice, 13);
    expect(spotIn('t1/notes.md', `# Intro\n\n${twice}`)).toBe(15);
  });
});
