import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryProjectFacts } from '../src/facts/query.ts';

test('searches registered labels and text across topical tables', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'fact-query-'));
  try {
    await mkdir(join(cwd, '.fact', 'sub'), { recursive: true });
    await writeFile(join(cwd, '.fact', 'label.tsv'), 'label\tdescription\nperf\tPerformance\nother\tOther\n');
    await writeFile(join(cwd, '.fact', 'one.tsv'), 'id\tfact\tsource\tlabels\n1\tFast response\tdoc\tperf,other\n2\tSlow operation\t\tother\n');
    await writeFile(join(cwd, '.fact', 'sub', 'two.tsv'), 'id\tfact\tsource\tlabels\n1\tQuick startup\tdoc\tperf\n');
    await writeFile(join(cwd, '.fact', 'sub', 'change.tsv'), 'id\tfact\tsource\tlabels\n3\tHidden\tdoc\tperf\n');
    await writeFile(join(cwd, '.fact', 'facts.tsv'), 'legacy\theader\n3\tHidden\n');
    await symlink(join(cwd, '.fact', 'one.tsv'), join(cwd, '.fact', 'link.tsv'));
    const label = await queryProjectFacts(cwd, { query: ' PERF ' });
    assert.equal(label.mode, 'label');
    assert.deepEqual(label.matches.map(m => m.fact).sort(), ['Fast response', 'Quick startup']);
    const refined = await queryProjectFacts(cwd, { query: 'startup', label: 'perf' });
    assert.deepEqual(refined.matches.map(m => m.fact), ['Quick startup']);
    assert.deepEqual((await queryProjectFacts(cwd, { query: 'operation' })).matches.map(m => m.fact), ['Slow operation']);
    await assert.rejects(queryProjectFacts(cwd, { query: 'x', label: 'missing' }), /Unknown fact label/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
