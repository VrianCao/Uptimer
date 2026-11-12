import { useId, useMemo, useState } from 'react';
import type { ResolveIncidentInput } from '../api/types';
import { useI18n } from '../app/I18nContext';
import { Markdown } from './Markdown';
import { Button, FIELD_LABEL_CLASS, TEXTAREA_CLASS } from './ui';

const textareaClass = TEXTAREA_CLASS;
const labelClass = FIELD_LABEL_CLASS;

export function ResolveIncidentForm({
  onSubmit,
  onCancel,
  isLoading,
}: {
  onSubmit: (input: ResolveIncidentInput) => void;
  onCancel: () => void;
  isLoading?: boolean;
}) {
  const { t } = useI18n();
  const fieldId = useId();
  const [message, setMessage] = useState('');
  const normalized = useMemo(() => message.trim(), [message]);

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(normalized ? { message: normalized } : {});
      }}
    >
      <div>
        <label htmlFor={fieldId + '-0'} className={labelClass}>
          {t('resolve_incident.message')}
        </label>
        <textarea
          id={fieldId + '-0'}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={4}
          className={`${textareaClass} font-mono`}
          placeholder={t('resolve_incident.message_placeholder')}
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
        <Button
          type="submit"
          disabled={isLoading}
          className="flex-1 !bg-emerald-600 hover:!bg-emerald-700"
        >
          {isLoading ? t('resolve_incident.resolving') : t('resolve_incident.resolve')}
        </Button>
      </div>
    </form>
  );
}
