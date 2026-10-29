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
  ticketPending: '專人處理中，有結果會在這裡回覆你。',
  adminHelp:
    '管理員指令：\n/status 今日訊息、本月 push、待處理 jobs、人工中人數\n/resume <userId前8碼> 解除人工轉接\n/handoff <userId前8碼> 轉為人工 24 小時',
  adminOnly: '此帳號僅供內部使用。',
  adminWelcome: '管理端 bot 已就緒，可以問訂單與庫存狀況。',
  adminAckPending: '查詢中，稍後回覆。',
  adminModelUnavailable: '模型暫時無法回應，請稍後再試。',
  adminModelRefused: '這個問題無法處理，請換個說法再試。',
  adminEmptyAnswer: '沒有查到可回覆的內容，請換個問法。',
  adminToolCapNote: '（查詢步驟已達上限，以上是目前查到的資料；可加條件縮小範圍再問）',
  adminPiiRecordPlaceholder: '（此則回覆含完整個資，內容未保存）',
  adminTruncated: '…（內容過長，已截斷）',
  adminReplyCancelled: '已取消先前的回覆草稿。',
  adminReplyTooLong: '回覆內容最多 1000 字，請縮短後再試。',
  adminTicketNotFound: '找不到這張工單，請確認編號。',
  adminTicketClosed: '這張工單已關閉，無法回覆。',
  adminTicketListEmpty: '目前沒有待回覆的工單。',
} as const;

const TICKET_LIST_MAX = 10;
const TICKET_QUESTION_PREVIEW = 40;
const TICKET_QUESTION_MAX = 1500;

/** `2026-10-30T01:12:00.000Z` → `10-30 09:12` (Asia/Taipei, fixed UTC+8). */
function taipeiShort(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  const s = new Date(t.getTime() + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(s.getUTCMonth() + 1)}-${p(s.getUTCDate())} ${p(s.getUTCHours())}:${p(s.getUTCMinutes())}`;
}

/** T16: the staged reply the admin must confirm with Y. */
export function adminReplyConfirm(display: string, text: string): string {
  return `將送給 ${display} 的客戶：\n『${text}』\n回 Y 送出，其他內容取消。`;
}

export function adminReplySent(display: string, userIdShort: string): string {
  return `已送給 ${display} 的客戶（${userIdShort}）。`;
}

export function adminReplyFailed(reason: string): string {
  return `送出失敗：${reason}`;
}

export function adminTicketClosedDone(display: string): string {
  return `已關閉 ${display}。`;
}

export interface AdminTicketListRow {
  display: string;
  createdAt: string;
  userIdShort: string;
  question: string;
}

/** `T042｜10-30 01:12｜U603787…｜<question first 40 chars>`, at most 10 lines. */
export function adminTicketList(rows: AdminTicketListRow[]): string {
  if (rows.length === 0) return texts.adminTicketListEmpty;
  const lines = rows.slice(0, TICKET_LIST_MAX).map((r) => {
    const q = r.question.replace(/\s+/g, ' ').trim();
    const preview =
      q.length > TICKET_QUESTION_PREVIEW ? `${q.slice(0, TICKET_QUESTION_PREVIEW)}…` : q;
    return `${r.display}｜${taipeiShort(r.createdAt)}｜${r.userIdShort}｜${preview}`;
  });
  if (rows.length > TICKET_LIST_MAX) lines.push(`還有 ${rows.length - TICKET_LIST_MAX} 張`);
  return lines.join('\n');
}

export interface AdminTicketDetailInput {
  display: string;
  status: string;
  userIdShort: string;
  createdAt: string;
  orderIds: string[];
  question: string;
  context: string[];
  answer: string | null;
  answeredBy: string | null;
}

const TICKET_STATUS_LABEL: Record<string, string> = {
  open: '待回覆',
  answered: '已回覆',
  closed: '已關閉',
};

export function adminTicketDetail(t: AdminTicketDetailInput): string {
  const q =
    t.question.length > TICKET_QUESTION_MAX
      ? `${t.question.slice(0, TICKET_QUESTION_MAX)}${texts.adminTruncated}`
      : t.question;
  const lines = [
    `${t.display}｜${TICKET_STATUS_LABEL[t.status] ?? t.status}｜客戶 ${t.userIdShort}｜${taipeiShort(t.createdAt)}`,
  ];
  if (t.orderIds.length > 0) lines.push(`訂單：${t.orderIds.join('、')}`);
  lines.push(`問：${q}`);
  if (t.context.length > 0) {
    lines.push('最近對話：');
    for (const c of t.context) lines.push(`- ${c}`);
  }
  if (t.answer) lines.push(`已回覆（${t.answeredBy ?? '-'}）：${t.answer}`);
  if (t.status !== 'closed') lines.push(`回覆方式：回覆 ${t.display} <內容>`);
  return lines.join('\n');
}

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

function shortUserId(userId: string): string {
  return userId.length > 8 ? `${userId.slice(0, 8)}…` : userId;
}

/** Admin notice when a ticket is opened (SPEC-ADMIN §12.2). */
export function ticketNotice(d: {
  ticketId: string;
  userId: string;
  question: string;
  recentMessages: string[];
  orderIds: string[];
}): string {
  const lines = [
    `[待回覆 ${d.ticketId}] 客戶 ${shortUserId(d.userId)}`,
    `問：${d.question}`,
    '最近對話：',
    ...d.recentMessages.map((t) => `- ${t}`),
  ];
  if (d.orderIds.length > 0) lines.push(`訂單：${d.orderIds.join('、')}`);
  lines.push(`回覆方式：在這裡打「回覆 ${d.ticketId} <內容>」`);
  return lines.join('\n');
}

/** Admin notice when a customer with an open ticket writes again. */
export function ticketFollowUpNotice(d: {
  ticketId: string;
  userId: string;
  text: string;
}): string {
  return `[${d.ticketId} 追問] 客戶 ${shortUserId(d.userId)}\n${d.text}`;
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
