// Copy the repository-owned skill into the package so `uptimer skill install` works
// from an npm install. Generated output is gitignored and rebuilt on every prepack.
import { cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const source = fileURLToPath(new URL('../../../skills/uptimer-cli', import.meta.url));
const target = fileURLToPath(new URL('../skill', import.meta.url));

await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
console.log(`Prepared skill files at ${target.replace(packageRoot, '.')}`);
