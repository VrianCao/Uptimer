import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError } from './errors.ts';

const SKILL_NAME = 'uptimer-cli';

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

// A repository checkout owns the source at the repo root; packaged installs carry `skill/`.
// Checkout first so a stale build copy never shadows the edited skill.
async function resolveSkillSource(): Promise<string> {
  const candidates = [
    fileURLToPath(new URL('../../../skills/uptimer-cli', import.meta.url)),
    fileURLToPath(new URL('../skill', import.meta.url)),
  ];
  for (const candidate of candidates) {
    if (await isFile(join(candidate, 'SKILL.md'))) return candidate;
  }
  throw new CliError(
    1,
    'SKILL_NOT_FOUND',
    'Bundled uptimer-cli skill files are missing from this installation',
  );
}

export interface SkillInstallResult {
  installed: true;
  skill: string;
  path: string;
  files: string[];
}

export async function installSkill(input: {
  dir: string;
  force: boolean;
}): Promise<SkillInstallResult> {
  const source = await resolveSkillSource();
  const target = join(input.dir, SKILL_NAME);

  if (!input.force && (await isFile(join(target, 'SKILL.md')))) {
    throw new CliError(
      2,
      'SKILL_ALREADY_INSTALLED',
      `Skill already installed at ${target}; pass --force to replace it`,
    );
  }

  const references = await readdir(join(source, 'references'))
    .then((names) => names.filter((name) => name.endsWith('.md')))
    .catch(() => [] as string[]);

  await mkdir(join(target, 'references'), { recursive: true });
  const files = ['SKILL.md', ...references.map((name) => join('references', name))];
  for (const file of files) {
    await copyFile(join(source, file), join(target, file));
  }

  return { installed: true, skill: SKILL_NAME, path: target, files };
}
