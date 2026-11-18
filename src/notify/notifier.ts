import type { NotifyEvent } from '../engine/checker.ts';
import type { Repo } from '../storage/repo.ts';
import type { CentreIndex } from '../domain/types.ts';
import { msg, type Text } from '../i18n.ts';

export interface UiMessage {
  /** 界面据此决定是否弹系统通知 */
  level: 'info' | 'attention';
  /** 可翻译，由界面按当前语言显示 */
  title: Text;
  body: Text;
  event: NotifyEvent;
}

/** 把引擎事件变成给教练看的消息（不带语言，显示时翻译） */
export function describeEvent(e: NotifyEvent, repo: Repo, centres: CentreIndex): UiMessage {
  const student = repo.getStudent(e.studentId);
  const who: Text = student?.label ?? msg('ev.who', { id: e.studentId });
  const place = (id: number): Text => centres.get(id)?.name ?? msg('centre.unknown', { id });
  switch (e.type) {
    case 'offer': {
      const o = repo.getOffer(e.offerId);
      const detail: Text = o ? msg('ev.offer_detail', { centre: place(o.centreId), date: o.date, time: o.time, notes: o.notes }) : '';
      return { level: 'attention', title: msg('ev.offer_title', { who }), body: msg('ev.offer_body', { detail }), event: e };
    }
    case 'rebooked':
      return { level: 'attention', title: msg('ev.rebooked_title', { who }), body: `${e.to.centreName} ${e.to.date} ${e.to.time}`, event: e };
    case 'dry_run_ready':
      return {
        level: 'attention',
        title: msg('ev.dry_title', { who }),
        body: msg('ev.dry_body', { centre: place(e.slot.centreId), date: e.slot.date, time: e.slot.time }),
        event: e,
      };
    case 'stopped':
      return { level: 'attention', title: msg('ev.stopped_title', { who }), body: e.reason, event: e };
    case 'error':
      return { level: 'attention', title: msg('ev.error_title', { who }), body: e.message, event: e };
  }
}
