import { render, type Lang, type Text } from '../i18n.ts';
import type { UiMessage } from './notifier.ts';

/**
 * 飞书自定义机器人推送。配了 Webhook 地址才推；只推重要消息（level 为 attention）。
 * 用飞书的 text 消息类型，一个 HTTP POST 即可，不依赖任何外部库。
 */
export interface FeishuPusher {
  push(m: UiMessage): void;
}

export interface FeishuOptions {
  /** Webhook 地址；空串表示不推送 */
  webhook: () => string;
  /** 当前界面语言，用来把可翻译文字渲染成实际文案 */
  lang: () => Lang;
  /** 出错时记一笔，不打断主流程。默认吞掉 */
  onError?: (err: unknown) => void;
  /** 测试时替换，默认用全局 fetch */
  fetchImpl?: typeof fetch;
}

const FEISHU_HOST = 'open.feishu.cn';

/**
 * 每条消息的开头。飞书机器人常开"自定义关键词"安全设置，消息里没有关键词就拒收（code 19024）。
 * 教练的机器人关键词是"通知"（2026-11-19 实测），所以开头固定带上，也方便在群里认出是哪里发的
 */
export const FEISHU_PREFIX = '【驾考改约助手通知】';

/** 只允许飞书官方 Webhook 域名，避免把消息（含学员信息）发到配错的地址 */
export function isFeishuWebhook(url: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === FEISHU_HOST || u.hostname.endsWith('.feishu.cn')) && u.pathname.startsWith('/open-apis/bot/');
  } catch {
    return false;
  }
}

export function createFeishuPusher(opts: FeishuOptions): FeishuPusher {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const text = (t: Text): string => render(opts.lang(), t);
  return {
    push(m: UiMessage): void {
      if (m.level !== 'attention') return;
      const webhook = opts.webhook();
      if (!isFeishuWebhook(webhook)) return;
      const content = `${FEISHU_PREFIX}${text(m.title)}\n${text(m.body)}`.trim();
      const body = JSON.stringify({ msg_type: 'text', content: { text: content } });
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10_000);
      void Promise.resolve()
        .then(() => doFetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: ctrl.signal }))
        .then(async (res) => {
          // 飞书即使拒收也返回 200，错误在响应体的 code 里
          const json = (await res.json().catch(() => null)) as { code?: number; msg?: string } | null;
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          if (json && typeof json.code === 'number' && json.code !== 0) throw new Error(`飞书返回 code=${json.code} ${json.msg ?? ''}`);
        })
        .catch((err) => opts.onError?.(err))
        .finally(() => clearTimeout(timer));
    },
  };
}
