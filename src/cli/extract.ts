#!/usr/bin/env node
import * as path from 'path';
import { buildKnowledgeGraph, writeGraph } from '../extract/index.js';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required --${name}`);
}

const repoRoot = path.resolve(arg('blade'));
const out = path.resolve(arg('out', 'data/blade-graph.json'));

process.stdout.write(`Extracting Blade knowledge graph from ${repoRoot}\n`);
const graph = buildKnowledgeGraph(repoRoot);
writeGraph(graph, out);

const s = graph.stats;
process.stdout.write(
  [
    ``,
    `  blade ref              ${graph.bladeRef}`,
    `  global tokens          ${s.globalTokens}`,
    `  theme tokens           ${s.themeTokens}`,
    `  component tokens       ${s.componentTokens}`,
    `  components             ${graph.components.length}`,
    `  token usage edges      ${graph.usages.length}`,
    `  components w/ tokens   ${s.componentsWithTokenFile}`,
    `  components w/ decisions${' '.repeat(1)}${s.componentsWithDecisionsDoc}`,
    `  documents indexed      ${s.documents}`,
    `  extraction time        ${s.extractionMs}ms`,
    ``,
    `  -> ${out}`,
    ``,
  ].join('\n'),
);
