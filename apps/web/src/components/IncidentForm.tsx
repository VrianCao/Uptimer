import { useId, useMemo, useState } from 'react';
import type { CreateIncidentInput, IncidentImpact, IncidentStatus } from '../api/types';
import { useI18n } from '../app/I18nContext';
import { incidentImpactLabel, incidentStatusLabel } from '../i18n/labels';
import { Markdown } from './Markdown';
import { Button, FIELD_LABEL_CLASS, INPUT_CLASS, SELECT_CLASS, TEXTAREA_CLASS } from './ui';

const impactOptions: IncidentImpact[] = ['none', 'minor', 'major', 'critical'];
const statusOptions: Array<Exclude<IncidentStatus, 'resolved'>> = [
  'investigating',
  'identified',
  'monitoring',
];

const inputClass = INPUT_CLASS;
const selectClass = SELECT_CLASS;
const textareaClass = TEXTAREA_CLASS;
const labelClass = FIELD_LABEL_CLASS;

export function IncidentForm({
  monitors,
  onSubmit,
  onCancel,
  isLoading,
}: {
  monitors: Array<{ id: number; name: string }>;
  onSubmit: (input: CreateIncidentInput) => void;
  onCancel: () => void;
  isLoading?: boolean;
}) {
  const fieldId = useId();
  const [title, setTitle] = useState('');
  const [impact, setImpact] = useState<IncidentImpact>('minor');
  const [status, setStatus] = useState<Exclude<IncidentStatus, 'resolved'>>('investigating');
  const [message, setMessage] = useState('');
  const [selectedMonitorIds, setSelectedMonitorIds] = useState<number[]>([]);
  const { t } = useI18n();

  const normalized = useMemo(() => message.trim(), [message]);

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (selectedMonitorIds.length === 0) return;
        const base: CreateIncidentInput = {
          title: title.trim(),
          impact,
          status,
          monitor_ids: selectedMonitorIds,
        };
        onSubmit(normalized.length > 0 ? { ...base, message: normalized } : base);
      }}
    >
      <div>
        <div className={labelClass}>{t('incident_form.affected_monitors')}</div>
        {monitors.length === 0 ? (
          <div className="text-sm text-slate-500 dark:text-slate-400">
            {t('incident_form.no_monitors_available')}
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
                  onChange={(e) =>
                    setSelectedMonitorIds(
                      e.target.checked
                        ? [...selectedMonitorIds, m.id]
                        : selectedMonitorIds.filter((id) => id !== m.id),
                    )
                  }
                  className="rounded border-slate-300 dark:border-slate-500 text-slate-900 dark:text-slate-100 bg-white dark:bg-slate-600 focus:ring-slate-500"
                />
                <span>{m.name}</span>
              </label>
            ))}
          </div>
        )}
        {monitors.length > 0 && selectedMonitorIds.length === 0 && (
          <div className="mt-2 text-sm text-red-500 dark:text-red-400">
            {t('incident_form.select_at_least_one')}
          </div>
        )}
      </div>

      <div>
        <label htmlFor={fieldId + '-0'} className={labelClass}>
          {t('common.title_label')}
        </label>
        <input
          id={fieldId + '-0'}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className={inputClass}
          placeholder={t('incident_form.title_placeholder')}
          required
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor={fieldId + '-1'} className={labelClass}>
            {t('common.impact')}
          </label>
          <select
            id={fieldId + '-1'}
            value={impact}
            onChange={(e) => setImpact(e.target.value as IncidentImpact)}
            className={selectClass}
          >
            {impactOptions.map((it) => (
              <option key={it} value={it}>
                {incidentImpactLabel(it, t)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={fieldId + '-2'} className={labelClass}>
            {t('incident_update.status')}
          </label>
          <select
            id={fieldId + '-2'}
            value={status}
            onChange={(e) => setStatus(e.target.value as Exclude<IncidentStatus, 'resolved'>)}
            className={selectClass}
          >
            {statusOptions.map((it) => (
              <option key={it} value={it}>
                {incidentStatusLabel(it, t)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label htmlFor={fieldId + '-3'} className={labelClass}>
          {t('incident_form.message_markdown')}
        </label>
        <textarea
          id={fieldId + '-3'}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={5}
          className={`${textareaClass} font-mono`}
          placeholder={t('incident_form.message_placeholder')}
        />
      </div>

      {normalized.length > 0 && (
        <div>
          <div className={labelClass}>{t('common.preview')}</div>
          <div className="border border-slate-200 dark:border-slate-600 rounded-lg p-4 bg-slate-50 dark:bg-slate-700/50">
            <Markdown text={normalized} />
          </div>
        </div>
      )}

      <div className="flex gap-3 pt-2">
        <Button type="button" variant="secondary" onClick={onCancel} className="flex-1">
          {t('common.cancel')}
        </Button>
        <Button
          type="submit"
          disabled={isLoading || !title.trim() || selectedMonitorIds.length === 0}
          className="flex-1"
        >
          {isLoading ? t('common.saving') : t('common.create')}
        </Button>
      </div>
    </form>
  );
}
