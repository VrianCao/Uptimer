#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, executeCommand } from './commands.ts';
import { CliError, formatErrorEnvelope } from './errors.ts';
import { getHelpText } from './help.ts';

export interface RunIO {
  stdout?: { write: (str: string) => boolean | void };
  stderr?: { write: (str: string) => boolean | void };
  stdin?: NodeJS.ReadableStream | AsyncIterable<string | Buffer>;
}

export interface RunOptions {
  argv: string[];
  env?: Record<string, string | undefined>;
  stdout?: { write: (str: string) => boolean | void };
  stderr?: { write: (str: string) => boolean | void };
  stdin?: NodeJS.ReadableStream | AsyncIterable<string | Buffer>;
  fetchFn?: typeof globalThis.fetch;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export async function run(
  argvOrOptions: string[] | RunOptions,
  envParam?: Record<string, string | undefined>,
  ioParam?: RunIO,
  fetchParam?: typeof globalThis.fetch,
  timeoutParam?: number,
): Promise<number> {
  let argv: string[];
  let env: Record<string, string | undefined>;
  let stdout: { write: (str: string) => boolean | void };
  let stderr: { write: (str: string) => boolean | void };
  let stdin: NodeJS.ReadableStream | AsyncIterable<string | Buffer> | undefined;
  let fetchFn: typeof globalThis.fetch | undefined;
  let timeoutMs: number | undefined;

  if (Array.isArray(argvOrOptions)) {
    argv = argvOrOptions;
    env = envParam ?? process.env;
    stdout = ioParam?.stdout ?? process.stdout;
    stderr = ioParam?.stderr ?? process.stderr;
    stdin = ioParam?.stdin ?? process.stdin;
    fetchFn = fetchParam;
    timeoutMs = timeoutParam;
  } else {
    argv = argvOrOptions.argv;
    env = argvOrOptions.env ?? process.env;
    stdout = argvOrOptions.stdout ?? process.stdout;
    stderr = argvOrOptions.stderr ?? process.stderr;
    stdin = argvOrOptions.stdin ?? process.stdin;
    fetchFn = argvOrOptions.fetchFn ?? argvOrOptions.fetch;
    timeoutMs = argvOrOptions.timeoutMs;
  }

  try {
    const parsed = parseArgs(argv);

    if (parsed.isHelp || (parsed.positionals.length === 1 && parsed.positionals[0] === 'help')) {
      stdout.write(getHelpText());
      return 0;
    }

    const result = await executeCommand(parsed, { env, fetchFn, timeoutMs }, stdin);

    stdout.write(JSON.stringify(result) + '\n');
    return 0;
  } catch (err: unknown) {
    const exitCode = err instanceof CliError ? err.exitCode : 1;
    const envelope = formatErrorEnvelope(err, env.UPTIMER_ADMIN_TOKEN);
    stderr.write(JSON.stringify(envelope) + '\n');
    return exitCode;
  }
}

// Auto-run if executed directly as script
const currentFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (entryFile === currentFile) {
  run(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
