import { redactCredentials } from './redact.ts';

export interface JsonErrorEnvelope {
  error: {
    code: string;
    message: string;
    status?: number;
  };
}

export class CliError extends Error {
  readonly exitCode: 1 | 2;
  readonly code: string;
  readonly status?: number | undefined;

  constructor(exitCode: 1 | 2, code: string, message: string, status?: number) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.code = code;
    this.status = status;
  }
}

export function formatErrorEnvelope(
  error: unknown,
  adminToken?: string,
): JsonErrorEnvelope {
  if (error instanceof CliError) {
    const envelope: JsonErrorEnvelope = {
      error: {
        code: error.code,
        message: error.message,
        ...(error.status !== undefined ? { status: error.status } : {}),
      },
    };
    return redactCredentials(envelope, adminToken) as JsonErrorEnvelope;
  }

  const rawMessage = error instanceof Error ? error.message : String(error);
  const envelope: JsonErrorEnvelope = {
    error: {
      code: 'INTERNAL_ERROR',
      message: rawMessage,
    },
  };
  return redactCredentials(envelope, adminToken) as JsonErrorEnvelope;
}
