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
}

export const DEFAULT_SETTINGS: Settings = {
  hidden: {
    maxActiveStudents: 5,
    checkIntervalMs: 2 * 60_000,
    jitterRatio: 0.2,
    globalMinGapMs: 20_000,
    backoffBaseMs: 5 * 60_000,
    backoffMaxMs: 60 * 60_000,
  },
  tolerance: { maxDistanceKm: 10, maxTimeMinutes: 60, maxDateDays: 0 },
  autoRebookEnabled: false,
  language: DEFAULT_LANG,
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
      maxDistanceKm: num('tolerance', t, 'maxDistanceKm', base.tolerance.maxDistanceKm),
      maxTimeMinutes: num('tolerance', t, 'maxTimeMinutes', base.tolerance.maxTimeMinutes),
      maxDateDays: num('tolerance', t, 'maxDateDays', base.tolerance.maxDateDays),
    },
    autoRebookEnabled: (o.autoRebookEnabled as boolean | undefined) ?? base.autoRebookEnabled,
  };
}
