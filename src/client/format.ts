const compactNumber = new Intl.NumberFormat('zh-CN', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export function formatCompactNumber(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '未知';
  return compactNumber.format(value);
}

export function formatExactNumber(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '未知';
  return value.toLocaleString('zh-CN');
}

/** Compact durations for dense rows: 820ms, 1.8s, 2m 05s, 1h 33m. */
export function formatDuration(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return null;
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) {
    const seconds = value / 1000;
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  }
  if (value < 3_600_000) {
    const minutes = Math.floor(value / 60_000);
    const seconds = Math.round((value % 60_000) / 1000);
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

/** Human-readable durations for the statistics strip. */
export function formatLongDuration(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return '未知';
  if (value < 1000) return `${Math.round(value)} 毫秒`;
  const totalSeconds = Math.round(value / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分 ${seconds} 秒`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

export function clockTime(timestamp: number | null | undefined) {
  if (timestamp === null || timestamp === undefined || !Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}
