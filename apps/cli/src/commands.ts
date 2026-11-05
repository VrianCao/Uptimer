import { z } from 'zod';
import { CliError } from './errors.ts';
import { readJsonPayload } from './input.ts';
import { installSkill } from './skill.ts';
import { executeApiRequest, type TransportOptions } from './transport.ts';

const monitorsListEnvelope = z.object({
  monitors: z.array(z.record(z.unknown())),
});

const monitorEnvelope = z.object({
  monitor: z.record(z.unknown()),
});

const deletedEnvelope = z.object({
  deleted: z.boolean(),
});

const monitorGroupsReorderEnvelope = z.object({
  updated_groups: z.number(),
  affected_monitors: z.number(),
});

const monitorGroupsAssignEnvelope = z.object({
  // The server returns null when monitors are removed from a group.
  group_name: z.string().nullable(),
  group_sort_order: z.number(),
  updated_monitors: z.number(),
});

const notificationChannelsListEnvelope = z.object({
  notification_channels: z.array(z.record(z.unknown())),
});

const notificationChannelEnvelope = z.object({
  notification_channel: z.record(z.unknown()),
});

const statusPagesListEnvelope = z.object({
  status_pages: z.array(z.record(z.unknown())),
});

const statusPageEnvelope = z.object({
  status_page: z.record(z.unknown()),
});

const settingsEnvelope = z.object({
  settings: z.record(z.unknown()),
});

const uptimeRatingEnvelope = z.object({
  uptime_rating_level: z.number(),
});

export interface ParsedCommand {
  positionals: string[];
  options: {
    limit?: string | undefined;
    file?: string | undefined;
    dir?: string | undefined;
    force: boolean;
  };
  isHelp: boolean;
}

type CommandOptions = ParsedCommand['options'];

// A repeated option silently changes the request (last value wins), so reject it.
function assertUnset(value: string | undefined, option: string): void {
  if (value !== undefined) {
    throw new CliError(2, 'INVALID_ARGUMENT', `Option ${option} may only be given once`);
  }
}

export function parseArgs(argv: string[]): ParsedCommand {
  const positionals: string[] = [];
  const options: CommandOptions = { force: false };
  let isHelp = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      isHelp = true;
      continue;
    }
    if (arg === '--force') {
      options.force = true;
      continue;
    }
    if (arg.startsWith('--dir=')) {
      assertUnset(options.dir, '--dir');
      options.dir = arg.slice(6);
      continue;
    }
    if (arg === '--dir') {
      assertUnset(options.dir, '--dir');
      i++;
      if (i >= argv.length) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Option --dir requires a value');
      }
      options.dir = argv[i]!;
      continue;
    }
    if (arg.startsWith('--limit=')) {
      assertUnset(options.limit, '--limit');
      options.limit = arg.slice(8);
      continue;
    }
    if (arg === '--limit') {
      assertUnset(options.limit, '--limit');
      i++;
      if (i >= argv.length || argv[i]!.startsWith('--')) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Option --limit requires a value');
      }
      options.limit = argv[i]!;
      continue;
    }
    if (arg.startsWith('--file=')) {
      assertUnset(options.file, '--file');
      options.file = arg.slice(7);
      continue;
    }
    if (arg === '--file') {
      assertUnset(options.file, '--file');
      i++;
      if (i >= argv.length) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Option --file requires a value');
      }
      options.file = argv[i]!;
      continue;
    }
    if (arg.startsWith('--') || /^-[a-zA-Z]/.test(arg)) {
      throw new CliError(2, 'INVALID_ARGUMENT', `Unknown option: "${arg}"`);
    }
    positionals.push(arg);
  }

  return { positionals, options, isHelp };
}

function parseId(raw: string | undefined): number {
  if (!raw) {
    throw new CliError(2, 'INVALID_ARGUMENT', 'Resource ID is required');
  }
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new CliError(2, 'INVALID_ARGUMENT', `Invalid ID: "${raw}". ID must be a positive integer.`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new CliError(2, 'INVALID_ARGUMENT', `Invalid ID: "${raw}". ID must be a positive safe integer.`);
  }
  return n;
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) {
    return 50;
  }
  if (!/^\d+$/.test(raw)) {
    throw new CliError(2, 'INVALID_ARGUMENT', `Invalid limit: "${raw}". Limit must be an integer between 1 and 200.`);
  }
  const n = Number(raw);
  if (n < 1 || n > 200 || !Number.isSafeInteger(n)) {
    throw new CliError(2, 'INVALID_ARGUMENT', `Invalid limit: "${raw}". Limit must be between 1 and 200.`);
  }
  return n;
}

export async function executeCommand(
  parsed: ParsedCommand,
  transportOptions: TransportOptions,
  stdin?: NodeJS.ReadableStream | AsyncIterable<string | Buffer>,
): Promise<unknown> {
  const { positionals, options } = parsed;

  if (positionals.length === 0) {
    throw new CliError(2, 'INVALID_ARGUMENT', 'No command provided. Run with --help for usage.');
  }

  const family = positionals[0]!;

  if (family === 'skill') {
    if (positionals[1] !== 'install') {
      throw new CliError(2, 'INVALID_ARGUMENT', 'Use "skill install" to install the agent skill locally');
    }
    if (positionals.length > 2) {
      throw new CliError(2, 'INVALID_ARGUMENT', `Unexpected positional argument: "${positionals[2]}"`);
    }
    if (options.file !== undefined || options.limit !== undefined) {
      throw new CliError(2, 'INVALID_ARGUMENT', 'Options --file and --limit are not supported for skill install');
    }
    return await installSkill({ dir: options.dir ?? 'skills', force: options.force });
  }

  if (family === 'monitors') {
    const action = positionals[1];
    if (!action) {
      throw new CliError(2, 'INVALID_ARGUMENT', 'Missing subcommand for monitors. Run with --help for usage.');
    }

    if (action === 'groups') {
      const subAction = positionals[2];
      if (!subAction) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Missing subcommand for monitors groups. Use "reorder" or "assign".');
      }
      if (positionals.length > 3) {
        throw new CliError(2, 'INVALID_ARGUMENT', `Unexpected positional argument: "${positionals[3]}"`);
      }
      if (options.limit !== undefined) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Option --limit is not supported for monitors groups');
      }
      if (!options.file) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Option --file is required for monitors groups operations');
      }

      if (subAction === 'reorder') {
        const payload = await readJsonPayload(options.file, stdin);
        return await executeApiRequest(
          'POST',
          '/monitors/groups/reorder',
          payload,
          monitorGroupsReorderEnvelope,
          transportOptions,
        );
      }
      if (subAction === 'assign') {
        const payload = await readJsonPayload(options.file, stdin);
        return await executeApiRequest(
          'POST',
          '/monitors/groups/assign',
          payload,
          monitorGroupsAssignEnvelope,
          transportOptions,
        );
      }
      throw new CliError(2, 'INVALID_ARGUMENT', `Unknown subcommand for monitors groups: "${subAction}"`);
    }

    if (action === 'list') {
      if (positionals.length > 2) {
        throw new CliError(2, 'INVALID_ARGUMENT', `Unexpected positional argument: "${positionals[2]}"`);
      }
      if (options.file !== undefined) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Option --file is not supported for monitors list');
      }
      const limit = parseLimit(options.limit);
      return await executeApiRequest(
        'GET',
        `/monitors?limit=${limit}`,
        undefined,
        monitorsListEnvelope,
        transportOptions,
      );
    }

    if (action === 'create') {
      if (positionals.length > 2) {
        throw new CliError(2, 'INVALID_ARGUMENT', `Unexpected positional argument: "${positionals[2]}"`);
      }
      if (options.limit !== undefined) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Option --limit is not supported for monitors create');
      }
      if (!options.file) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Option --file is required for monitors create');
      }
      const payload = await readJsonPayload(options.file, stdin);
      return await executeApiRequest('POST', '/monitors', payload, monitorEnvelope, transportOptions);
    }

    if (action === 'update') {
      if (positionals.length < 3) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Missing monitor ID for update');
      }
      if (positionals.length > 3) {
        throw new CliError(2, 'INVALID_ARGUMENT', `Unexpected positional argument: "${positionals[3]}"`);
      }
      const id = parseId(positionals[2]);
      if (options.limit !== undefined) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Option --limit is not supported for monitors update');
      }
      if (!options.file) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Option --file is required for monitors update');
      }
      const payload = await readJsonPayload(options.file, stdin);
      return await executeApiRequest('PATCH', `/monitors/${id}`, payload, monitorEnvelope, transportOptions);
    }

    if (action === 'delete') {
      if (positionals.length < 3) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Missing monitor ID for delete');
      }
      if (positionals.length > 3) {
        throw new CliError(2, 'INVALID_ARGUMENT', `Unexpected positional argument: "${positionals[3]}"`);
      }
      const id = parseId(positionals[2]);
      if (options.limit !== undefined || options.file !== undefined) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Options are not supported for monitors delete');
      }
      return await executeApiRequest('DELETE', `/monitors/${id}`, undefined, deletedEnvelope, transportOptions);
    }

    if (action === 'pause') {
      if (positionals.length < 3) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Missing monitor ID for pause');
      }
      if (positionals.length > 3) {
        throw new CliError(2, 'INVALID_ARGUMENT', `Unexpected positional argument: "${positionals[3]}"`);
      }
      const id = parseId(positionals[2]);
      if (options.limit !== undefined || options.file !== undefined) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Options are not supported for monitors pause');
      }
      return await executeApiRequest('POST', `/monitors/${id}/pause`, undefined, monitorEnvelope, transportOptions);
    }

    if (action === 'resume') {
      if (positionals.length < 3) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Missing monitor ID for resume');
      }
      if (positionals.length > 3) {
        throw new CliError(2, 'INVALID_ARGUMENT', `Unexpected positional argument: "${positionals[3]}"`);
      }
      const id = parseId(positionals[2]);
      if (options.limit !== undefined || options.file !== undefined) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Options are not supported for monitors resume');
      }
      return await executeApiRequest('POST', `/monitors/${id}/resume`, undefined, monitorEnvelope, transportOptions);
    }

    throw new CliError(2, 'INVALID_ARGUMENT', `Unknown action for monitors: "${action}"`);
  }

  if (family === 'notification-channels') {
    const action = positionals[1];
    if (!action) {
      throw new CliError(2, 'INVALID_ARGUMENT', 'Missing subcommand for notification-channels');
    }

    if (action === 'list') {
      if (positionals.length > 2) {
        throw new CliError(2, 'INVALID_ARGUMENT', `Unexpected positional argument: "${positionals[2]}"`);
      }
      if (options.file !== undefined) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Option --file is not supported for notification-channels list');
      }
      const limit = parseLimit(options.limit);
      return await executeApiRequest(
        'GET',
        `/notification-channels?limit=${limit}`,
        undefined,
        notificationChannelsListEnvelope,
        transportOptions,
      );
    }

    if (action === 'create') {
      if (positionals.length > 2) {
        throw new CliError(2, 'INVALID_ARGUMENT', `Unexpected positional argument: "${positionals[2]}"`);
      }
      if (options.limit !== undefined) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Option --limit is not supported for notification-channels create');
      }
      if (!options.file) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Option --file is required for notification-channels create');
      }
      const payload = await readJsonPayload(options.file, stdin);
      return await executeApiRequest(
        'POST',
        '/notification-channels',
        payload,
        notificationChannelEnvelope,
        transportOptions,
      );
    }

    if (action === 'update') {
      if (positionals.length < 3) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Missing notification-channel ID for update');
      }
      if (positionals.length > 3) {
        throw new CliError(2, 'INVALID_ARGUMENT', `Unexpected positional argument: "${positionals[3]}"`);
      }
      const id = parseId(positionals[2]);
      if (options.limit !== undefined) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Option --limit is not supported for notification-channels update');
      }
      if (!options.file) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Option --file is required for notification-channels update');
      }
      const payload = await readJsonPayload(options.file, stdin);
      return await executeApiRequest(
        'PATCH',
        `/notification-channels/${id}`,
        payload,
        notificationChannelEnvelope,
        transportOptions,
      );
    }

    if (action === 'delete') {
      if (positionals.length < 3) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Missing notification-channel ID for delete');
      }
      if (positionals.length > 3) {
        throw new CliError(2, 'INVALID_ARGUMENT', `Unexpected positional argument: "${positionals[3]}"`);
      }
      const id = parseId(positionals[2]);
      if (options.limit !== undefined || options.file !== undefined) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Options are not supported for notification-channels delete');
      }
      return await executeApiRequest(
        'DELETE',
        `/notification-channels/${id}`,
        undefined,
        deletedEnvelope,
        transportOptions,
      );
    }

    throw new CliError(2, 'INVALID_ARGUMENT', `Unknown action for notification-channels: "${action}"`);
  }

  if (family === 'status-pages') {
    const action = positionals[1];
    if (!action) {
      throw new CliError(2, 'INVALID_ARGUMENT', 'Missing subcommand for status-pages');
    }

    if (action === 'list') {
      if (positionals.length > 2) {
        throw new CliError(2, 'INVALID_ARGUMENT', `Unexpected positional argument: "${positionals[2]}"`);
      }
      if (options.limit !== undefined || options.file !== undefined) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Options are not supported for status-pages list');
      }
      return await executeApiRequest('GET', '/status-pages', undefined, statusPagesListEnvelope, transportOptions);
    }

    if (action === 'create') {
      if (positionals.length > 2) {
        throw new CliError(2, 'INVALID_ARGUMENT', `Unexpected positional argument: "${positionals[2]}"`);
      }
      if (options.limit !== undefined) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Option --limit is not supported for status-pages create');
      }
      if (!options.file) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Option --file is required for status-pages create');
      }
      const payload = await readJsonPayload(options.file, stdin);
      return await executeApiRequest('POST', '/status-pages', payload, statusPageEnvelope, transportOptions);
    }

    if (action === 'update') {
      if (positionals.length < 3) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Missing status-page ID for update');
      }
      if (positionals.length > 3) {
        throw new CliError(2, 'INVALID_ARGUMENT', `Unexpected positional argument: "${positionals[3]}"`);
      }
      const id = parseId(positionals[2]);
      if (options.limit !== undefined) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Option --limit is not supported for status-pages update');
      }
      if (!options.file) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Option --file is required for status-pages update');
      }
      const payload = await readJsonPayload(options.file, stdin);
      return await executeApiRequest('PATCH', `/status-pages/${id}`, payload, statusPageEnvelope, transportOptions);
    }

    if (action === 'delete') {
      if (positionals.length < 3) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Missing status-page ID for delete');
      }
      if (positionals.length > 3) {
        throw new CliError(2, 'INVALID_ARGUMENT', `Unexpected positional argument: "${positionals[3]}"`);
      }
      const id = parseId(positionals[2]);
      if (options.limit !== undefined || options.file !== undefined) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Options are not supported for status-pages delete');
      }
      return await executeApiRequest('DELETE', `/status-pages/${id}`, undefined, deletedEnvelope, transportOptions);
    }

    throw new CliError(2, 'INVALID_ARGUMENT', `Unknown action for status-pages: "${action}"`);
  }

  if (family === 'settings') {
    const action = positionals[1];
    if (!action) {
      throw new CliError(2, 'INVALID_ARGUMENT', 'Missing subcommand for settings');
    }

    if (action === 'uptime-rating') {
      const subAction = positionals[2];
      if (!subAction) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Missing subcommand for settings uptime-rating. Use "get" or "update".');
      }
      if (positionals.length > 3) {
        throw new CliError(2, 'INVALID_ARGUMENT', `Unexpected positional argument: "${positionals[3]}"`);
      }

      if (subAction === 'get') {
        if (options.limit !== undefined || options.file !== undefined) {
          throw new CliError(2, 'INVALID_ARGUMENT', 'Options are not supported for settings uptime-rating get');
        }
        return await executeApiRequest(
          'GET',
          '/settings/uptime-rating',
          undefined,
          uptimeRatingEnvelope,
          transportOptions,
        );
      }

      if (subAction === 'update') {
        if (options.limit !== undefined) {
          throw new CliError(2, 'INVALID_ARGUMENT', 'Option --limit is not supported for settings uptime-rating update');
        }
        if (!options.file) {
          throw new CliError(2, 'INVALID_ARGUMENT', 'Option --file is required for settings uptime-rating update');
        }
        const payload = await readJsonPayload(options.file, stdin);
        return await executeApiRequest(
          'PUT',
          '/settings/uptime-rating',
          payload,
          uptimeRatingEnvelope,
          transportOptions,
        );
      }

      throw new CliError(2, 'INVALID_ARGUMENT', `Unknown subcommand for settings uptime-rating: "${subAction}"`);
    }

    if (action === 'get') {
      if (positionals.length > 2) {
        throw new CliError(2, 'INVALID_ARGUMENT', `Unexpected positional argument: "${positionals[2]}"`);
      }
      if (options.limit !== undefined || options.file !== undefined) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Options are not supported for settings get');
      }
      return await executeApiRequest('GET', '/settings', undefined, settingsEnvelope, transportOptions);
    }

    if (action === 'update') {
      if (positionals.length > 2) {
        throw new CliError(2, 'INVALID_ARGUMENT', `Unexpected positional argument: "${positionals[2]}"`);
      }
      if (options.limit !== undefined) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Option --limit is not supported for settings update');
      }
      if (!options.file) {
        throw new CliError(2, 'INVALID_ARGUMENT', 'Option --file is required for settings update');
      }
      const payload = await readJsonPayload(options.file, stdin);
      return await executeApiRequest('PATCH', '/settings', payload, settingsEnvelope, transportOptions);
    }

    throw new CliError(2, 'INVALID_ARGUMENT', `Unknown action for settings: "${action}"`);
  }

  throw new CliError(2, 'INVALID_ARGUMENT', `Unknown command family: "${family}"`);
}
