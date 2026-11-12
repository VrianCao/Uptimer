import { useId, useMemo, useState } from 'react';
import type {
  CreateMaintenanceWindowInput,
  MaintenanceWindow,
  PatchMaintenanceWindowInput,
} from '../api/types';
import { useI18n } from '../app/I18nContext';
import { Markdown } from './Markdown';
import { Button, FIELD_LABEL_CLASS, INPUT_CLASS, TEXTAREA_CLASS } from './ui';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function toDatetimeLocal(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fromDatetimeLocal(value: string): number | null {
  if (!value) return null;
  const d = new Date(value);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

const inputClass = INPUT_CLASS;
const textareaClass = TEXTAREA_CLASS;
const labelClass = FIELD_LABEL_CLASS;

type CommonProps = {
  onCancel: () => void;
  isLoading?: boolean;
  monitors: Array<{ id: number; name: string }>;
};
type CreateProps = CommonProps & {
  window?: undefined;
  onSubmit: (input: CreateMaintenanceWindowInput) => void;
};
type EditProps = CommonProps & {
  window: MaintenanceWindow;
  onSubmit: (input: PatchMaintenanceWindowInput) => void;
};

export function MaintenanceWindowForm(props: CreateProps | EditProps) {
  const { window, onCancel, isLoading, monitors } = props;
  const { t } = useI18n();

  const fieldId = useId();
  const [title, setTitle] = useState(window?.title ?? '');
  const [message, setMessage] = useState(window?.message ?? '');
  const [startsAt, setStartsAt] = useState(window ? toDatetimeLocal(window.starts_at) : '');
  const [endsAt, setEndsAt] = useState(window ? toDatetimeLocal(window.ends_at) : '');
  const [selectedMonitorIds, setSelectedMonitorIds] = useState<number[]>(window?.monitor_ids ?? []);

  const normalized = useMemo(() => message.trim(), [message]);
  const parsed = useMemo(
    () => ({ starts_at: fromDatetimeLocal(startsAt), ends_at: fromDatetimeLocal(endsAt) }),
    [startsAt, endsAt],
  );

  const timeError =
    parsed.starts_at === null || parsed.ends_at === null
      ? t('maintenance_form.time_required')
      : parsed.starts_at >= parsed.ends_at
        ? t('maintenance_form.start_before_end')
        : null;
  const monitorsError =
    monitors.length === 0
      ? t('maintenance_form.no_monitors')
      : selectedMonitorIds.length === 0
        ? t('maintenance_form.select_at_least_one')
        : null;

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (
          timeError ||
          parsed.starts_at === null ||
          parsed.ends_at === null ||
          selectedMonitorIds.length === 0
        )
          return;
        const base = {
          title: title.trim(),
          starts_at: parsed.starts_at,
          ends_at: parsed.ends_at,
          monitor_ids: selectedMonitorIds,
        };
        if (props.window) props.onSubmit({ ...base, message: normalized || null });
        else props.onSubmit(normalized ? { ...base, message: normalized } : base);
      }}
    >
      <div>
        <div className={labelClass}>{t('maintenance_form.affected_monitors')}</div>
        {monitors.length === 0 ? (
          <div className="text-sm text-slate-500 dark:text-slate-400">
            {t('maintenance_form.no_monitors')}
          </div>
        ) : (
          <div className="max-h-40 overflow-y-auto border border-slate-200 dark:border-slate-600 rounded-lg p-3 space-y-2 bg-white dark:bg-slate-700">
            {monitors.map((m) => (
              <label
                key={m.id}
                className="flex items-center gap-2.5 text-sm text-slate-700 dark:text-slate-300 cursor-pointer hover:text-slate-900 dark:hover:text-slate-100"
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
                  className="rounded border-slate-300 dark:border-slate-500 dark:bg-slate-600"
                />
                <span>{m.name}</span>
              </label>
            ))}
          </div>
        )}
        {monitorsError && (
          <div className="mt-2 text-sm text-red-500 dark:text-red-400">{monitorsError}</div>
        )}
      </div>

      <div>
        <label htmlFor={fieldId + '-0'} className={labelClass}>
          {t('maintenance_form.title')}
        </label>
        <input
          id={fieldId + '-0'}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className={inputClass}
          placeholder={t('maintenance_form.title_placeholder')}
          required
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor={fieldId + '-1'} className={labelClass}>
            {t('maintenance_form.starts_at')}
          </label>
          <input
            id={fieldId + '-1'}
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            className={inputClass}
            required
          />
        </div>
        <div>
          <label htmlFor={fieldId + '-2'} className={labelClass}>
            {t('maintenance_form.ends_at')}
          </label>
          <input
            id={fieldId + '-2'}
            type="datetime-local"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
            className={inputClass}
            required
          />
        </div>
      </div>
      {timeError && <div className="text-sm text-red-500 dark:text-red-400">{timeError}</div>}

      <div>
        <label htmlFor={fieldId + '-3'} className={labelClass}>
          {t('maintenance_form.message')}
        </label>
        <textarea
          id={fieldId + '-3'}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={4}
          className={`${textareaClass} font-mono`}
          placeholder={t('maintenance_form.message_placeholder')}
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
          disabled={isLoading || !title.trim() || !!timeError || !selectedMonitorIds.length}
          className="flex-1"
        >
          {isLoading ? t('common.saving') : window ? t('common.save') : t('common.create')}
        </Button>
      </div>
    </form>
  );
}
