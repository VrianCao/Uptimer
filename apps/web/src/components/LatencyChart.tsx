import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import type { LatencyPoint } from '../api/types';
import { useI18n } from '../app/I18nContext';
import { useTheme } from '../app/ThemeContext';
import { useReducedMotion } from '../utils/useReducedMotion';
import { suggestLatencyAxisCeiling } from '../utils/latencyScale';

interface LatencyChartProps {
  points: LatencyPoint[];
  height?: number;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function LatencyChart({ points, height = 200 }: LatencyChartProps) {
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const reducedMotion = useReducedMotion();

  const rawData = points
    .filter((p) => p.status === 'up' && p.latency_ms !== null)
    .map((p) => ({
      time: p.checked_at,
      latency: p.latency_ms as number,
    }));
  const axisCeiling = suggestLatencyAxisCeiling(rawData.map((point) => point.latency));
  const data = rawData.map((point) => ({
    ...point,
    latency_plot: axisCeiling !== null && point.latency > axisCeiling ? null : point.latency,
  }));
  const yAxisDomainProps =
    axisCeiling === null
      ? {}
      : { domain: [0, axisCeiling] as [number, number], allowDataOverflow: true };

  if (rawData.length === 0) {
    return (
      <div className="flex items-center justify-center h-[200px] text-slate-500 dark:text-slate-400">
        {t('common.no_latency_data')}
      </div>
    );
  }

  const axisColor = isDark ? '#64748b' : '#9ca3af';
  const lineColor = isDark ? '#34d399' : '#22c55e';

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
        <XAxis
          dataKey="time"
          tickFormatter={formatTime}
          tick={{ fontSize: 12, fill: axisColor }}
          stroke={axisColor}
        />
        <YAxis
          tick={{ fontSize: 12, fill: axisColor }}
          stroke={axisColor}
          {...yAxisDomainProps}
          tickFormatter={(v) => `${v}ms`}
        />
        <Tooltip
          labelFormatter={(v) => new Date(Number(v) * 1000).toLocaleString()}
          formatter={(_value: number, _name, item: unknown) => {
            const rawLatency = (item as { payload?: { latency?: number } }).payload?.latency;
            return [
              typeof rawLatency === 'number' ? `${rawLatency}ms` : '-',
              t('admin_analytics.latency'),
            ];
          }}
          contentStyle={{
            backgroundColor: isDark ? '#1e293b' : '#ffffff',
            borderColor: isDark ? '#334155' : '#e2e8f0',
            borderRadius: '0.5rem',
            color: isDark ? '#f1f5f9' : '#0f172a',
          }}
        />
        <Line
          type="monotone"
          dataKey="latency_plot"
          stroke={lineColor}
          strokeWidth={2}
          dot={false}
          connectNulls
          isAnimationActive={!reducedMotion}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
