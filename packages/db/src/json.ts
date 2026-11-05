import { z } from 'zod';

export function parseDbJson<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  value: string,
  opts: { field?: string } = {},
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (err) {
    const field = opts.field ?? 'json';
    throw new Error(`Invalid JSON in ${field}: ${(err as Error).message}`);
  }

  const r = schema.safeParse(parsed);
  if (!r.success) {
    const field = opts.field ?? 'json';
    throw new Error(`Invalid value in ${field}: ${r.error.message}`);
  }
  return r.data;
}

export function parseDbJsonNullable<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  value: string | null,
  opts: { field?: string } = {},
): T | null {
  if (value === null) return null;
  return parseDbJson(schema, value, opts);
}

export function serializeDbJson<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  value: T,
  opts: { field?: string } = {},
): string {
  const r = schema.safeParse(value);
  if (!r.success) {
    const field = opts.field ?? 'json';
    throw new Error(`Invalid value in ${field}: ${r.error.message}`);
  }
  return JSON.stringify(r.data);
}

export function serializeDbJsonNullable<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  value: T | null,
  opts: { field?: string } = {},
): string | null {
  if (value === null) return null;
  return serializeDbJson(schema, value, opts);
}

export const httpHeadersJsonSchema = z.record(z.string());
export type HttpHeadersJson = z.infer<typeof httpHeadersJsonSchema>;

/** Single code (legacy) or inclusive range. Codes must be 100-599; ranges require from <= to. */
export const statusCodeRuleSchema = z.union([
  z.number().int().min(100).max(599),
  z
    .object({
      from: z.number().int().min(100).max(599),
      to: z.number().int().min(100).max(599),
    })
    .refine((rule) => rule.from <= rule.to, {
      message: 'status code range from must be <= to',
      path: ['to'],
    }),
]);
export type StatusCodeRule = z.infer<typeof statusCodeRuleSchema>;

/** Allow/deny list: non-empty array of exact codes and/or ranges. Empty → store null instead. */
export const statusCodeRulesJsonSchema = z.array(statusCodeRuleSchema).min(1).max(50);
export type StatusCodeRulesJson = z.infer<typeof statusCodeRulesJsonSchema>;

/** @deprecated Prefer StatusCodeRulesJson — kept for existing imports. */
export const expectedStatusJsonSchema = statusCodeRulesJsonSchema;
export type ExpectedStatusJson = StatusCodeRulesJson;

export const forbiddenStatusJsonSchema = statusCodeRulesJsonSchema;
export type ForbiddenStatusJson = StatusCodeRulesJson;

export function matchesStatusCodeRules(
  status: number,
  rules: readonly StatusCodeRule[] | null | undefined,
): boolean {
  if (!rules || rules.length === 0) return false;
  for (const rule of rules) {
    if (typeof rule === 'number') {
      if (rule === status) return true;
      continue;
    }
    if (status >= rule.from && status <= rule.to) return true;
  }
  return false;
}

/**
 * Blacklist first → allowlist (if present) → default 2xx.
 * - forbidden match → not accepted
 * - expected present → must match expected
 * - else → 2xx only
 */
export function isHttpStatusAccepted(
  status: number,
  opts: {
    expected?: readonly StatusCodeRule[] | null;
    forbidden?: readonly StatusCodeRule[] | null;
  } = {},
): boolean {
  if (matchesStatusCodeRules(status, opts.forbidden)) return false;
  if (opts.expected && opts.expected.length > 0) {
    return matchesStatusCodeRules(status, opts.expected);
  }
  return status >= 200 && status < 300;
}

export type HttpStatusRejectReason = 'forbidden' | 'unexpected';

export function evaluateHttpStatusCode(
  status: number,
  opts: {
    expected?: readonly StatusCodeRule[] | null;
    forbidden?: readonly StatusCodeRule[] | null;
  } = {},
): { ok: true } | { ok: false; reason: HttpStatusRejectReason } {
  if (matchesStatusCodeRules(status, opts.forbidden)) {
    return { ok: false, reason: 'forbidden' };
  }
  if (opts.expected && opts.expected.length > 0) {
    return matchesStatusCodeRules(status, opts.expected)
      ? { ok: true }
      : { ok: false, reason: 'unexpected' };
  }
  return status >= 200 && status < 300 ? { ok: true } : { ok: false, reason: 'unexpected' };
}

export const webhookSigningSchema = z.object({
  enabled: z.boolean(),
  secret_ref: z.string().min(1),
});

const notificationChannelTimeoutMsSchema = z.number().int().min(1).max(60000).optional();
const notificationMessageTemplateSchema = z.string().min(1).max(10_000).optional();

export const notificationEventTypeSchema = z.enum([
  'monitor.down',
  'monitor.up',
  'incident.created',
  'incident.updated',
  'incident.resolved',
  'maintenance.started',
  'maintenance.ended',
  'test.ping',
]);
export type NotificationEventType = z.infer<typeof notificationEventTypeSchema>;

const webhookUrlSchema = z
  .string()
  .url()
  .refine((val) => {
    try {
      const url = new URL(val);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'url protocol must be http or https');

export const customWebhookChannelConfigSchema = z
  .object({
    preset: z.literal('custom').optional().default('custom'),
    url: webhookUrlSchema,
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).default('POST'),
    headers: z.record(z.string()).optional(),
    timeout_ms: notificationChannelTimeoutMsSchema,
    payload_type: z.enum(['json', 'param', 'x-www-form-urlencoded']).default('json'),

    // Optional message template used by $MSG / {{message}} in payload templating.
    message_template: notificationMessageTemplateSchema,

    // Optional payload template. Strings inside this JSON value may reference magic variables.
    payload_template: z.unknown().optional(),

    // If omitted, the channel receives all events.
    enabled_events: z.array(notificationEventTypeSchema).min(1).optional(),

    signing: webhookSigningSchema.optional(),
  })
  .superRefine((val, ctx) => {
    if (val.payload_template === undefined) return;

    // For query param / form payloads we only support a flat key/value object.
    if (val.payload_type === 'param' || val.payload_type === 'x-www-form-urlencoded') {
      const pt = val.payload_template;
      const isObject = pt !== null && typeof pt === 'object' && !Array.isArray(pt);
      if (!isObject) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['payload_template'],
          message: `payload_template must be an object when payload_type is ${val.payload_type}`,
        });
        return;
      }

      for (const [k, v] of Object.entries(pt as Record<string, unknown>)) {
        if (v === null || v === undefined) continue;
        const t = typeof v;
        if (t === 'string' || t === 'number' || t === 'boolean') continue;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['payload_template', k],
          message: `payload_template.${k} must be a string/number/boolean/null for ${val.payload_type}`,
        });
      }
    }
  });
export type CustomWebhookChannelConfig = z.infer<typeof customWebhookChannelConfigSchema>;

const workerSecretRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'secret ref must be a valid Workers binding name');

const telegramChatIdSchema = z.preprocess(
  (value) => (typeof value === 'number' ? String(value) : value),
  z.string().trim().min(1).max(256),
);

export const telegramChannelConfigSchema = z
  .object({
    preset: z.literal('telegram'),
    bot_token_encrypted: z.string().min(1).max(8192).optional(),
    bot_token_secret_ref: workerSecretRefSchema.optional(),
    chat_id: telegramChatIdSchema,
    message_thread_id: z.number().int().positive().optional(),
    timeout_ms: notificationChannelTimeoutMsSchema,

    // Optional message template used as Telegram sendMessage.text.
    message_template: notificationMessageTemplateSchema,

    // If omitted, the channel receives all events.
    enabled_events: z.array(notificationEventTypeSchema).min(1).optional(),

    parse_mode: z.enum(['Markdown', 'MarkdownV2', 'HTML']).optional(),
    disable_notification: z.boolean().optional(),
    protect_content: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    const hasEncryptedToken =
      typeof val.bot_token_encrypted === 'string' && val.bot_token_encrypted.trim().length > 0;
    const hasSecretRef =
      typeof val.bot_token_secret_ref === 'string' && val.bot_token_secret_ref.trim().length > 0;

    if (hasEncryptedToken === hasSecretRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bot_token_encrypted'],
        message: 'provide exactly one of bot_token_encrypted or bot_token_secret_ref',
      });
    }
  });
export type TelegramChannelConfig = z.infer<typeof telegramChannelConfigSchema>;

export const webhookChannelConfigSchema = z.union([
  customWebhookChannelConfigSchema,
  telegramChannelConfigSchema,
]);
export type WebhookChannelConfig = z.infer<typeof webhookChannelConfigSchema>;
