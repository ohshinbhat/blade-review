/**
 * Extraction orchestrator.
 *
 * Run once per Blade release (or on a schedule), not per PR. The output is a
 * cached JSON artifact committed alongside the agent, so a CI run costs one file
 * read instead of a repo parse. That is what keeps the agent's knowledge of
 * Blade current without ever putting Blade facts into a prompt by hand.
 */
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import type { KnowledgeGraph } from '../types.js';
import { extractGlobalTokens, extractThemeTokens } from './tokens.js';
import { extractComponents } from './components.js';
import { extractThemeMemberUsages } from './themeUsage.js';
import { BladeGraph } from './graph.js';

/** Architectural source documents: the provenance for every rule in the rulebook. */
const DOC_GLOBS = [
  'rfcs/2021-01-04-tokens-naming-convention.md',
  'rfcs/2021-01-22-spatial-system-rfc.md',
  'rfcs/writing-cross-platform-typescript.md',
  'packages/blade/CLAUDE.md',
  'CONTRIBUTING.md',
];

function gitRef(repoRoot: string): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

export function buildKnowledgeGraph(repoRoot: string): KnowledgeGraph {
  const bladeSrc = path.join(repoRoot, 'packages', 'blade', 'src');
  if (!fs.existsSync(bladeSrc)) {
    throw new Error(
      `Blade source not found at ${bladeSrc}. Point --blade at a razorpay/blade checkout.`,
    );
  }

  const t0 = Date.now();
  const globalTokens = extractGlobalTokens(bladeSrc, repoRoot);
  const themeTokens = extractThemeTokens(bladeSrc, repoRoot);
  const { components, usages: tokenFileUsages, componentTokens } = extractComponents(bladeSrc, repoRoot);
  // Two distinct consumption patterns, both required for correct cascade analysis:
  // semantic tokens referenced as strings in component token files, and global
  // tokens consumed as member access on the theme object.
  const themeUsages = extractThemeMemberUsages(bladeSrc, repoRoot);
  const usages = [...tokenFileUsages, ...themeUsages];

  const documents: Record<string, string> = {};
  for (const rel of DOC_GLOBS) {
    const p = path.join(repoRoot, rel);
    if (fs.existsSync(p)) documents[rel] = fs.readFileSync(p, 'utf8');
  }
  // Per-component API decision docs are first-class rule provenance.
  for (const c of components) {
    if (c.decisionsDocPath) {
      const p = path.join(repoRoot, c.decisionsDocPath);
      if (fs.existsSync(p)) documents[c.decisionsDocPath] = fs.readFileSync(p, 'utf8');
    }
  }

  return {
    bladeRef: gitRef(repoRoot),
    extractedAt: new Date().toISOString(),
    tokens: [...globalTokens, ...themeTokens, ...componentTokens],
    components,
    usages,
    documents,
    stats: {
      globalTokens: globalTokens.length,
      themeTokens: themeTokens.length,
      componentTokens: componentTokens.length,
      tokenFileUsages: tokenFileUsages.length,
      themeAccessUsages: themeUsages.length,
      componentsWithTokenFile: components.filter((c) => c.tokenFiles.length > 0).length,
      componentsWithDecisionsDoc: components.filter((c) => c.hasDecisionsDoc).length,
      documents: Object.keys(documents).length,
      extractionMs: Date.now() - t0,
    },
  };
}

export function writeGraph(graph: KnowledgeGraph, outPath: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(graph, null, 0));
}

export function loadGraph(graphPath: string): BladeGraph {
  if (!fs.existsSync(graphPath)) {
    throw new Error(`Knowledge graph not found at ${graphPath}. Run: npm run extract -- --blade <path>`);
  }
  return new BladeGraph(JSON.parse(fs.readFileSync(graphPath, 'utf8')) as KnowledgeGraph);
}

export { BladeGraph };
