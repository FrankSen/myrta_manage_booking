import type { NotifyEvent } from '../engine/checker.ts';
import type { Repo } from '../storage/repo.ts';
import type { CentreIndex } from '../domain/types.ts';

export interface UiMessage {
  /** 界面据此决定是否弹系统通知 */
  level: 'info' | 'attention';
  title: string;
  body: string;
  event: NotifyEvent;
}

/** 把引擎事件翻译成给教练看的中文消息 */
export function describeEvent(e: NotifyEvent, repo: Repo, centres: CentreIndex): UiMessage {
  const student = repo.getStudent(e.studentId);
  const who = student?.label ?? `学员 ${e.studentId}`;
  const place = (id: number) => centres.get(id)?.name ?? `考点 ${id}`;
  switch (e.type) {
    case 'offer': {
      const o = repo.getOffer(e.offerId);
      const detail = o ? `${place(o.centreId)} ${o.date} ${o.time}（${o.notes.join('；')}）` : '';
      return { level: 'attention', title: `${who}：发现接近的考位`, body: `${detail}。请在软件里确认或忽略`, event: e };
    }
    case 'rebooked':
      return { level: 'attention', title: `${who}：改约成功`, body: `${e.to.centreName} ${e.to.date} ${e.to.time}`, event: e };
    case 'dry_run_ready':
      return {
        level: 'attention',
        title: `${who}：发现完全符合的考位`,
        body: `${place(e.slot.centreId)} ${e.slot.date} ${e.slot.time}。自动改约没有开启，已停在确认页，没有提交`,
        event: e,
      };
    case 'stopped':
      return { level: 'attention', title: `${who}：已停止`, body: e.reason, event: e };
    case 'error':
      return { level: 'attention', title: `${who}：需要处理`, body: e.message, event: e };
  }
}
