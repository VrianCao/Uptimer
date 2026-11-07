import { z } from 'zod';

import { customWebhookChannelConfigSchema } from '@uptimer/db';

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

const telegramBotTokenSchema = z.string().trim().min(1).max(4096);

const notificationChannelTimeoutMsSchema = z.number().int().min(1).max(60000).optional();
const notificationMessageTemplateSchema = z.string().min(1).max(10_000).optional();

const notificationEventTypeSchema = z.enum([
  'monitor.down',
  'monitor.up',
  'incident.created',
  'incident.updated',
  'incident.resolved',
  'maintenance.started',
  'maintenance.ended',
  'test.ping',
]);

const telegramChannelBaseInputSchema = z.object({
  preset: z.literal('telegram'),
  chat_id: telegramChatIdSchema,
  bot_token: telegramBotTokenSchema.optional(),
  bot_token_secret_ref: workerSecretRefSchema.optional(),
  message_thread_id: z.number().int().positive().optional(),
  timeout_ms: notificationChannelTimeoutMsSchema,
  message_template: notificationMessageTemplateSchema,
  enabled_events: z.array(notificationEventTypeSchema).min(1).optional(),
  monitor_ids: z.array(z.number().int().positive()).max(200).optional(),
  parse_mode: z.enum(['Markdown', 'MarkdownV2', 'HTML']).optional(),
  disable_notification: z.boolean().optional(),
  protect_content: z.boolean().optional(),
});

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export const telegramChannelCreateInputSchema = telegramChannelBaseInputSchema.superRefine(
  (val, ctx) => {
    const hasDirectToken = hasText(val.bot_token);
    const hasSecretRef = hasText(val.bot_token_secret_ref);

    if (hasDirectToken === hasSecretRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bot_token'],
        message: 'provide exactly one of bot_token or bot_token_secret_ref',
      });
    }
  },
);

export const telegramChannelPatchInputSchema = telegramChannelBaseInputSchema.superRefine(
  (val, ctx) => {
    const hasDirectToken = hasText(val.bot_token);
    const hasSecretRef = hasText(val.bot_token_secret_ref);

    if (hasDirectToken && hasSecretRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bot_token'],
        message: 'provide only one of bot_token or bot_token_secret_ref',
      });
    }
  },
);

export type TelegramChannelCreateInput = z.infer<typeof telegramChannelCreateInputSchema>;
export type TelegramChannelPatchInput = z.infer<typeof telegramChannelPatchInputSchema>;

export const createNotificationChannelInputSchema = z.object({
  name: z.string().min(1),
  type: z.literal('webhook').default('webhook'),
  config_json: z.union([customWebhookChannelConfigSchema, telegramChannelCreateInputSchema]),
  is_active: z.boolean().optional(),
});

export type CreateNotificationChannelInput = z.infer<typeof createNotificationChannelInputSchema>;

export const patchNotificationChannelInputSchema = z
  .object({
    name: z.string().min(1).optional(),
    config_json: z
      .union([customWebhookChannelConfigSchema, telegramChannelPatchInputSchema])
      .optional(),
    is_active: z.boolean().optional(),
  })
  .refine((val) => Object.keys(val).length > 0, {
    message: 'At least one field must be provided',
  });

export type PatchNotificationChannelInput = z.infer<typeof patchNotificationChannelInputSchema>;
