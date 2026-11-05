import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The packaged artifact is what users install, so verify it directly instead of
// trusting the source tree. Uses pnpm for packing because it is the pinned tool,
// and runs the shipped JavaScript with the workspace dependency tree linked in.
const packageRoot = fileURLToPath(new URL('..', import.meta.url));

test('the packed artifact ships runnable JavaScript, the skill, and no sources', () => {
  const temp = mkdtempSync(join(tmpdir(), 'uptimer-cli-package-'));
  try {
    const userConfig = join(temp, 'npmrc');
    writeFileSync(userConfig, '');
    const env = {
      ...process.env,
      NODE_NO_WARNINGS: '1',
      NPM_CONFIG_USERCONFIG: userConfig,
    };

    // pnpm prints the tarball path on stderr, so discover the file instead.
    execFileSync('pnpm', ['--dir', packageRoot, 'pack', '--pack-destination', temp], {
      env,
      stdio: 'ignore',
      timeout: 60_000,
    });
    const tarballs = readdirSync(temp).filter((name) => name.endsWith('.tgz'));
    assert.equal(tarballs.length, 1, `expected one tarball, found ${tarballs.join(', ')}`);
    const packOutput = join(temp, tarballs[0]!);

    const extractDir = join(temp, 'extracted');
    mkdirSync(extractDir);
    execFileSync('tar', ['-xzf', packOutput, '-C', extractDir], { env, timeout: 60_000 });
    const root = join(extractDir, 'package');
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      version: string;
      bin: Record<string, string>;
      private?: boolean;
      files?: string[];
      publishConfig?: { access?: string };
    };

    assert.equal(manifest.private, undefined, 'published package must not be private');
    assert.equal(manifest.publishConfig?.access, 'public');
    assert.equal(manifest.bin['uptimer'], './dist/index.js');
    for (const file of [
      'dist/index.js',
      'skill/SKILL.md',
      'skill/references/commands.md',
      'LICENSE',
      'README.md',
      'CHANGELOG.md',
    ]) {
      assert.ok(existsSync(join(root, file)), `packaged artifact must contain ${file}`);
    }
    assert.equal(existsSync(join(root, 'src')), false, 'sources must not ship');
    assert.equal(existsSync(join(root, 'test')), false, 'tests must not ship');
    assert.match(
      readFileSync(join(root, 'dist/index.js'), 'utf8').slice(0, 40),
      /^#!\/usr\/bin\/env node/,
    );

    // Link this package's installed dependencies so the shipped JavaScript resolves `zod`.
    // pnpm keeps them per package, so the workspace root has no top-level copy.
    symlinkSync(join(packageRoot, 'node_modules'), join(root, 'node_modules'), 'dir');

    const cli = join(root, manifest.bin['uptimer']);
    const options = {
      cwd: temp,
      env: { ...env, UPTIMER_URL: '', UPTIMER_ADMIN_TOKEN: '' },
      encoding: 'utf8' as const,
      timeout: 30_000,
    };

    const help = spawnSync(process.execPath, [cli, '--help'], options);
    assert.ifError(help.error);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Uptimer Agent Configuration CLI/);
    assert.equal(help.stderr, '');

    const missingCredentials = spawnSync(process.execPath, [cli, 'settings', 'get'], options);
    assert.ifError(missingCredentials.error);
    assert.equal(missingCredentials.status, 2);
    assert.equal(missingCredentials.stdout, '');
    assert.equal(
      (JSON.parse(missingCredentials.stderr) as { error: { code: string } }).error.code,
      'CONFIGURATION_ERROR',
    );

    // The packaged skill copy is what `uptimer skill install` writes for users.
    const skillsDir = join(temp, 'agent-skills');
    const install = spawnSync(
      process.execPath,
      [cli, 'skill', 'install', '--dir', skillsDir],
      options,
    );
    assert.ifError(install.error);
    assert.equal(install.status, 0, install.stderr);
    assert.equal(
      (JSON.parse(install.stdout) as { path: string }).path,
      join(skillsDir, 'uptimer-cli'),
    );
    assert.match(
      readFileSync(join(skillsDir, 'uptimer-cli/SKILL.md'), 'utf8'),
      /name: uptimer-cli/,
    );
    assert.ok(existsSync(join(skillsDir, 'uptimer-cli/references/commands.md')));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
