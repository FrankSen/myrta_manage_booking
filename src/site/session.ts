import type { BookingInfo, LocalDate, Slot } from '../domain/types.ts';

/**
 * 一个学员对应的一个站点会话。所有页面操作都在实现里，
 * 引擎和匹配逻辑只通过这个接口使用站点，所以可以用假实现测试。
 * 失败时抛 SiteError。
 */
export interface SiteSession {
  /** 登录并回到"查看预约"页，返回当前预约。已登录且会话有效时可复用，不重复登录 */
  login(bookingId: string, surname: string): Promise<BookingInfo>;
  /** 读取某考点在日期范围内的所有可约考位（内部负责翻周），不含已被占用的 */
  listSlots(centreId: number, dateFrom: LocalDate, dateTo: LocalDate): Promise<Slot[]>;
  /** 选定考位并走到确认页，返回确认页上显示的内容。不提交 */
  reachConfirm(slot: Slot): Promise<BookingInfo>;
  /** 点 Finish。返回值只是页面的说法，调用方必须再用 readCurrent 核实 */
  finish(): Promise<'success' | 'failed' | 'unknown'>;
  /** 重新读取预约详情，用来核实改约结果 */
  readCurrent(): Promise<BookingInfo>;
  /** 把浏览器窗口恢复并调到前面（停在确认页等教练时用）。不支持时可以不实现 */
  reveal?(): Promise<void>;
  /** 把浏览器窗口最小化 */
  conceal?(): Promise<void>;
  /** 页面内直接发请求时，每次请求前调用（全局限速）。生产装配时挂上 */
  setThrottle?(fn: () => Promise<void>): void;
  /**
   * 开启后停在选时间页时每次检查都重新载入页面（而不是页面内请求），让浏览器里的页面保持最新，
   * 发现考位能立刻点，省掉抢位前的那次整页载入。让位时抢位的学员开启
   */
  setHot?(on: boolean): void;
  close(): Promise<void>;
}
