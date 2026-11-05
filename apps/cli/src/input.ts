import * as fs from 'node:fs/promises';
import { CliError } from './errors.ts';

export async function readJsonPayload(
  filePath: string,
  stdin?: NodeJS.ReadableStream | AsyncIterable<string | Buffer>,
): Promise<Record<string, unknown>> {
  let content = '';

  if (filePath === '-') {
    if (!stdin) {
      throw new CliError(2, 'INVALID_ARGUMENT', 'No stdin stream available to read payload');
    }
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of stdin) {
        if (typeof chunk === 'string') {
          chunks.push(Buffer.from(chunk, 'utf8'));
        } else {
          chunks.push(chunk);
        }
      }
      content = Buffer.concat(chunks).toString('utf8');
    } catch {
      throw new CliError(2, 'INVALID_ARGUMENT', 'Failed to read payload from stdin');
    }
  } else {
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (err: unknown) {
      // Report the OS error code only; messages can embed path or input details.
      const code = (err as { code?: unknown } | null)?.code;
      const reason = typeof code === 'string' ? ` (${code})` : '';
      throw new CliError(2, 'INVALID_ARGUMENT', `Failed to read payload file "${filePath}"${reason}`);
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err: unknown) {
    // `JSON.parse` messages quote the offending input, which can hold secrets.
    const position = /at position (\d+)/.exec(err instanceof Error ? err.message : '')?.[1];
    throw new CliError(
      2,
      'INVALID_ARGUMENT',
      `Malformed JSON in payload${position ? ` at position ${position}` : ''}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliError(2, 'INVALID_ARGUMENT', 'Payload body must be a JSON object');
  }

  return parsed as Record<string, unknown>;
}
