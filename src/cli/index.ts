#!/usr/bin/env node
/**
 * CLI adapter — intent-time review.
 *
 * The point of this surface: it works before a PR exists. A designer can ask
 * "is this the right way to build it?" before spending a day building it the
 * wrong way, which is both cheaper and less demoralising than a rejection at
 * review time.
 *
 *   npm run review -- "add a tertiary variant to Button with a green background"
 *   npm run review -- --diff changes.patch
 *   npm run review -- --json "..."           # machine-readable, for CI
 */
import * as fs from 'fs';
import * as path from 'path';
import { loadGraph } from '../extract/index.js';
import { review } from '../engine/review.js';
import { renderVerdict } from './render.js';
import type { ProposedChange } from '../types.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const graphPath = path.resolve(flag('graph') ?? 'data/blade-graph.json');
  const diffPath = flag('diff');
  const json = has('json');

  const positional = process.argv.slice(2).filter((a, i, arr) => {
    if (a.startsWith('--')) return false;
    const prev = arr[i - 1];
    return !(prev && prev.startsWith('--') && !['--json', '--deterministic-only'].includes(prev));
  });
  const intent = positional.join(' ').trim();

  if (!intent && !diffPath) {
    process.stderr.write(
      [
        '',
        'Blade PR review agent',
        '',
        '  npm run review -- "<describe the change you intend to make>"',
        '  npm run review -- --diff <path-to.patch> ["<intent>"]',
        '',
        'Options:',
        '  --graph <path>            knowledge graph (default data/blade-graph.json)',
        '  --json                    emit the raw Verdict as JSON',
        '  --deterministic-only      skip the judgment layer',
        '',
      ].join('\n'),
    );
    process.exit(2);
  }

  const graph = loadGraph(graphPath);
  const change: ProposedChange = {
    intent,
    diff: diffPath ? fs.readFileSync(path.resolve(diffPath), 'utf8') : undefined,
  };

  const verdict = await review(change, graph, { deterministicOnly: has('deterministic-only') });

  if (json) {
    process.stdout.write(JSON.stringify(verdict, null, 2) + '\n');
  } else {
    process.stdout.write(renderVerdict(verdict));
  }

  // Exit code contract, used by CI: 0 = pass, 1 = blocked, 2 = usage error,
  // 3 = deferred to a human (not a failure, but not an approval either).
  process.exit(verdict.status === 'incorrect' ? 1 : verdict.status === 'needs_human' ? 3 : 0);
}

main().catch((err) => {
  process.stderr.write(`\n  error: ${(err as Error).message}\n\n`);
  process.exit(2);
});
