import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { run } from '../src/index.ts';

const repositorySkill = fileURLToPath(new URL('../../../skills/uptimer-cli', import.meta.url));

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: { write: (chunk: string) => ((stdout += chunk), true) },
    stderr: { write: (chunk: string) => ((stderr += chunk), true) },
    get stdoutJson() {
      return JSON.parse(stdout) as unknown;
    },
    get stdoutText() {
      return stdout;
    },
    get stderrJson() {
      return JSON.parse(stderr) as { error: { code: string; message: string } };
    },
  };
}

test('skill install writes the bundled skill into the requested directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uptimer-skill-install-'));
  try {
    const io = capture();
    const code = await run(['skill', 'install', '--dir', dir], {}, io);

    assert.equal(code, 0);
    assert.deepEqual(io.stdoutJson, {
      installed: true,
      skill: 'uptimer-cli',
      path: join(dir, 'uptimer-cli'),
      files: ['SKILL.md', join('references', 'commands.md')],
    });
    assert.equal(
      readFileSync(join(dir, 'uptimer-cli/SKILL.md'), 'utf8'),
      readFileSync(join(repositorySkill, 'SKILL.md'), 'utf8'),
    );
    assert.equal(
      readFileSync(join(dir, 'uptimer-cli/references/commands.md'), 'utf8'),
      readFileSync(join(repositorySkill, 'references/commands.md'), 'utf8'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skill install defaults to ./skills and needs no credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uptimer-skill-default-'));
  const previous = process.cwd();
  try {
    process.chdir(dir);
    const io = capture();
    const code = await run(['skill', 'install'], { UPTIMER_URL: '', UPTIMER_ADMIN_TOKEN: '' }, io);

    assert.equal(code, 0);
    assert.ok(existsSync(join(dir, 'skills/uptimer-cli/SKILL.md')));
    assert.ok(existsSync(join(dir, 'skills/uptimer-cli/references/commands.md')));
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skill install refuses an existing target and --force replaces it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uptimer-skill-existing-'));
  try {
    writeFileSync(join(dir, 'placeholder'), '');
    assert.equal(await run(['skill', 'install', '--dir', dir], {}, capture()), 0);

    const blocked = capture();
    assert.equal(await run(['skill', 'install', '--dir', dir], {}, blocked), 2);
    assert.equal(blocked.stderrJson.error.code, 'SKILL_ALREADY_INSTALLED');

    const forced = capture();
    assert.equal(await run(['skill', 'install', '--dir', dir, '--force'], {}, forced), 0);
    assert.deepEqual(forced.stdoutJson, {
      installed: true,
      skill: 'uptimer-cli',
      path: join(dir, 'uptimer-cli'),
      files: ['SKILL.md', join('references', 'commands.md')],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skill rejects unsupported subcommands and options before writing anything', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uptimer-skill-invalid-'));
  try {
    const cases: Array<[string[], string]> = [
      [['skill'], 'Use "skill install"'],
      [['skill', 'update'], 'Use "skill install"'],
      [['skill', 'install', 'extra'], 'Unexpected positional argument'],
      [['skill', 'install', '--limit', '10'], 'not supported for skill install'],
      [['skill', 'install', '--file', 'x.json'], 'not supported for skill install'],
    ];
    for (const [argv, message] of cases) {
      const io = capture();
      const code = await run([...argv, '--dir', dir], {}, io);
      assert.equal(code, 2, argv.join(' '));
      assert.match(io.stderrJson.error.code, /INVALID_ARGUMENT/);
      assert.equal(io.stdoutText, '');
      assert.ok(
        io.stderrJson.error.message.includes(message),
        `${argv.join(' ')} should report ${message}, got ${io.stderrJson.error.message}`,
      );
    }
    assert.equal(existsSync(join(dir, 'uptimer-cli')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
