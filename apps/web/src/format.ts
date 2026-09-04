import { daysBetween } from "@kel/shared";

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "--:--";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes <= 0) return "";
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/**
 * A Review date, relative to the server's idea of today.
 *
 * Days rather than hours, because that is the unit the Review ladder is written in — and both
 * keys are `YYYY-MM-DD` in the family's timezone, so this never has to touch the device clock.
 */
export function formatDay(day: string | null, today: string): string {
  if (!day) return "不用复习";
  const diff = daysBetween(today, day);
  if (diff < -1) return `逾期 ${-diff} 天`;
  if (diff === -1) return "昨天该看";
  if (diff === 0) return "今天";
  if (diff === 1) return "明天";
  if (diff < 30) return `${diff} 天后`;
  return day.slice(5).replace("-", " 月 ") + " 日";
}

export function formatRelative(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(timestamp).toLocaleDateString("zh-CN");
}
