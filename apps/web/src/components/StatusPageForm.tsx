import { useMemo, useState } from 'react';

import type {
  CreateStatusPageInput,
  PatchStatusPageInput,
  StatusPage,
} from '../api/types';
import { useI18n } from '../app/I18nContext';
import { Button, FIELD_HELP_CLASS, FIELD_LABEL_CLASS, INPUT_CLASS, TEXTAREA_CLASS } from './ui';

const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function normalizeSlugDraft(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

type CommonProps = {
  onCancel: () => void;
  isLoading?: boolean;
  error?: string | undefined;
  monitors: Array<{ id: number; name: string }>;
};

type CreateProps = CommonProps & {
  page?: undefined;
  onSubmit: (input: CreateStatusPageInput) => void;
};

type EditProps = CommonProps & {
  page: StatusPage;
  onSubmit: (input: PatchStatusPageInput) => void;
};

export function StatusPageForm(props: CreateProps | EditProps) {
  const { t } = useI18n();
  const { page, onCancel, isLoading, monitors } = props;

  const [slug, setSlug] = useState(page?.slug ?? '');
  const [name, setName] = useState(page?.name ?? '');
  const [title, setTitle] = useState(page?.title ?? '');
  const [description, setDescription] = useState(page?.description ?? '');
  const [customHostname, setCustomHostname] = useState(page?.custom_hostname ?? '');
  const [logoUrl, setLogoUrl] = useState(page?.logo_url ?? '');
  const [isPublic, setIsPublic] = useState(page?.is_public ?? true);
  const [selectedMonitorIds, setSelectedMonitorIds] = useState<number[]>(
    page?.monitor_ids ?? [],
  );

  const slugError = useMemo(() => {
    const trimmed = slug.trim();
    if (trimmed.length === 0) return t('status_page_form.slug_required');
    if (trimmed.length > 64) return t('status_page_form.slug_too_long');
    if (!slugRegex.test(trimmed)) return t('status_page_form.slug_invalid');
    return null;
  }, [slug, t]);

  const canSubmit =
    name.trim().length > 0 &&
    title.trim().length > 0 &&
    description.length <= 500 &&
    slugError === null;

  const toggleMonitor = (monitorId: number, checked: boolean) => {
    setSelectedMonitorIds((prev) =>
      checked ? [...new Set([...prev, monitorId])] : prev.filter((id) => id !== monitorId),
    );
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    const trimmedSlug = slug.trim();
    const trimmedDescription = description.trim().slice(0, 500);
    const monitorIds = [...new Set(selectedMonitorIds)];
    const trimmedHostname = customHostname.trim();
    const trimmedLogoUrl = logoUrl.trim();

    if (page) {
      const data: PatchStatusPageInput = {
        slug: trimmedSlug,
        name: name.trim(),
        title: title.trim(),
        description: trimmedDescription,
        is_public: isPublic,
        custom_hostname: trimmedHostname === '' ? null : trimmedHostname,
        logo_url: trimmedLogoUrl === '' ? null : trimmedLogoUrl,
        monitor_ids: monitorIds,
      };
      props.onSubmit(data);
      return;
    }

    const data: CreateStatusPageInput = {
      slug: trimmedSlug,
      name: name.trim(),
      title: title.trim(),
      description: trimmedDescription,
      is_public: isPublic,
      custom_hostname: trimmedHostname === '' ? null : trimmedHostname,
      logo_url: trimmedLogoUrl === '' ? null : trimmedLogoUrl,
      monitor_ids: monitorIds,
    };
    props.onSubmit(data);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {props.error && (
        <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-400">
          {props.error}
        </div>
      )}

      <div>
        <label className={FIELD_LABEL_CLASS}>{t('status_page_form.name')}</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={INPUT_CLASS}
          required
        />
      </div>

      <div>
        <label className={FIELD_LABEL_CLASS}>{t('status_page_form.slug')}</label>
        <input
          value={slug}
          onChange={(e) => setSlug(normalizeSlugDraft(e.target.value))}
          className={INPUT_CLASS}
          placeholder={t('status_page_form.slug_placeholder')}
          required
        />
        {slugError ? (
          <div className="mt-1 text-xs text-red-600 dark:text-red-400">{slugError}</div>
        ) : (
          <div className={FIELD_HELP_CLASS}>{t('status_page_form.slug_help')}</div>
        )}
      </div>

      <div>
        <label className={FIELD_LABEL_CLASS}>{t('status_page_form.title')}</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className={INPUT_CLASS}
          required
        />
      </div>

      <div>
        <label className={FIELD_LABEL_CLASS}>{t('status_page_form.description')}</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value.slice(0, 500))}
          rows={3}
          className={TEXTAREA_CLASS}
          placeholder={t('status_page_form.description_placeholder')}
        />
        <div className={FIELD_HELP_CLASS}>{t('status_page_form.description_help')}</div>
      </div>

      <div>
        <label className={FIELD_LABEL_CLASS}>{t('status_page_form.logo_url')}</label>
        <input
          value={logoUrl}
          onChange={(e) => setLogoUrl(e.target.value)}
          className={INPUT_CLASS}
          placeholder={t('status_page_form.logo_url_placeholder')}
          autoComplete="off"
          spellCheck={false}
        />
        <div className={FIELD_HELP_CLASS}>{t('status_page_form.logo_url_help')}</div>
      </div>

      <div>
        <label className={FIELD_LABEL_CLASS}>{t('status_page_form.custom_hostname')}</label>
        <input
          value={customHostname}
          onChange={(e) => setCustomHostname(e.target.value)}
          className={INPUT_CLASS}
          placeholder={t('status_page_form.custom_hostname_placeholder')}
          autoComplete="off"
          spellCheck={false}
        />
        <div className={FIELD_HELP_CLASS}>{t('status_page_form.custom_hostname_help')}</div>
        {customHostname.trim() && (
          <div className={FIELD_HELP_CLASS}>
            {t('status_page_form.custom_hostname_result')}: https://{customHostname.trim().toLowerCase()}/
          </div>
        )}
      </div>

      <label className="flex items-start gap-3 text-sm text-slate-700 dark:text-slate-300">
        <input
          type="checkbox"
          checked={isPublic}
          onChange={(e) => setIsPublic(e.target.checked)}
          className="mt-1"
        />
        <span>
          <span className="font-medium text-slate-900 dark:text-slate-100">
            {t('status_page_form.is_public')}
          </span>
          <span className={`mt-1 block ${FIELD_HELP_CLASS}`}>
            {t('status_page_form.is_public_help')}
          </span>
        </span>
      </label>

      <div>
        <div className={FIELD_LABEL_CLASS}>{t('status_page_form.monitors')}</div>
        {monitors.length === 0 ? (
          <div className="text-sm text-slate-500 dark:text-slate-400">
            {t('status_page_form.no_monitors')}
          </div>
        ) : (
          <div className="max-h-40 overflow-y-auto border border-slate-200 dark:border-slate-600 rounded-lg p-3 space-y-2 bg-white dark:bg-slate-700">
            {monitors.map((m) => (
              <label
                key={m.id}
                className="flex items-center gap-2.5 text-sm cursor-pointer text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100"
              >
                <input
                  type="checkbox"
                  checked={selectedMonitorIds.includes(m.id)}
                  onChange={(e) => toggleMonitor(m.id, e.target.checked)}
                  className="rounded border-slate-300 dark:border-slate-500 text-slate-900 dark:text-slate-100 bg-white dark:bg-slate-600 focus:ring-slate-500"
                />
                <span>{m.name}</span>
              </label>
            ))}
          </div>
        )}
        <div className={FIELD_HELP_CLASS}>{t('status_page_form.monitors_help')}</div>
      </div>

      <div className="flex gap-3 pt-2">
        <Button type="button" variant="secondary" onClick={onCancel} className="flex-1">
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={isLoading || !canSubmit} className="flex-1">
          {isLoading ? t('common.saving') : page ? t('common.save') : t('common.create')}
        </Button>
      </div>
    </form>
  );
}
