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
} as const;

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
