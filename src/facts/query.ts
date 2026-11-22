import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { decodeTsv } from './tsv.ts';

import type { FactOperation, TaskFactView } from './taskbook-intake.ts';

export type FactMatch = { path: string; id: string; fact: string; source: string; labels: string[]; operation?: FactOperation; taskItemId?: string; reason?: string };
export type FactQueryResult = ({ mode: 'label'; label: string } | { mode: 'text' }) &
  { matches: FactMatch[]; warnings?: string[] };

const normalize = (value: string) => value.normalize('NFKC').trim().toLowerCase();
export const maxFactMatches = 10;

export async function queryProjectFacts(cwd: string, input: { query: string; label?: string; limit?: number }, view?: TaskFactView): Promise<FactQueryResult> {
  const root = join(cwd, '.fact');
  const warnings: string[] = [];
  const query = normalize(input.query);
  if (!query) throw new Error('Supply a label or search terms.');
  let exists = true;
  try {
    if (!(await lstat(root)).isDirectory()) {
      if (input.label !== undefined) throw new Error(`Unknown fact label: ${input.label}`);
      return { mode: 'text', matches: [] };
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    exists = false;
  }
  const catalog = new Map<string, string>();
  try {
    const catalogPath = join(root, 'label.tsv');
    if (!(await lstat(catalogPath)).isFile()) throw new Error('not a regular file');
    const rows = decodeTsv(await readFile(catalogPath, 'utf8'));
    if (rows[0]?.join('\t') !== 'label\tdescription') throw new Error('invalid header');
    for (const row of rows.slice(1)) if (row.length === 2 && row[0].trim()) catalog.set(normalize(row[0]), row[0].trim());
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) warnings.push(`Cannot read .fact/label.tsv: ${String(error)}`);
  }
  if (view?.entries.some(entry => entry.row.labels.includes('terms'))) catalog.set('terms', 'terms');
  if (view) catalog.set(normalize(view.label), view.label);
  const explicit = input.label === undefined ? undefined : catalog.get(normalize(input.label));
  if (input.label !== undefined && !explicit) throw new Error(`Unknown fact label: ${input.label}`);
  const label = explicit ?? catalog.get(query);
  const labelKey = label && normalize(label);
  const terms = query === labelKey ? [] : [...new Set(query.split(/\s+/u))];
  const records = new Map<string, FactMatch>();
  const locator = (row: FactMatch) => row.path + '#' + row.id;
  async function scan(dir: string): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT' && dir === root)) warnings.push(`Cannot read ${relative(cwd, dir)}: ${String(error)}`);
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) { await scan(file); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.tsv') || entry.name === 'label.tsv' || entry.name === 'change.tsv') continue;
      const path = relative(cwd, file).split(sep).join('/');
      try {
        const rows = decodeTsv(await readFile(file, 'utf8'));
        if (rows[0]?.join('\t') !== 'id\tfact\tsource\tlabels') continue;
        for (const row of rows.slice(1)) {
          if (row.length !== 4 || !row[0].trim() || !row[1].trim()) continue;
          const labels = row[3].split(',').map(value => value.trim()).filter(Boolean);
          const match = { path, id: row[0], fact: row[1], source: row[2], labels };
          records.set(locator(match), match);
        }
      } catch (error) { warnings.push(`Cannot read ${path}: ${String(error)}`); }
    }
  }
  if (exists) await scan(root);
  for (const {row, operation, reason, item} of view?.entries ?? []) {
    records.set(locator(row), {...row, operation, taskItemId: item, ...(reason ? {reason} : {}), labels: [...new Set([...row.labels, view!.label])]});
  }
  const visible = [...records.values()].filter(row => !labelKey || row.labels.some(tag => normalize(tag) === labelKey));
  const exact = visible.filter(row => row.id === input.query.trim() || locator(row) === input.query.trim());
  if ((!label || query !== labelKey) && (exact.length || /^\.fact\/.*\.tsv#/u.test(input.query.trim()))) {
    if (exact.length > 1) throw new Error('Ambiguous fact ID. Use one of: ' + exact.map(locator).join(', '));
    const selected = {matches: exact, ...(warnings.length ? {warnings} : {})};
    return label ? {mode: 'label', label, ...selected} : {mode: 'text', ...selected};
  }
  const found: Array<{ match: FactMatch; score: number }> = [];
  for (const match of visible) {
    if (match.operation === 'delete' && labelKey !== view?.label) continue;
    const haystack = normalize(match.fact + ' ' + match.path);
    const hits = terms.filter(term => haystack.includes(term)).length;
    if (terms.length && !hits) continue;
    const score = hits * 2 + Number(terms.length > 0 && haystack.includes(query));
    found.push({match, score});
  }
  found.sort((a, b) => b.score - a.score || Number(Boolean(b.match.source.trim())) - Number(Boolean(a.match.source.trim())) ||
    a.match.fact.length - b.match.fact.length || a.match.path.localeCompare(b.match.path) || a.match.id.localeCompare(b.match.id));
  const limit = Math.max(1, Math.min(maxFactMatches, Math.floor(input.limit ?? 5)));
  const seen = new Set<string>();
  const matches: FactMatch[] = [];
  for (const { match } of found) {
    const key = normalize(match.fact);
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push(match);
    if (matches.length >= limit) break;
  }
  const result = { matches, ...(warnings.length ? { warnings } : {}) };
  return label ? { mode: 'label', label, ...result } : { mode: 'text', ...result };
}
