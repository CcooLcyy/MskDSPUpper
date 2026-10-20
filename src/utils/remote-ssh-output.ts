/** 输出可能早于打开命令的返回值；消费额度先累计，绑定会话后归还。 */
export function createSshOutputAcks(send: (sessionId: string) => void, isActive: () => boolean) {
  let sessionId: string | null = null;
  let pending = 0;
  return {
    consumed() {
      if (!isActive()) return;
      if (sessionId) send(sessionId);
      else pending += 1;
    },
    bind(id: string) {
      if (!isActive()) return;
      sessionId = id;
      const count = pending;
      pending = 0;
      for (let index = 0; index < count; index += 1) send(id);
    },
  };
}
