// i18n.js 的类型声明（i18n.js 是浏览器和服务端共用的普通 JS）
export type Lang = 'zh' | 'en';
export interface Msg {
  k: string;
  a?: Record<string, Text>;
}
/** 要显示给教练的文字：普通字符串（旧数据或站点原文）、数字、待翻译的消息，或它们的列表 */
export type Text = string | number | Msg | Text[];
export const LANGS: Lang[];
export const DEFAULT_LANG: Lang;
export const DICT: Record<Lang, Record<string, string>>;
export function isLang(x: unknown): x is Lang;
export function msg(k: string, a?: Record<string, Text>): Msg;
export function isMsg(x: unknown): x is Msg;
export function t(lang: Lang, key: string, args?: Record<string, Text>): string;
export function render(lang: Lang, text: Text | null | undefined): string;
export function encodeText(text: Text): string;
export function decodeText(s: string | null | undefined): Text;
export function fmtDate(lang: Lang, d: string): string;
export function fmtStamp(lang: Lang, ms: number): string;
