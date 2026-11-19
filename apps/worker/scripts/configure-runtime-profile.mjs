import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { readFileSync } from 'node:fs';

const profileSchema = z.enum(['free', 'paid']);
const paidCrons = z
  .array(z.string())
  .parse(
    JSON.parse(readFileSync(new URL('../src/scheduler/paid-crons.json', import.meta.url), 'utf8')),
  );

// Transform the canonical config rather than maintaining two drifting copies.
// Keep class exports and migration history for safe switching on existing Workers.
export function configureRuntimeProfile(source, input) {
  const profile = profileSchema.parse(input);
  let foundVars = false;
  let foundCoordinator = false;
  let foundTriggers = false;
  const tables = source.split(/(?=^\[)/m);
  const output = tables.flatMap((table) => {
    const header = table.split('\n', 1)[0].trim();
    if (header === '[triggers]' && profile === 'paid') {
      foundTriggers = true;
      // Keep the ordinary tick as a complete fallback while added triggers
      // propagate. Each equivalent expression creates an independent event.
      const match = table.match(/^crons\s*=\s*\[([\s\S]*?)\]/m);
      if (!match || !match[1].includes('"* * * * *"'))
        throw new Error('Paid profile requires the canonical minute Cron');
      const additions = paidCrons.filter((cron) => !match[1].includes(JSON.stringify(cron)));
      return additions.length
        ? table.replace(
            match[0],
            `${match[0].slice(0, -1).trimEnd().replace(/,$/, '')}, ${additions.map((cron) => JSON.stringify(cron)).join(', ')}]`,
          )
        : table;
    }
    if (header === '[vars]') {
      foundVars = true;
      const assignment = `UPTIMER_RUNTIME_PROFILE = "${profile}"`;
      let vars = table.match(/^UPTIMER_RUNTIME_PROFILE\s*=/m)
        ? table.replace(/^UPTIMER_RUNTIME_PROFILE\s*=.*$/m, assignment)
        : table.replace('[vars]', `[vars]\n${assignment}`);
      if (profile === 'paid') {
        const concurrency = 'UPTIMER_INTERNAL_SCHEDULED_BATCH_CONCURRENCY = "1"';
        vars = /^UPTIMER_INTERNAL_SCHEDULED_BATCH_CONCURRENCY\s*=/m.test(vars)
          ? vars.replace(/^UPTIMER_INTERNAL_SCHEDULED_BATCH_CONCURRENCY\s*=.*$/m, concurrency)
          : vars.replace('[vars]', `[vars]\n${concurrency}`);
      }
      return vars;
    }
    if (header === '[[durable_objects.bindings]]') {
      if (!/^name\s*=\s*"COORDINATOR"\s*$/m.test(table)) {
        if (profile === 'paid') throw new Error('Paid profile cannot include custom DO bindings');
        return table;
      }
      foundCoordinator = true;
      return profile === 'paid' ? [] : [table];
    }
    if (header === '[limits]') {
      const remaining = table.replace(/^cpu_ms\s*=.*\n?/gm, '');
      // Do not discard unrelated user limits such as subrequests.
      return remaining
        .split('\n')
        .slice(1)
        .every((line) => /^\s*(?:#.*)?$/.test(line))
        ? []
        : [remaining];
    }
    return [table];
  });
  if (!foundVars) throw new Error('Runtime profile requires a [vars] table');
  if (profile === 'paid' && !foundTriggers)
    throw new Error('Paid profile requires the canonical minute Cron');
  if (profile === 'free' && !foundCoordinator)
    throw new Error('Free profile requires the canonical COORDINATOR binding');
  let result = output.join('');
  if (profile === 'paid') {
    if (/^\[limits\]\s*$/m.test(result))
      result = result.replace(/^\[limits\]\s*$/m, '[limits]\ncpu_ms = 30000');
    else result = result.trimEnd() + '\n\n[limits]\ncpu_ms = 30000\n';
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [profile, source, destination = source] = process.argv.slice(2);
  if (!source)
    throw new Error('Usage: configure-runtime-profile.mjs free|paid input.toml [output.toml]');
  const output = configureRuntimeProfile(await readFile(source, 'utf8'), profile);
  await writeFile(destination, output);
  console.log(`Configured ${profile} runtime: ${destination}`);
}
