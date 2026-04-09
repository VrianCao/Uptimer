import { expectedStatusJsonSchema, httpHeadersJsonSchema } from '@uptimer/db';
import { z } from 'zod';

import {
  HTTP_RESPONSE_MATCH_MODES,
  validateHttpResponseAssertionConfig,
} from '../monitor/http-assertions';
import { validateHttpTarget, validateTcpTarget } from '../monitor/targets';

const monitorGroupNameSchema = z.string().trim().min(1).max(64);
const monitorGroupSortOrderSchema = z.number().int().min(-100_000).max(100_000);
const monitorSortOrderSchema = z.number().int().min(-100_000).max(100_000);
const httpResponseMatchModeSchema = z.enum(HTTP_RESPONSE_MATCH_MODES);

export const createMonitorInputSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(['http', 'tcp']),
    target: z.string().min(1),

    interval_sec: z.number().int().min(60).optional(),
    timeout_ms: z.number().int().min(1000).optional(),

    http_method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).optional(),
    http_headers_json: httpHeadersJsonSchema.optional(),
    http_body: z.string().optional(),
    expected_status_json: expectedStatusJsonSchema.optional(),
    response_keyword: z.string().min(1).optional(),
    response_keyword_mode: httpResponseMatchModeSchema.optional(),
    response_forbidden_keyword: z.string().min(1).optional(),
    response_forbidden_keyword_mode: httpResponseMatchModeSchema.optional(),

    group_name: monitorGroupNameSchema.optional(),
    group_sort_order: monitorGroupSortOrderSchema.optional(),
    sort_order: monitorSortOrderSchema.optional(),
    show_on_status_page: z.boolean().optional(),
    is_active: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    const err =
      val.type === 'http' ? validateHttpTarget(val.target) : validateTcpTarget(val.target);
    if (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: err, path: ['target'] });
    }

    if (
      val.type === 'tcp' &&
      (val.http_method !== undefined ||
        val.http_headers_json !== undefined ||
        val.http_body !== undefined ||
        val.expected_status_json !== undefined ||
        val.response_keyword !== undefined ||
        val.response_keyword_mode !== undefined ||
        val.response_forbidden_keyword !== undefined ||
        val.response_forbidden_keyword_mode !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'http_* fields are not allowed for tcp monitors',
      });
    }

    for (const issue of validateHttpResponseAssertionConfig({
      responseKeyword: val.response_keyword,
      responseKeywordMode: val.response_keyword_mode,
      responseForbiddenKeyword: val.response_forbidden_keyword,
      responseForbiddenKeywordMode: val.response_forbidden_keyword_mode,
    })) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: issue.path,
        message: issue.message,
      });
    }
  });

export type CreateMonitorInput = z.infer<typeof createMonitorInputSchema>;

export const patchMonitorInputSchema = z
  .object({
    name: z.string().min(1).optional(),
    target: z.string().min(1).optional(),

    interval_sec: z.number().int().min(60).optional(),
    timeout_ms: z.number().int().min(1000).optional(),

    http_method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).optional(),
    http_headers_json: httpHeadersJsonSchema.nullable().optional(),
    http_body: z.string().nullable().optional(),
    expected_status_json: expectedStatusJsonSchema.nullable().optional(),
    response_keyword: z.string().min(1).nullable().optional(),
    response_keyword_mode: httpResponseMatchModeSchema.nullable().optional(),
    response_forbidden_keyword: z.string().min(1).nullable().optional(),
    response_forbidden_keyword_mode: httpResponseMatchModeSchema.nullable().optional(),

    group_name: monitorGroupNameSchema.nullable().optional(),
    group_sort_order: monitorGroupSortOrderSchema.optional(),
    sort_order: monitorSortOrderSchema.optional(),
    show_on_status_page: z.boolean().optional(),
    is_active: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    for (const issue of validateHttpResponseAssertionConfig({
      responseKeyword: val.response_keyword,
      responseKeywordMode: val.response_keyword_mode,
      responseForbiddenKeyword: val.response_forbidden_keyword,
      responseForbiddenKeywordMode: val.response_forbidden_keyword_mode,
    })) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: issue.path,
        message: issue.message,
      });
    }
  })
  .refine((val) => Object.keys(val).length > 0, {
    message: 'At least one field must be provided',
  });

export type PatchMonitorInput = z.infer<typeof patchMonitorInputSchema>;

export const reorderMonitorGroupsInputSchema = z
  .object({
    groups: z
      .array(
        z.object({
          group_name: monitorGroupNameSchema.nullable(),
          group_sort_order: monitorGroupSortOrderSchema,
        }),
      )
      .min(1)
      .max(200),
  })
  .superRefine((val, ctx) => {
    const seen = new Set<string>();

    for (let i = 0; i < val.groups.length; i += 1) {
      const groupName = val.groups[i]?.group_name?.trim() ?? '';
      const key = groupName.length > 0 ? `name:${groupName.toLowerCase()}` : 'ungrouped';

      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['groups', i, 'group_name'],
          message: 'Duplicate group_name is not allowed',
        });
      }

      seen.add(key);
    }
  });

export type ReorderMonitorGroupsInput = z.infer<typeof reorderMonitorGroupsInputSchema>;

export const assignMonitorsToGroupInputSchema = z
  .object({
    monitor_ids: z.array(z.number().int().positive()).min(1).max(500),
    group_name: monitorGroupNameSchema.nullable(),
    group_sort_order: monitorGroupSortOrderSchema.optional(),
  })
  .superRefine((val, ctx) => {
    const seen = new Set<number>();
    for (let i = 0; i < val.monitor_ids.length; i += 1) {
      const id = val.monitor_ids[i];
      if (id === undefined) continue;
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['monitor_ids', i],
          message: 'Duplicate monitor id is not allowed',
        });
      }
      seen.add(id);
    }
  });

export type AssignMonitorsToGroupInput = z.infer<typeof assignMonitorsToGroupInputSchema>;
