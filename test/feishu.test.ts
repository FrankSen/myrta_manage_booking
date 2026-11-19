import { describe, expect, test, vi } from 'vitest';
import { createFeishuPusher, isFeishuWebhook } from '../src/notify/feishu.ts';
import type { UiMessage } from '../src/notify/notifier.ts';
import { msg } from '../src/i18n.ts';

const attention: UiMessage = {
  level: 'attention',
  title: msg('ev.rebooked_title', { who: 'A' }),
  body: 'Silverwater 2026-12-30 11:30',
  event: { type: 'rebooked', studentId: 1, to: { centreName: 'Silverwater', date: '2026-12-30', time: '11:30' } },
};
const info: UiMessage = { ...attention, level: 'info' };

const GOOD = 'https://open.feishu.cn/open-apis/bot/v2/hook/abc';

describe('isFeishuWebhook', () => {
  test('只认飞书官方 Webhook', () => {
    expect(isFeishuWebhook(GOOD)).toBe(true);
    expect(isFeishuWebhook('https://open.feishu.cn/open-apis/bot/v2/hook/0000-test')).toBe(true);
    expect(isFeishuWebhook('')).toBe(false);
    expect(isFeishuWebhook('http://open.feishu.cn/open-apis/bot/x')).toBe(false);
    expect(isFeishuWebhook('https://evil.com/open-apis/bot/x')).toBe(false);
    expect(isFeishuWebhook('https://open.feishu.cn/other')).toBe(false);
    expect(isFeishuWebhook('not a url')).toBe(false);
  });
});

describe('createFeishuPusher', () => {
  const okResponse = () => ({ ok: true, json: async () => ({ code: 0 }) }) as unknown as Response;

  test('attention 消息推送，text 带标题和正文', async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: (init?.body as string) ?? '' });
      return okResponse();
    }) as unknown as typeof fetch;
    const pusher = createFeishuPusher({ webhook: () => GOOD, lang: () => 'zh', fetchImpl });
    pusher.push(attention);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe(GOOD);
    const payload = JSON.parse(calls[0]!.body);
    expect(payload.msg_type).toBe('text');
    expect(payload.content.text).toContain('A');
    expect(payload.content.text).toContain('11:30');
    // 飞书机器人的关键词安全设置：开头固定带"通知"
    expect(payload.content.text.startsWith('【驾考改约助手通知】')).toBe(true);
  });

  test('info 消息不推送', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const pusher = createFeishuPusher({ webhook: () => GOOD, lang: () => 'zh', fetchImpl: fetchImpl as unknown as typeof fetch });
    pusher.push(info);
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('没配 Webhook 或地址不合法：不推送', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const pusher = createFeishuPusher({ webhook: () => '', lang: () => 'zh', fetchImpl: fetchImpl as unknown as typeof fetch });
    pusher.push(attention);
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('飞书返回 code 非 0：走 onError，不抛出', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ code: 19021, msg: 'sign match fail' }) }) as unknown as Response);
    const onError = vi.fn();
    const pusher = createFeishuPusher({ webhook: () => GOOD, lang: () => 'zh', onError, fetchImpl: fetchImpl as unknown as typeof fetch });
    pusher.push(attention);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
  });

  test('网络出错：走 onError，不抛出', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const onError = vi.fn();
    const pusher = createFeishuPusher({ webhook: () => GOOD, lang: () => 'zh', onError, fetchImpl: fetchImpl as unknown as typeof fetch });
    pusher.push(attention);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
  });
});
