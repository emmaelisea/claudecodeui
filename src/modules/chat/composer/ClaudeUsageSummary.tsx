import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';

type UsageWindow = { usedPercentage: number; resetsAt: string };
type PerformanceData = {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  speed: { tokensPerSecond: number; measuredAt: number } | null;
};

/** Used by ChatInterface near the composer to show only measured Claude limits and output speed. */
export default function ClaudeUsageSummary({ sessionId }: { sessionId?: string | null }) {
  const { t } = useTranslation('chat');
  // Values belong to the current session and are replaced on each successful read.
  const [snapshot, setSnapshot] = useState<{ sessionId: typeof sessionId; data: PerformanceData; readAt: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    let loading = false;
    const update = async () => {
      if (loading || document.hidden) return;
      loading = true;
      try {
        const response = await api.providers.claudePerformance(sessionId);
        const body = await response.json();
        if (!cancelled) setSnapshot(response.ok && body.success ? { sessionId, data: body.data, readAt: Date.now() } : null);
      } catch {
        if (!cancelled) setSnapshot(null);
      } finally {
        loading = false;
      }
    };
    void update();
    const timer = window.setInterval(update, 10_000);
    document.addEventListener('visibilitychange', update);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, [sessionId]);
  const data = snapshot?.sessionId === sessionId ? snapshot?.data : null;

  const windowLabel = (label: string, window: UsageWindow | null | undefined) => {
    if (!window || !Number.isFinite(window.usedPercentage) || window.usedPercentage < 0
      || window.usedPercentage > 100 || Date.parse(window.resetsAt) <= (snapshot?.readAt ?? Infinity)
      || !Number.isFinite(Date.parse(window.resetsAt))) return null;
    return (
      <span title={t('usageMetrics.resets', { time: new Date(window.resetsAt).toLocaleString() })}>
        {label} {Math.round(window.usedPercentage)}%
      </span>
    );
  };
  const fiveHour = windowLabel(t('usageMetrics.fiveHour'), data?.fiveHour);
  const sevenDay = windowLabel(t('usageMetrics.week'), data?.sevenDay);
  const speed = data?.speed && Number.isFinite(data.speed.tokensPerSecond) && data.speed.tokensPerSecond > 0
    ? data.speed : null;
  if (!fiveHour && !sevenDay && !speed) return null;
  return (
    <div className="inline-flex flex-wrap justify-center gap-x-3 gap-y-1 text-[11px] tabular-nums text-muted-foreground" aria-label={t('usageMetrics.label')}>
      {fiveHour}
      {sevenDay}
      {speed && (
        <span title={t('usageMetrics.speedHint', { time: new Date(speed.measuredAt).toLocaleTimeString() })}>
          {speed.tokensPerSecond.toFixed(1)} tok/s
        </span>
      )}
    </div>
  );
}
