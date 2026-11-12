import { queuePublicHomepageSnapshotRefresh } from '../public/queue-refresh';
import { Hono } from 'hono';

import type { Env } from '../env';
import { AppError } from '../middleware/errors';
import { bumpHomepageSettingsGuardVersion } from '../public/homepage-guard-state';
import { parseSettingsPatch, patchSettings, readSettings } from '../settings';

export const adminSettingsRoutes = new Hono<{ Bindings: Env }>();

adminSettingsRoutes.get('/', async (c) => {
  const settings = await readSettings(c.env.DB);
  return c.json({ settings });
});

adminSettingsRoutes.patch('/', async (c) => {
  const rawBody = await c.req.json().catch(() => {
    throw new AppError(400, 'INVALID_ARGUMENT', 'Invalid JSON body');
  });

  const patch = parseSettingsPatch(rawBody);
  await patchSettings(c.env.DB, patch);
  await bumpHomepageSettingsGuardVersion(c.env.DB);

  queuePublicHomepageSnapshotRefresh(c);

  const settings = await readSettings(c.env.DB);
  return c.json({ settings });
});
