export type SiteErrorKind =
  | 'blocked' // 被 Akamai 拦截（403、连接被重置等）
  | 'bad_credentials' // Booking number 或姓氏不对
  | 'widgets_missing' // 登录页控件没初始化
  | 'unknown_page' // 页面不是预期的样子
  | 'captcha' // 出现验证码
  | 'timeout' // 页面加载或操作超时
  | 'confirm_mismatch' // 确认页内容和所选考位不一致
  | 'finish_unverified'; // 点了 Finish，但无法确认结果

export class SiteError extends Error {
  readonly kind: SiteErrorKind;

  constructor(kind: SiteErrorKind, message: string) {
    super(message);
    this.name = 'SiteError';
    this.kind = kind;
  }
}
