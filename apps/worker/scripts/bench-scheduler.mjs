import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(workerRoot, '..', '..');

const benchConfigRelativePath = path.join('apps', 'worker', 'vitest.bench.config.ts');
const benchFileRelativePath = path.join('apps', 'worker', 'test', 'scheduled.bench.ts');
const currentBenchConfigPath = path.join(repoRoot, benchConfigRelativePath);
const currentBenchFilePath = path.join(repoRoot, benchFileRelativePath);
const vitestEntrypoint = path.join(workerRoot, 'node_modules', 'vitest', 'vitest.mjs');

const currentRootNodeModules = path.join(repoRoot, 'node_modules');
const currentWorkerNodeModules = path.join(workerRoot, 'node_modules');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    const pieces = [
      `command failed: ${command} ${args.join(' ')}`,
      result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : '',
      result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : '',
    ].filter(Boolean);
    throw new Error(pieces.join('\n\n'));
  }

  return result.stdout ?? '';
}

function git(args, options = {}) {
  return run('git', args, { cwd: repoRoot, ...options }).trim();
}

function sanitizeLabel(raw) {
  return raw.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function resolveBaselineRef() {
  return process.env.SCHEDULER_BENCH_BASE_REF ?? 'aef3f045c4c694f8440d08ba020548eed94f82db';
}

function createOutputPath(label) {
  return path.join(
    os.tmpdir(),
    `uptimer-scheduler-bench-${sanitizeLabel(label)}-${Date.now()}.json`,
  );
}

function ensureTreeDependencies(treeRoot) {
  symlinkSync(currentRootNodeModules, path.join(treeRoot, 'node_modules'), 'dir');
  cpSync(currentWorkerNodeModules, path.join(treeRoot, 'apps', 'worker', 'node_modules'), {
    recursive: true,
    force: true,
    dereference: false,
  });
  cpSync(currentBenchConfigPath, path.join(treeRoot, benchConfigRelativePath), { force: true });
  cpSync(currentBenchFilePath, path.join(treeRoot, benchFileRelativePath), { force: true });
}

function listTrackedWorkingTreeChanges() {
  const output = git(['diff', '--name-status', '--no-renames', 'HEAD', '--']);
  if (!output) return [];

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status, filePath] = line.split('\t');
      return { status, filePath };
    });
}

function listUntrackedFiles() {
  const output = git(['ls-files', '--others', '--exclude-standard']);
  if (!output) return [];

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function overlayCurrentWorkingTree(treeRoot) {
  for (const change of listTrackedWorkingTreeChanges()) {
    const targetPath = path.join(treeRoot, change.filePath);

    if (change.status === 'D') {
      rmSync(targetPath, { recursive: true, force: true });
      continue;
    }

    const sourcePath = path.join(repoRoot, change.filePath);
    mkdirSync(path.dirname(targetPath), { recursive: true });
    cpSync(sourcePath, targetPath, { force: true, recursive: true, dereference: false });
  }

  for (const filePath of listUntrackedFiles()) {
    const sourcePath = path.join(repoRoot, filePath);
    const targetPath = path.join(treeRoot, filePath);
    mkdirSync(path.dirname(targetPath), { recursive: true });
    cpSync(sourcePath, targetPath, { force: true, recursive: true, dereference: false });
  }
}

function runBenchmarkForTree(treeRoot, label) {
  const outputPath = createOutputPath(label);
  const workerCwd = path.join(treeRoot, 'apps', 'worker');
  const benchConfigPath = path.join(workerCwd, 'vitest.bench.config.ts');

  const env = {
    ...process.env,
    SCHEDULER_BENCH_LABEL: label,
    SCHEDULER_BENCH_OUTPUT: outputPath,
  };

  run(
    'node',
    [
      vitestEntrypoint,
      'run',
      '--config',
      benchConfigPath,
      'test/scheduled.bench.ts',
      '--reporter=dot',
    ],
    {
      cwd: workerCwd,
      env,
    },
  );

  const parsed = JSON.parse(readFileSync(outputPath, 'utf8'));
  rmSync(outputPath, { force: true });
  return parsed;
}

function summarizeComparison(baselineRows, currentRows) {
  return baselineRows.map((baselineRow, index) => {
    const currentRow = currentRows[index];
    const baselineMean = baselineRow.meanMs;
    const currentMean = currentRow.meanMs;
    const meanReductionPct =
      baselineMean === 0 ? 0 : ((baselineMean - currentMean) / baselineMean) * 100;

    return {
      scenario: baselineRow.scenario,
      baselineMeanMs: baselineMean.toFixed(3),
      currentMeanMs: currentMean.toFixed(3),
      meanReductionPct: `${meanReductionPct.toFixed(1)}%`,
      speedupX: currentMean === 0 ? 'inf' : (baselineMean / currentMean).toFixed(2),
      baselineMedianMs: baselineRow.medianMs.toFixed(3),
      currentMedianMs: currentRow.medianMs.toFixed(3),
      baselineP95Ms: baselineRow.p95Ms.toFixed(3),
      currentP95Ms: currentRow.p95Ms.toFixed(3),
      batchCalls: `${baselineRow.batchCallsAvg} -> ${currentRow.batchCallsAvg}`,
    };
  });
}

function main() {
  const baselineRef = resolveBaselineRef();
  const currentLabel = process.env.SCHEDULER_BENCH_CURRENT_LABEL ?? 'current-working-tree';
  const baselineLabel = process.env.SCHEDULER_BENCH_BASE_LABEL ?? `baseline-${baselineRef}`;

  const baselineTreeRoot = mkdtempSync(path.join(os.tmpdir(), 'uptimer-scheduler-bench-base-'));
  const currentTreeRoot = mkdtempSync(path.join(os.tmpdir(), 'uptimer-scheduler-bench-current-'));
  const worktreeRoots = [];

  try {
    git(['worktree', 'add', '--detach', baselineTreeRoot, baselineRef]);
    worktreeRoots.push(baselineTreeRoot);
    ensureTreeDependencies(baselineTreeRoot);

    git(['worktree', 'add', '--detach', currentTreeRoot, 'HEAD']);
    worktreeRoots.push(currentTreeRoot);
    ensureTreeDependencies(currentTreeRoot);
    overlayCurrentWorkingTree(currentTreeRoot);

    // Prime both trees once so the measured run is less sensitive to first-load filesystem noise.
    runBenchmarkForTree(baselineTreeRoot, `${baselineLabel}-warmup`);
    runBenchmarkForTree(currentTreeRoot, `${currentLabel}-warmup`);

    const baselineRows = runBenchmarkForTree(baselineTreeRoot, baselineLabel);
    const currentRows = runBenchmarkForTree(currentTreeRoot, currentLabel);
    const comparison = summarizeComparison(baselineRows, currentRows);

    console.log('Scheduler benchmark');
    console.log(`Base ref: ${baselineRef}`);
    console.log(`Current label: ${currentLabel}`);
    console.log(`Baseline label: ${baselineLabel}`);
    if (process.env.SCHEDULER_BENCH_RUNS || process.env.SCHEDULER_BENCH_WARMUPS) {
      console.log(
        `Runs: ${process.env.SCHEDULER_BENCH_RUNS ?? '12'} (warmups: ${process.env.SCHEDULER_BENCH_WARMUPS ?? '3'})`,
      );
    }
    console.log('');
    console.table(comparison);

    if (process.env.SCHEDULER_BENCH_WRITE_JSON) {
      const jsonPath = path.resolve(process.env.SCHEDULER_BENCH_WRITE_JSON);
      writeFileSync(
        jsonPath,
        JSON.stringify({ baselineRef, baselineRows, currentRows, comparison }, null, 2),
        'utf8',
      );
      console.log(`\nWrote raw benchmark data to ${jsonPath}`);
    }
  } finally {
    for (const worktreeRoot of worktreeRoots.reverse()) {
      git(['worktree', 'remove', '--force', worktreeRoot]);
    }

    rmSync(baselineTreeRoot, { recursive: true, force: true });
    rmSync(currentTreeRoot, { recursive: true, force: true });
  }
}

main();
