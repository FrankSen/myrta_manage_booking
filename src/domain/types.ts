import type { Text } from '../i18n.ts';

/** 悉尼本地日期，格式 YYYY-MM-DD */
export type LocalDate = string;
/** 悉尼本地时间，24 小时制，格式 HH:MM */
export type LocalTime = string;

export interface Centre {
  id: number;
  name: string;
  suburb: string;
  postcode: string;
  lat: number;
  lng: number;
}

/** 一个可预约的考位 */
export interface Slot {
  centreId: number;
  date: LocalDate;
  time: LocalTime;
}

/** 学员已有的预约，或确认页上显示的预约 */
export interface BookingInfo {
  centreName: string;
  date: LocalDate;
  time: LocalTime;
}

/** 教练为学员设定的目标 */
export interface Target {
  centreIds: number[];
  dateFrom: LocalDate;
  dateTo: LocalDate;
  timeFrom: LocalTime;
  timeTo: LocalTime;
  /** 指定时间（方案 B）。非空时只认这几个时间，忽略 timeFrom/timeTo；为空或没有时按时间范围 */
  times?: LocalTime[];
}

/** 判断"接近"的容差 */
export interface Tolerance {
  maxTimeMinutes: number;
  maxDateDays: number;
}

export type MatchKind = 'exact' | 'near' | 'none';

export interface MatchResult {
  kind: MatchKind;
  /** 给教练看的说明，例如 "距目标考点 5.6 公里"（可翻译） */
  notes: Text[];
}

export type CentreIndex = ReadonlyMap<number, Centre>;
