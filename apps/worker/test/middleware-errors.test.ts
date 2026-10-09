import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  AppError,
  handleError,
  handleNotFound,
  type ErrorResponse,
} from '../src/middleware/errors';

function createContext() {
  return {
    json(body: unknown, status: number) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    },
  };
}

async function readErrorResponse(response: Response): Promise<ErrorResponse> {
  return (await response.json()) as ErrorResponse;
}

describe('middleware/errors', () => {
  it('returns a unified not-found payload', async () => {
    const res = handleNotFound(createContext() as never);
    expect(res.status).toBe(404);
    await expect(readErrorResponse(res)).resolves.toEqual({
      error: { code: 'NOT_FOUND', message: 'Not Found' },
    });
  });

  it('maps AppError to status/code/message without leaking internals', async () => {
    const res = handleError(
      new AppError(401, 'UNAUTHORIZED', 'Unauthorized'),
      createContext() as never,
    );
    expect(res.status).toBe(401);
    await expect(readErrorResponse(res)).resolves.toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
    });
  });

  it('maps Zod validation failures to INVALID_ARGUMENT', async () => {
    let zodErr: unknown;
    try {
      z.object({ name: z.string() }).parse({ name: 123 });
    } catch (err) {
      zodErr = err;
    }

    const res = handleError(zodErr, createContext() as never);
    expect(res.status).toBe(400);
    const payload = await readErrorResponse(res);
    expect(payload.error.code).toBe('INVALID_ARGUMENT');
    expect(payload.error.message).toMatch(/expected string/i);
  });

  it('maps unknown errors to INTERNAL and logs details server-side', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = handleError(new Error('boom'), createContext() as never);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);
    await expect(readErrorResponse(res)).resolves.toEqual({
      error: { code: 'INTERNAL', message: 'Internal Server Error' },
    });
    spy.mockRestore();
  });
});
