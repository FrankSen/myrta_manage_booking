// 显示用的小工具。浏览器和测试共用，不依赖页面

/** 倒计时：1:05、12:30；超过 1 小时显示 1:02:03 */
export function countdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** 还能刷新多久：大于 2 天按天，否则按小时；已过返回空字符串 */
export function remaining(ms) {
  if (ms <= 0) return '';
  const h = ms / 3_600_000;
  if (h >= 48) return `${Math.floor(h / 24)} 天`;
  if (h >= 1) return `${Math.floor(h)} 小时`;
  return `${Math.max(1, Math.floor(ms / 60_000))} 分钟`;
}

/** 一轮本身要多久（秒），实测值：回到预约页约 15 秒，每个考点 25 到 45 秒，每轮至少 2 个考点 */
export const ROUND_SEC = { min: 15 + 2 * 25, max: 15 + 2 * 45 };

/** 选某个间隔时，实际多久一轮、每小时大约几轮 */
export function estimate(intervalMin) {
  const lo = intervalMin * 60 + ROUND_SEC.min;
  const hi = intervalMin * 60 + ROUND_SEC.max;
  const fmt = (sec) => (sec % 60 === 0 ? `${sec / 60}` : (sec / 60).toFixed(1));
  return {
    text: `实际约 ${fmt(lo)} 到 ${fmt(hi)} 分钟一轮，每小时约 ${Math.round(3600 / hi)} 到 ${Math.round(3600 / lo)} 轮`,
    risky: intervalMin <= 1,
  };
}

export function minutesLabel(ms) {
  return `${Math.round(ms / 60_000)} 分钟`;
}
