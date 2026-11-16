import { SiteError } from './errors.ts';
import { msg } from '../i18n.ts';
import type { SiteSession } from './session.ts';

/**
 * 站点操作的占位实现：真实的浏览器操作还没接入。
 * 每个方法都明确报错，不会假装成功，也不会访问任何网站。
 */
export class UnavailableSession implements SiteSession {
  private fail(): never {
    throw new SiteError('unknown_page', msg('err.unavailable'));
  }
  login(): Promise<never> {
    return Promise.resolve().then(() => this.fail());
  }
  listSlots(): Promise<never> {
    return Promise.resolve().then(() => this.fail());
  }
  reachConfirm(): Promise<never> {
    return Promise.resolve().then(() => this.fail());
  }
  finish(): Promise<never> {
    return Promise.resolve().then(() => this.fail());
  }
  readCurrent(): Promise<never> {
    return Promise.resolve().then(() => this.fail());
  }
  async close(): Promise<void> {}
}
