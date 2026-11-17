import { msg, type Msg } from '../i18n.ts';

/** 关窗口时要不要先问教练。返回 null 表示直接退出 */
export function quitQuestion(o: { running: number; rebooking: number; held?: number }): Msg | null {
  if (o.rebooking > 0) return msg('el.quit_rebooking');
  if (o.held) return msg('el.quit_held', { n: o.held });
  if (o.running > 0) return msg('el.quit_running', { n: o.running });
  return null;
}

/** 界面窗口只允许打开本地服务的页面；别的链接交给系统浏览器 */
export function isAppUrl(url: string, appOrigin: string): boolean {
  try {
    return new URL(url).origin === appOrigin;
  } catch {
    return false;
  }
}
