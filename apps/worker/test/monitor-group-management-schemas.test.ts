import { describe, expect, it } from 'vitest';

import {
  assignMonitorsToGroupInputSchema,
  createMonitorInputSchema,
  patchMonitorInputSchema,
  reorderMonitorGroupsInputSchema,
} from '../src/schemas/monitors';

describe('monitor group management schemas', () => {
  it('rejects duplicate group names when reordering', () => {
    const result = reorderMonitorGroupsInputSchema.safeParse({
      groups: [
        { group_name: 'Core', group_sort_order: 0 },
        { group_name: 'core', group_sort_order: 10 },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate monitor ids in bulk assignment', () => {
    const result = assignMonitorsToGroupInputSchema.safeParse({
      monitor_ids: [1, 2, 2],
      group_name: 'Core',
    });

    expect(result.success).toBe(false);
  });

  it('allows bulk assignment to ungrouped', () => {
    const result = assignMonitorsToGroupInputSchema.safeParse({
      monitor_ids: [1, 2, 3],
      group_name: null,
    });

    expect(result.success).toBe(true);
  });

  it('rejects invalid regex monitor assertions', () => {
    const result = createMonitorInputSchema.safeParse({
      name: 'Regex API',
      type: 'http',
      target: 'https://example.com/health',
      response_keyword: '(',
      response_keyword_mode: 'regex',
    });

    expect(result.success).toBe(false);
  });

  it('rejects HTTP-only assertion mode fields for tcp monitors', () => {
    const createResult = createMonitorInputSchema.safeParse({
      name: 'TCP Service',
      type: 'tcp',
      target: 'example.com:443',
      response_keyword_mode: 'regex',
    });
    expect(createResult.success).toBe(false);

  });

  it('rejects assertion modes without a corresponding response value', () => {
    const patchResult = patchMonitorInputSchema.safeParse({
      response_keyword: null,
      response_keyword_mode: 'regex',
    });

    expect(patchResult.success).toBe(false);
  });
});
