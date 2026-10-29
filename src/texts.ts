/**
 * All user-facing copy (Traditional Chinese, short, no emoji) lives here.
 * Do not hard-code reply text elsewhere.
 */
export const texts = {
  nonTextMessage: '目前只能處理文字訊息，請用文字描述你的問題。',
  welcomeFallback:
    '你好，我是王媽媽寵物手工零食的客服小幫手。有任何關於商品、訂單或網站使用的問題都可以直接問我。',
  ackPending: '已收到你的訊息，查詢需要一點時間，完成後會再回覆你。',
  serviceForwarded: '這個問題需要專人查詢，已幫你轉交，會盡快回覆你。',
  offTopic: '不好意思，這裡只能協助王媽媽寵物手工零食的商品、訂單與網站相關問題。',
  featureThanks: '已收到，謝謝你的建議，我們會轉給團隊參考。',
  incidentHealthyFollowUp:
    '我這邊查到網站目前運作正常，問題可能和個別帳號或操作有關。方便告訴我：1. 是哪個頁面或功能 2. 操作步驟 3. 發生時間 4. 有沒有錯誤訊息或截圖？我會轉給專人確認。',
  incidentConfirmed: '已確認網站目前有異常，我們正在處理，恢復後會再通知你。造成不便很抱歉。',
  fallbackError: '系統忙碌中，請稍後再試，或留下你的問題，我們會盡快回覆。',
  grokUnavailable: '這個問題已轉交人工處理，專人會再回覆你，謝謝耐心等候。',
  grokStatusReceived: '問題已送出給專人系統，處理中，稍後回覆你。',
  grokStatusProcessing: '專人系統處理中，請稍候。',
  grokTimeout: '專人系統這次沒有在時間內回覆，已改由人工處理，會再回覆你。',
  handoffEntered: '已為你轉接人工客服，請稍候，專人會在這裡回覆你。',
  handoffResumed: '人工客服處理完成，之後的問題可以繼續問我。',
  adminHelp:
    '管理員指令：\n/status 今日訊息、本月 push、待處理 jobs、人工中人數\n/resume <userId前8碼> 解除人工轉接\n/handoff <userId前8碼> 轉為人工 24 小時',
} as const;

/** Admin push when a user enters human handoff (SPEC 5.7). */
export function adminHandoffNotice(d: {
  userId: string;
  reason: string;
  recentMessages: string[];
}): string {
  const userIdShort = d.userId.slice(0, 8);
  const lines = d.recentMessages.map((t) => `- ${t}`).join('\n');
  return `[轉人工] 使用者 ${userIdShort}（${d.reason}）\n最近訊息：\n${lines}\n解除：/resume ${userIdShort}`;
}

/** Admin push forwarding a user message during handoff. */
export function adminForwardNotice(d: { userId: string; text: string }): string {
  return `[人工中] ${d.userId.slice(0, 8)}：${d.text}`;
}

/** `/status` reply. */
export function adminStatus(d: {
  messagesToday: number;
  pushesThisMonth: number;
  pendingJobs: number;
  inHandoff: number;
  /** Grok tasks still waiting for a callback; omitted when undefined. */
  grokWaiting?: number;
}): string {
  const grok = d.grokWaiting === undefined ? '' : `｜Grok 等待中 ${d.grokWaiting}`;
  return `今日訊息 ${d.messagesToday} 則｜本月 push ${d.pushesThisMonth} 則｜待處理 jobs ${d.pendingJobs}｜人工中 ${d.inHandoff} 人${grok}`;
}

/** `/resume` success reply. */
export function adminResumeDone(userId: string): string {
  return `已解除 ${userId.slice(0, 8)} 的人工轉接`;
}

/** `/handoff` success reply. */
export function adminHandoffDone(userId: string): string {
  return `已將 ${userId.slice(0, 8)} 轉為人工客服（24 小時）`;
}

/** Reply when an id prefix matches zero or several users. */
export function adminPrefixMismatch(prefix: string, count: number): string {
  return count === 0
    ? `找不到 id 開頭為 ${prefix} 的使用者，請確認後再試`
    : `id 開頭為 ${prefix} 的使用者有 ${count >= 5 ? '5 位以上' : `${count} 位`}，請提供更長的 id 前綴`;
}

/** Admin push when a service question could not be answered by Grok (SPEC 5.6). */
export function adminServiceQuestionNotice(d: { userId: string; text: string }): string {
  return `[待人工回覆] 使用者 ${d.userId.slice(0, 8)} 問：${d.text}\n（Grok 未設定或無法回答）`;
}

/** Admin push carrying Grok's incident triage. */
export function adminTriageNotice(d: { incidentId: number; text: string }): string {
  return `[異常分析] #${d.incidentId}\n${d.text}`;
}

export interface AdminIncidentDetail {
  userId: string;
  text: string;
  health: {
    status: string;
    httpStatus?: number;
    latencyMs: number;
    error?: string;
    body?: unknown;
  };
}

const MAX_BODY_SUMMARY = 300;

/** Admin push for a confirmed incident (SPEC 5.4 step 5); includes a health summary. */
export function adminIncidentNotice(d: AdminIncidentDetail): string {
  const userIdShort = d.userId.slice(0, 8);
  const { health } = d;
  const httpStatus = health.httpStatus !== undefined ? ` ${health.httpStatus}` : '';
  let detail: string;
  if (health.error) {
    detail = health.error;
  } else {
    let summary: string;
    try {
      summary = health.body === undefined ? '' : JSON.stringify(health.body);
    } catch {
      summary = String(health.body);
    }
    detail = summary.length > MAX_BODY_SUMMARY ? `${summary.slice(0, MAX_BODY_SUMMARY)}…` : summary;
  }
  return `[異常回報] 使用者 ${userIdShort} 回報：${d.text}\nhealth: ${health.status}${httpStatus} ${health.latencyMs}ms\n${detail}`;
}
