import { useId, useMemo, useState } from 'react';
import type { CreateIncidentUpdateInput, IncidentStatus } from '../api/types';
import { useI18n } from '../app/I18nContext';
import { incidentStatusLabel } from '../i18n/labels';
import { Markdown } from './Markdown';
import { Button, FIELD_LABEL_CLASS, SELECT_CLASS, TEXTAREA_CLASS } from './ui';

const statusOptions: Array<Exclude<IncidentStatus, 'resolved'>> = [
  'investigating',
  'identified',
  'monitoring',
];
const selectClass = SELECT_CLASS;
const textareaClass = TEXTAREA_CLASS;
const labelClass = FIELD_LABEL_CLASS;

export function IncidentUpdateForm({
  onSubmit,
  onCancel,
  isLoading,
}: {
  onSubmit: (input: CreateIncidentUpdateInput) => void;
  onCancel: () => void;
  isLoading?: boolean;
}) {
  const { t } = useI18n();
  const fieldId = useId();
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<Exclude<IncidentStatus, 'resolved'> | ''>('');
  const normalized = useMemo(() => message.trim(), [message]);

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(status === '' ? { message: normalized } : { message: normalized, status });
      }}
    >
      <div>
        <label htmlFor={fieldId + '-0'} className={labelClass}>
          {t('incident_update.status')}
        </label>
        <select
          id={fieldId + '-0'}
          value={status}
          onChange={(e) => setStatus(e.target.value as Exclude<IncidentStatus, 'resolved'> | '')}
          className={selectClass}
        >
          <option value="">{t('incident_update.status_placeholder')}</option>
          {statusOptions.map((it) => (
            <option key={it} value={it}>
              {incidentStatusLabel(it, t)}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor={fieldId + '-1'} className={labelClass}>
          {t('incident_update.message')}
        </label>
        <textarea
          id={fieldId + '-1'}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={5}
          className={`${textareaClass} font-mono`}
          placeholder={t('incident_update.message_placeholder')}
          required
        />
      </div>

      {normalized && (
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
        <Button type="submit" disabled={isLoading || !normalized} className="flex-1">
          {isLoading ? t('common.saving') : t('incident_update.post_update')}
        </Button>
      </div>
    </form>
  );
}
