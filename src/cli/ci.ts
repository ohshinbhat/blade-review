#!/usr/bin/env node
/**
 * CI entry point. Reads the PR diff, runs the same `review()` the CLI runs, and
 * posts the verdict as a PR review. Everything specific to CI lives here; the
 * engine has no idea GitHub exists.
 *
 * Run inside a GitHub Action:
 *   GITHUB_TOKEN=... GITHUB_REPOSITORY=razorpay/blade PR_NUMBER=123 \
 *     npx tsx src/cli/ci.ts --graph data/blade-graph.json
 *
 * --dry-run prints the review payload instead of posting it, which is how the
 * local samples run without write access to a repository.
 */
import * as fs from 'fs';
import * as path from 'path';
import { loadGraph } from '../extract/index.js';
import { review } from '../engine/review.js';
import { toGitHubReview } from '../ci/github.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const dryRun = process.argv.includes('--dry-run');
const skipReviewerRequest = process.argv.includes('--skip-reviewer-request');

async function fetchPrDiff(repo: string, pr: string, token: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${pr}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github.v3.diff' },
  });
  if (!res.ok) throw new Error(`GitHub diff fetch failed: ${res.status} ${await res.text()}`);
  return res.text();
}

async function postReview(
  repo: string,
  pr: string,
  token: string,
  payload: ReturnType<typeof toGitHubReview>,
): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${pr}/reviews`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ event: payload.event, body: payload.body, comments: payload.comments }),
  });
  if (!res.ok) throw new Error(`GitHub review post failed: ${res.status} ${await res.text()}`);

  if (payload.requestReviewers.length) {
    const reviewerRes = await fetch(`https://api.github.com/repos/${repo}/pulls/${pr}/requested_reviewers`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ team_reviewers: payload.requestReviewers.map((t) => t.split('/').pop()) }),
    });
    if (!reviewerRes.ok) {
      throw new Error(`GitHub reviewer request failed: ${reviewerRes.status} ${await reviewerRes.text()}`);
    }
  }
}

async function postCheckRun(
  repo: string,
  sha: string,
  token: string,
  payload: ReturnType<typeof toGitHubReview>,
): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${repo}/check-runs`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      name: 'Blade architecture verdict',
      head_sha: sha,
      status: 'completed',
      conclusion: payload.conclusion,
      output: { title: payload.checkTitle, summary: payload.body.slice(0, 65_000) },
    }),
  });
  if (!res.ok) throw new Error(`GitHub check-run post failed: ${res.status} ${await res.text()}`);
}

async function main(): Promise<void> {
  const graph = loadGraph(path.resolve(flag('graph') ?? 'data/blade-graph.json'));
  const baseGraphPath = flag('base-graph');
  const priorGraph = baseGraphPath ? loadGraph(path.resolve(baseGraphPath)) : graph;

  const repo = process.env.GITHUB_REPOSITORY;
  const pr = process.env.PR_NUMBER;
  const token = process.env.GITHUB_TOKEN;
  const diffFile = flag('diff');

  let diff: string;
  if (diffFile) {
    diff = fs.readFileSync(path.resolve(diffFile), 'utf8');
  } else {
    if (!repo || !pr || !token) {
      throw new Error('Set GITHUB_REPOSITORY, PR_NUMBER and GITHUB_TOKEN, or pass --diff <file>.');
    }
    diff = await fetchPrDiff(repo, pr, token);
  }

  const verdict = await review({ intent: flag('intent') ?? '', diff }, graph, { priorGraph });
  const payload = toGitHubReview(
    verdict,
    flag('team') ?? 'razorpay/design-system',
    !skipReviewerRequest,
  );

  if (dryRun || !repo || !pr || !token) {
    process.stdout.write(
      [
        `event:      ${payload.event}`,
        `verdict:    ${payload.checkTitle}`,
        `conclusion: ${payload.conclusion}`,
        `reviewers:  ${payload.requestReviewers.join(', ') || '-'}`,
        `inline:     ${payload.comments.length} suggestion block(s)`,
        '',
        '--- review body ---',
        payload.body,
        '',
        ...payload.comments.flatMap((c) => [`--- inline: ${c.path} ---`, c.body, '']),
      ].join('\n'),
    );
  } else {
    await postReview(repo, pr, token, payload);
    const headSha = process.env.PR_HEAD_SHA ?? process.env.GITHUB_SHA;
    if (headSha) await postCheckRun(repo, headSha, token, payload);
    process.stdout.write(`Posted architecture review to ${repo}#${pr}: ${payload.checkTitle}\n`);
  }

  // The gate blocks only on a proven-or-judged violation. needs_human never fails
  // the build — a deferral that looks like a broken build teaches people to ignore it.
  process.exit(payload.conclusion === 'failure' ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`error: ${(err as Error).message}\n`);
  process.exit(2);
});
