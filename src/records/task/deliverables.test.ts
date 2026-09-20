import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Deliverables, Task, deliverableAside, readDeliverables, refLink, type DeliverableFile } from './index.js';
import { cleanupTempDirs, mkTempDir, mkYanHome } from '../../../tests/helpers/fixtures.js';
import { YanError } from '../../util/error.js';

/**
 * `deliverable.json`. Three claims: a file yan does not understand is a
 * refusal that says what is wrong with it rather than a repair; an id is
 * never handed out twice, whatever has been removed; and the reader the work
 * report uses cannot throw, whatever is on disk.
 */

let home = '';
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.YAN_HOME;
  home = mkYanHome(mkTempDir());
  process.env.YAN_HOME = home;
  Task.create('t042', 'unify the auth header');
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previousHome;
});

afterAll(cleanupTempDirs);

const record = (): Deliverables => new Deliverables('t042');

function onDisk(): DeliverableFile {
  return JSON.parse(readFileSync(record().file, 'utf8')) as DeliverableFile;
}

/** Put a document on disk that only a hand could have written. */
function write(doc: unknown): void {
  writeFileSync(record().file, `${JSON.stringify(doc, null, 2)}\n`);
}

/** The refusal's message, or '' when there was none. */
function refusal(fn: () => unknown): string {
  try {
    fn();
    return '';
  } catch (err) {
    expect(err).toBeInstanceOf(YanError);
    return (err as YanError).message;
  }
}

describe('reading', () => {
  it('reads a missing file as an empty list, not an error', () => {
    rmSync(record().file);
    expect(record().exists()).toBe(false);
    expect(record().read()).toEqual({ version: 1, nextId: 1, deliverables: [] });
    expect(readDeliverables('t042')).toEqual({ deliverables: [], problem: null });
  });

  it('is created empty by Task.create, and init leaves an existing file alone', () => {
    record().add(['one']);
    record().init();
    expect(record().read().deliverables).toHaveLength(1);
  });

  it('names the file and what is wrong with it, for each shape it will not take', () => {
    const cases: [unknown, string][] = [
      [[], 'the top level is not an object'],
      [{ version: 2, nextId: 1, deliverables: [] }, 'version is 2'],
      [{ version: 1, nextId: 1 }, '"deliverables" is missing'],
      [{ version: 1, nextId: 1, deliverables: [{ id: 'd1', text: 'x', status: 'shipped' }] }, 'status "shipped"'],
      [{ version: 1, nextId: 1, deliverables: [{ id: 'd1', text: 'x', status: 'abandoned' }] }, 'gives no reason'],
      [{ version: 1, nextId: 1, deliverables: [{ id: 'd1', text: 'x', status: 'done' }] }, 'doneAt'],
      [
        { version: 1, nextId: 1, deliverables: [{ id: 'd1', text: 'x', status: 'done', doneAt: '2026-02-30' }] },
        'doneAt is "2026-02-30"',
      ],
      [
        {
          version: 1,
          nextId: 3,
          deliverables: [{ id: 'd1', text: 'x', status: 'todo' }, { id: 'd1', text: 'y', status: 'todo' }],
        },
        'share the id d1',
      ],
      [{ version: 1, nextId: 1, deliverables: [{ text: 'x', status: 'todo' }] }, 'has no id'],
      [{ version: 1, nextId: 1, deliverables: [{ id: 'd1', text: '  ', status: 'todo' }] }, 'd1 has no text'],
    ];
    for (const [doc, says] of cases) {
      write(doc);
      const message = refusal(() => record().read());
      expect(message, JSON.stringify(doc)).toContain(says);
      expect(message, 'the refusal names the file').toContain('deliverable.json');
    }
  });

  it('refuses a file that is not JSON at all', () => {
    writeFileSync(record().file, 'not json\n');
    expect(refusal(() => record().read())).toContain('not valid JSON');
  });

  it('hands a reader that must not fail the problem instead of throwing', () => {
    write({ version: 1, nextId: 1, deliverables: [{ id: 'd1', text: 'x', status: 'shipped' }] });
    const said = readDeliverables('t042');
    expect(said.deliverables).toEqual([]);
    expect(said.problem).toContain('status "shipped"');
    // …and for a task that is not a task at all, or a vault that is not there.
    expect(readDeliverables('t999').problem).toBe(null);
    expect(readDeliverables('has space').deliverables).toEqual([]);
  });

  it('derives nextId from the ids when the file does not state a usable one', () => {
    write({ version: 1, deliverables: [{ id: 'd1', text: 'x', status: 'todo' }, { id: 'd7', text: 'y', status: 'todo' }] });
    expect(record().read().nextId).toBe(8);
    write({ version: 1, nextId: 2, deliverables: [{ id: 'd9', text: 'x', status: 'todo' }] });
    expect(record().read().nextId, 'a stated nextId below the highest id would reuse one').toBe(10);
  });
});

describe('writing', () => {
  it('appends in the order given, numbering from nextId', () => {
    expect(record().add(['first', 'second']).map((d) => d.id)).toEqual(['d1', 'd2']);
    record().add(['third']);
    expect(onDisk()).toEqual({
      version: 1,
      nextId: 4,
      deliverables: [
        { id: 'd1', text: 'first', status: 'todo' },
        { id: 'd2', text: 'second', status: 'todo' },
        { id: 'd3', text: 'third', status: 'todo' },
      ],
    });
  });

  it('never hands out an id again after rm', () => {
    record().add(['first', 'second']);
    record().rm('d2');
    expect(onDisk().nextId).toBe(3);
    expect(record().add(['third'])[0]?.id).toBe('d3');
    expect(onDisk().deliverables.map((d) => d.id)).toEqual(['d1', 'd3']);
  });

  it('rewords one without touching its id, its status or the file order', () => {
    record().add(['first', 'second']);
    record().done('d1', '2026-09-18', ['PR #58']);
    record().set('d1', 'first, said better');
    expect(onDisk().deliverables[0]).toEqual({
      id: 'd1',
      text: 'first, said better',
      status: 'done',
      doneAt: '2026-09-18',
      refs: ['PR #58'],
    });
  });

  it('marks one done, with today by default and the refs it was given', () => {
    record().add(['first']);
    const done = record().done('d1', '', ['PR #58', 'PR #59']);
    expect(done.doneAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(done.refs).toEqual(['PR #58', 'PR #59']);
    expect(record().done('d1', '2026-09-19', []).refs, 'no refs is no key at all').toBeUndefined();
  });

  it('refuses a date that is not a real YYYY-MM-DD', () => {
    record().add(['first']);
    for (const bad of ['09-19', '2026-9-19', '2026-02-30', 'yesterday']) {
      expect(refusal(() => record().done('d1', bad, []))).toContain('YYYY-MM-DD');
    }
  });

  it('drops the date, the refs and the reason on the way back to to-do', () => {
    record().add(['first', 'second']);
    record().done('d1', '2026-09-18', ['PR #58']);
    record().abandon('d2', 'user reads that off the terminal header');
    expect(record().todo('d1')).toEqual({ id: 'd1', text: 'first', status: 'todo' });
    expect(record().todo('d2')).toEqual({ id: 'd2', text: 'second', status: 'todo' });
    expect(onDisk().deliverables.every((d) => Object.keys(d).length === 3)).toBe(true);
  });

  it('refuses an unknown id, and says which ids there are', () => {
    record().add(['first']);
    expect(refusal(() => record().set('d9', 'x'))).toContain('this task has d1');
    expect(refusal(() => record().rm('d9'))).toContain('no such deliverable: d9');
    rmSync(record().file);
    expect(refusal(() => record().todo('d1'))).toContain('this task has none yet');
  });

  it('refuses a blank text, a blank reason and a text spanning lines', () => {
    expect(refusal(() => record().add(['  ']))).toContain('cannot be blank');
    expect(refusal(() => record().add([]))).toContain('at least one');
    record().add(['first']);
    expect(refusal(() => record().set('d1', ''))).toContain('cannot be blank');
    expect(refusal(() => record().abandon('d1', ' '))).toContain('cannot be blank');
    expect(refusal(() => record().add(['two\nlines']))).toContain('one line');
  });

  it('writes nothing when it refuses', () => {
    record().add(['first']);
    const before = readFileSync(record().file, 'utf8');
    refusal(() => record().done('d1', 'yesterday', []));
    refusal(() => record().set('d9', 'x'));
    refusal(() => record().add(['ok', '']));
    expect(readFileSync(record().file, 'utf8')).toBe(before);
  });
});

/**
 * What a ref points at is worked out from the ref itself, because `PR #58`
 * cannot say which repository it belongs to. Only these answers ever carry an
 * address, and everything else is text to be printed as it was typed.
 */
describe('a ref', () => {
  it('reads a GitHub pull request as PR #n', () => {
    expect(refLink('https://github.com/acme/site/pull/58')).toEqual({
      label: 'PR #58',
      href: 'https://github.com/acme/site/pull/58',
    });
    expect(refLink('https://www.github.com/acme/site/pull/58/files').label).toBe('PR #58');
    expect(refLink('https://github.com/acme/site/pull/58#discussion_r1').label).toBe('PR #58');
  });

  it('reads a GitLab merge request as MR !n, on any host, because GitLab is self-hosted', () => {
    expect(refLink('https://gitlab.acme.internal/team/app/-/merge_requests/87')).toEqual({
      label: 'MR !87',
      href: 'https://gitlab.acme.internal/team/app/-/merge_requests/87',
    });
    expect(refLink('https://gitlab.com/a/b/c/-/merge_requests/9/diffs').label).toBe('MR !9');
  });

  it('labels any other http(s) URL with its host', () => {
    expect(refLink('https://jira.acme.internal/browse/ACME-31')).toEqual({
      label: 'jira.acme.internal',
      href: 'https://jira.acme.internal/browse/ACME-31',
    });
    expect(refLink('http://localhost:8080/build/12').label).toBe('localhost:8080');
  });

  it('leaves a ref that is not a URL exactly as it was typed, and gives it no address', () => {
    for (const plain of ['PR #58', 'MR !87', 'the deploy on 09-18', 'PR #32 <!-- squashed -->']) {
      expect(refLink(plain)).toEqual({ label: plain, href: null });
    }
  });

  it('never gives an address to a scheme that is not http or https', () => {
    for (const hostile of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'vbscript:msgbox']) {
      expect(refLink(hostile), hostile).toEqual({ label: hostile, href: null });
    }
  });

  it('prints a URL in its short form beside the day, and keeps the record as stored', () => {
    record().add(['first']);
    const done = record().done('d1', '2026-09-18', ['https://github.com/acme/site/pull/58', 'PR #12']);
    expect(done.refs, 'the record keeps the ref as it was typed').toEqual([
      'https://github.com/acme/site/pull/58',
      'PR #12',
    ]);
    expect(deliverableAside(done)).toBe('2026-09-18 \u00b7 PR #58 \u00b7 PR #12');
  });
});
