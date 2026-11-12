/** 界面上可选的刷新间隔（分钟）。最小 1 分钟，原因见 INTERVAL_HELP */
export const INTERVAL_CHOICES_MIN = [1, 2, 3, 5, 10, 15, 30] as const;

export const MIN_INTERVAL_MS = INTERVAL_CHOICES_MIN[0] * 60_000;

export function isAllowedInterval(ms: number): boolean {
  return (INTERVAL_CHOICES_MIN as readonly number[]).includes(ms / 60_000);
}

/** 给教练看的说明。数字来自 2026-11 实测，见实现计划"实测耗时" */
export const INTERVAL_HELP = [
  '间隔从上一轮查完开始算。一轮本身要 1 到 1.5 分钟：回到预约页约 15 秒，每个考点约 25 到 45 秒，每轮至少查目标考点和一个附近考点。所以选 1 分钟，实际约 2 到 2.5 分钟一轮。',
  '为什么不是越快越好：所有学员共用一个网络出口。访问太密，myrta.com 会拦截，被拦后全部学员一起暂停 5 分钟，连续被拦就翻倍，最长 1 小时。被拦一次损失的时间，比调快省下的多。访问越密，也越不像真人操作。',
  '为什么最小是 1 分钟：再小，两轮之间几乎没有停顿，和不停访问没有区别，被拦的风险最大，找到考位的速度却快不了多少，因为一轮本身就要 1 分钟以上。',
  '另外，任意两次访问站点之间至少隔 20 秒，这一条不能调，用来兜底。',
];
