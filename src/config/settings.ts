import type { Tolerance } from '../domain/types.ts';
import { DEFAULT_LANG, isLang, type Lang } from '../i18n.ts';

/** 隐藏配置：界面上不显示，以后作为收费功能开放 */
export interface HiddenSettings {
  /** 同时运行的学员上限 */
  maxActiveStudents: number;
  /** 同一学员两轮检查之间的基础间隔（毫秒） */
  checkIntervalMs: number;
  /** 间隔的随机浮动比例，0.2 表示 ±20% */
  jitterRatio: number;
  /** 任意两次访问站点之间的最短间隔（毫秒），所有学员共用 */
  globalMinGapMs: number;
  /** 遇到封锁后的首次退避时长（毫秒），之后每次翻倍 */
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export interface Settings {
  hidden: HiddenSettings;
  tolerance: Tolerance;
  /** 自动改约总开关。第一次真实改约验证之前必须为 false */
  autoRebookEnabled: boolean;
  /** 界面语言，教练在顶栏切换，写回 settings.json 的 ui.language */
  language: Lang;
  /** 消息推送。配了飞书机器人 Webhook 地址后，重要消息（找到、改约成功、出错等）会推到群里 */
  notify: NotifySettings;
}

export interface NotifySettings {
  /** 飞书自定义机器人 Webhook 地址；空串表示不推送 */
  feishuWebhook: string;
}

export const DEFAULT_SETTINGS: Settings = {
  hidden: {
    maxActiveStudents: 5,
    // 2026-11-17 教练要求大幅调快抢考位：默认 5 秒一轮，忽略被拦/封 IP 风险
    checkIntervalMs: 5_000,
    jitterRatio: 0.2,
    // 全局最小访问间隔随之调小，否则 4-5 个学员排队会被这里卡住、达不到 5 秒节奏
    globalMinGapMs: 2_000,
    backoffBaseMs: 5 * 60_000,
    backoffMaxMs: 60 * 60_000,
  },
  tolerance: { maxTimeMinutes: 60, maxDateDays: 0 },
  // 2026-11-19 教练要求默认开启：完全符合目标的考位自动提交。界面顶部可以随时关掉
  autoRebookEnabled: true,
  language: DEFAULT_LANG,
  notify: { feishuWebhook: '' },
};

/** 用文件里的值覆盖默认值，只接受已知字段，类型不对就报错 */
export function mergeSettings(base: Settings, override: unknown): Settings {
  if (override === undefined || override === null) return base;
  if (typeof override !== 'object') throw new Error('配置必须是对象');
  const o = override as Record<string, unknown>;
  const num = (group: string, obj: Record<string, unknown> | undefined, key: string, fallback: number): number => {
    const v = obj?.[key];
    if (v === undefined) return fallback;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`配置 ${group}.${key} 必须是非负数字`);
    return v;
  };
  const h = o.hidden as Record<string, unknown> | undefined;
  const t = o.tolerance as Record<string, unknown> | undefined;
  if (o.autoRebookEnabled !== undefined && typeof o.autoRebookEnabled !== 'boolean') {
    throw new Error('配置 autoRebookEnabled 必须是 true 或 false');
  }
  const ui = o.ui as Record<string, unknown> | undefined;
  if (ui?.language !== undefined && !isLang(ui.language)) throw new Error('配置 ui.language 只能是 zh 或 en');
  const n = o.notify as Record<string, unknown> | undefined;
  let feishuWebhook = base.notify.feishuWebhook;
  if (n?.feishuWebhook !== undefined) {
    if (typeof n.feishuWebhook !== 'string') throw new Error('配置 notify.feishuWebhook 必须是字符串');
    feishuWebhook = n.feishuWebhook.trim();
  }
  return {
    language: (ui?.language as Lang | undefined) ?? base.language,
    hidden: {
      maxActiveStudents: num('hidden', h, 'maxActiveStudents', base.hidden.maxActiveStudents),
      checkIntervalMs: num('hidden', h, 'checkIntervalMs', base.hidden.checkIntervalMs),
      jitterRatio: num('hidden', h, 'jitterRatio', base.hidden.jitterRatio),
      globalMinGapMs: num('hidden', h, 'globalMinGapMs', base.hidden.globalMinGapMs),
      backoffBaseMs: num('hidden', h, 'backoffBaseMs', base.hidden.backoffBaseMs),
      backoffMaxMs: num('hidden', h, 'backoffMaxMs', base.hidden.backoffMaxMs),
    },
    tolerance: {
      maxTimeMinutes: num('tolerance', t, 'maxTimeMinutes', base.tolerance.maxTimeMinutes),
      maxDateDays: num('tolerance', t, 'maxDateDays', base.tolerance.maxDateDays),
    },
    autoRebookEnabled: (o.autoRebookEnabled as boolean | undefined) ?? base.autoRebookEnabled,
    notify: { feishuWebhook },
  };
}
