// 目标时间的选项和联动规则。浏览器和测试共用，不依赖页面
/** 可选时间：06:00 到 18:00，每 15 分钟一档 */
export const FIRST = 6 * 60;
export const LAST = 18 * 60;

export function quarterTimes() {
  const out = [];
  for (let m = FIRST; m <= LAST; m += 15) out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  return out;
}

/** 选了最早时间：最晚时间自动等于最早时间 */
export function onFromChange(range) {
  return { from: range.from, to: range.from };
}

/** 改了最晚时间：最早时间不动 */
export function onToChange(range) {
  return { from: range.from, to: range.to };
}

/** 保存前检查，返回错误文字；没问题返回空字符串 */
export function checkTime(mode, range, times) {
  if (mode === 'times') return times.length === 0 ? '请至少选一个指定时间' : '';
  return range.from > range.to ? '最晚时间不能早于最早时间' : '';
}

/** 卡片上显示的时间说明 */
export function describeTime(target) {
  if (target.times && target.times.length > 0) return `指定 ${target.times.join('、')}`;
  return target.timeFrom === target.timeTo ? `${target.timeFrom}` : `${target.timeFrom}–${target.timeTo}`;
}
