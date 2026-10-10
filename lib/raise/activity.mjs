/**
 * activity.mjs —— 打工 / 上学 / 旅游的「正在做的事」（qqpet `pet/activity.ts` 移植）
 *
 * 三者互斥，所以只要一个槽位。进行中的分钟数存进存档的 saveJsonData.activity，
 * 重启后由 jobs.mjs 的 resumeTask() 照 activeOption 里的 id/city 重建任务对象 —— 原版也是这样。
 */
let task = null;

export const elapsed = () => task?.done ?? 0;
export const running = () => (task ? { key: task.key, done: task.done, minutes: task.minutes } : null);

/** 开始一件事；`value` 是 activeOption 里记的东西（工作 id / 城市），`done` 用于恢复现场 */
export function startTask(st, t, value, done = 0) {
  task = { ...t, done };
  st.setActivity(t.key, value);
  st.save.saveJsonData.activity = String(done);
  st.markDirty();
}

/** 放弃当前的事（不发结束事件），返回它的类型 */
export function stopTask(st) {
  if (!task) return null;
  const { key } = task;
  task = null;
  st.holdName = ''; // 不干了就别再保持"在忙"的姿势（工期满了/心情见底/玩家取消，都走这里）
  st.setActivity(key, null);
  st.save.saveJsonData.activity = '0';
  st.markDirty();
  return key;
}

/** 续上存档里那件事（重启后用）：done 是已经做过的分钟数 */
export function restore(st, t, value, done) {
  task = { ...t, done };
  st.setActivity(t.key, value);
}

/** 把成长分钟数记到当前这件事上；到点或提前收工就结束它 */
export function advanceTask(st, minutes) {
  if (!task) return;
  const t = task;
  t.done = Math.min(t.done + minutes, t.minutes);
  st.save.saveJsonData.activity = String(t.done);
  st.markDirty();
  const early = Boolean(t.early?.(t.done));
  if (!early && t.done < t.minutes) return;
  stopTask(st);
  const end = t.end;
  task = null;
  end?.(early);
}

/** 测试与诊断用：清掉内存里的任务（不动存档） */
export const reset = () => {
  task = null;
};
