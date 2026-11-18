// 服务端用的翻译入口。翻译表在 ui/public/i18n.js，界面和服务端共用一份
import { render, type Text } from './ui/public/i18n.js';

export * from './ui/public/i18n.js';

/** 带可翻译文字的错误。message 是中文版本，只用于调试和兼容；给教练看的用 text */
export class TextError extends Error {
  readonly text: Text;

  constructor(text: Text) {
    super(render('zh', text));
    this.text = text;
  }
}

/** 从任意错误里取出要显示的文字 */
export function errorText(err: unknown): Text {
  if (err instanceof TextError) return err.text;
  // Playwright 的报错带多行调用记录和终端颜色码，只留第一行
  if (err instanceof Error) return err.message.replace(/\u001b\[[0-9;]*m/g, '').split('\n')[0]!.trim();
  return String(err);
}
