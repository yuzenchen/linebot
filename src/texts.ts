import type { CommandKeyword, CorrectionKind, PunchKind } from './staff/commands.js';
import type { PayrollEmployeeLine, PayrollResult, ShiftDetail } from './staff/payroll.js';
import { type LocalDate, type Month, splitMinutes, taipeiDate, taipeiTime } from './staff/time.js';

/** SPEC-ADMIN §13.4: Grok statuses a bug reporter is told about. */
export type BugNoticeStatus = 'received' | 'processing' | 'done' | 'failed';

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
  adminImageReceived: '已收到圖片，請問要查什麼？例如：這筆出貨了嗎',
  adminImageFailed: '有圖片無法讀取，以下只依文字回答。',
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
  /** SPEC-ADMIN §14.3 step 1: the bot was tagged with nothing else. */
  groupHelp:
    '請在 tag 後輸入要查的資料，例如：@bot 今天的訂單；回報網站問題請用 /bug，例如：@bot /bug 結帳頁按 LINE Pay 沒反應',
  /** §14.3 step 2: `/bug` without a description. */
  groupBugHelp: '請在 /bug 後描述網站問題，例如：@bot /bug 結帳頁按 LINE Pay 沒反應',
  bugDispatchFailed: 'Grok 送出失敗',
  /** §14.3 step 7: group reply when the group handler itself fails (internal group). */
  groupBugError: '處理失敗，請稍後再 tag 一次。',
  /** SPEC-ADMIN §13.3: group confirmation once a bug report is queued for Grok. */
  groupBugAccepted: (display: string): string => `已轉給 Grok 處理，異常單號 ${display}`,
  /** §13.3: the same reporter tagged the same description again within 60 seconds. */
  groupBugDuplicate: (display: string): string => `${display} 已在處理中`,
  /** §13.4: DM to the reporter for each Grok status of a bug report. */
  bugStatusNotice: (d: { display: string; status: BugNoticeStatus; text?: string }): string => {
    const head = `[Bug ${d.display}]`;
    const text = d.text?.trim();
    switch (d.status) {
      case 'received':
        return text ? `${head} 已收到：${text}` : `${head} 已收到`;
      case 'processing':
        return text ? `${head} 處理中：${text}` : `${head} 處理中`;
      case 'done':
        return text ? `${head} 完成：${text}` : `${head} 完成`;
      case 'failed':
        return `${head} 失敗：${text || '未說明原因'}`;
    }
  },
  /** §13.4: DM to the reporter when a bug_report task expires. */
  bugTimeoutNotice: (display: string): string => `${display} Grok 未在時限內回報`,
  /** DM to the reporter when Grok is not configured and the report could not be sent. */
  bugGrokUnconfigured: (display: string): string => `Grok 未設定，${display} 未送出`,
} as const;

const TICKET_LIST_MAX = 10;
const TICKET_QUESTION_PREVIEW = 40;
const TICKET_QUESTION_MAX = 1500;

/** `2026-10-30T01:12:00.000Z` → `10-30 09:12` (Asia/Taipei, fixed UTC+8). */
export function taipeiShort(iso: string): string {
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

// ---------------------------------------------------------------------------------------------
// Staff bot (SPEC-STAFF). Times are Taipei `HH:MM`, durations floor to whole minutes
// (「X 小時 Y 分」), money is `NT$` with thousands separators.

/** `570.9` → `9 小時 30 分` (floored). */
export function staffDuration(totalMinutes: number): string {
  const { hours, minutes } = splitMinutes(totalMinutes);
  return `${hours} 小時 ${minutes} 分`;
}

/** `33667` → `NT$33,667`. */
export function staffMoney(amount: number): string {
  const sign = amount < 0 ? '-' : '';
  const digits = String(Math.abs(Math.round(amount))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}NT$${digits}`;
}

/** `2026-11-02` → `11/2`. */
export function staffDay(date: LocalDate): string {
  const [, m, d] = date.split('-');
  return `${Number(m)}/${Number(d)}`;
}

/** ISO instant → Taipei `HH:MM`. */
export function staffTime(iso: string): string {
  return taipeiTime(new Date(iso));
}

/** ISO instant → Taipei `11/12 09:00`. */
export function staffDayTime(iso: string): string {
  const d = new Date(iso);
  return `${staffDay(taipeiDate(d))} ${taipeiTime(d)}`;
}

/**
 * A shift's time span: `11/12 09:00–18:00`; an end on another Taipei day carries its date
 * (`11/12 22:00–11/13 02:00`); no end → `11/12 09:00–未下班`.
 */
export function staffSpan(startIso: string, endIso: string | null): string {
  if (!endIso) return `${staffDayTime(startIso)}–未下班`;
  const sameDay = taipeiDate(new Date(startIso)) === taipeiDate(new Date(endIso));
  return `${staffDayTime(startIso)}–${sameDay ? staffTime(endIso) : staffDayTime(endIso)}`;
}

export function staffKind(kind: PunchKind): string {
  return kind === 'in' ? '上班' : '下班';
}

/** Payday of `month`'s payroll: day `payday` of the next month, as `12/15`. */
export function staffPayday(month: Month, payday: number): string {
  const m = Number(month.split('-')[1]);
  return `${m === 12 ? 1 : m + 1}/${payday}`;
}

export const staffTexts = {
  welcome: '這是員工打卡帳號。打卡請在群組輸入：上班、下班。輸入：說明 查看指令。',
  notRegistered: '尚未註冊，請輸入：註冊 你的名字',
  notRegisteredDm: '尚未註冊，請在打卡群組輸入：註冊 你的名字',
  registerInGroup: '註冊請在打卡群組輸入：註冊 你的名字',
  punchInGroup: '打卡請在群組輸入：上班 或 下班',
  pendingApproval: '申請審核中',
  unknownCommand: '看不懂這個指令，輸入：說明',
  error: '系統忙碌中，請稍後再試。',
  noPending: '目前沒有待處理項目',
  noEmployees: '目前沒有員工',
  correctionFuture: '不能補未來的時間',
  correctionTooOld: '只能補上個月 1 日以後的打卡',
  employeeHelp: [
    '員工指令：',
    '群組：上班、下班、註冊 你的名字',
    '補卡 11/12 09:00 上班、補卡 11/12 09:00-18:00 整班（群組或私訊）',
    '取消 R001（取消自己待審的補卡，群組或私訊）',
    '我的打卡、我的打卡 2026-11',
    '我的薪資、我的薪資 2026-11',
  ].join('\n'),
  adminHelp: [
    '管理員指令：',
    '員工列表、待處理',
    '核准 E001 時薪 200、駁回 E001',
    '核准 R001、駁回 R001',
    '時薪 E001 210、時薪 E001 210 自 12/1',
    '補卡 E001 11/12 18:00 下班、補卡 E001 11/12 09:00-18:00',
    '修改 S0123 上班 09:00、修改 S0123 下班 11/13 02:00',
    '刪除打卡 E001 11/12，再回：刪除 S0123',
    '停用 E001、啟用 E001',
    '打卡紀錄 E001 2026-11',
    '結算 2026-11、結算 2026-11 通知員工',
    '備份、備份 強制（寫入備份試算表）',
  ].join('\n'),
  /** Usage hint for a known keyword with bad arguments. */
  usage: {
    註冊: '格式：註冊 你的名字（最多 20 字）',
    補卡: '格式：補卡 11/12 09:00 上班、補卡 11/12 18:00 下班 或 補卡 11/12 09:00-18:00',
    我的打卡: '格式：我的打卡 或 我的打卡 2026-11',
    我的薪資: '格式：我的薪資 或 我的薪資 2026-11',
    說明: '格式：說明',
    員工列表: '格式：員工列表',
    待處理: '格式：待處理',
    核准: '格式：核准 E001 時薪 200 或 核准 R001',
    駁回: '格式：駁回 E001 或 駁回 R001',
    時薪: '格式：時薪 E001 210 或 時薪 E001 210 自 12/1',
    刪除打卡: '格式：刪除打卡 E001 11/12',
    刪除: '格式：刪除 S0123（先用 刪除打卡 E001 11/12 查編號）',
    停用: '格式：停用 E001',
    啟用: '格式：啟用 E001',
    打卡紀錄: '格式：打卡紀錄 E001 2026-11',
    結算: '格式：結算 2026-11 或 結算 2026-11 通知員工',
    修改: '格式：修改 S0123 上班 09:00、修改 S0123 下班 18:30 或 修改 S0123 下班 11/13 02:00',
    取消: '格式：取消 R001',
    備份: '格式：備份 或 備份 強制',
  } satisfies Record<CommandKeyword, string>,
  /** Extra line for admins who mistype 補卡. */
  adminCorrectionUsage: '代補：補卡 E001 11/12 18:00 下班 或 補卡 E001 11/12 09:00-18:00',
  /** §16: `備份` while STAFF_BACKUP_SHEET_URL / STAFF_BACKUP_TOKEN are not both set. */
  backupNotConfigured: '尚未設定備份試算表',
  /** §16.5: a backup succeeded after a streak of failed scheduled backups. */
  backupRecovered: '備份已恢復',
} as const;

// --- §4 registration ---

export function staffRegisterRequested(displayId: string, name: string): string {
  return `已送出註冊申請（${displayId} ${name}），等待管理員核准`;
}
export function staffAlreadyRegistered(name: string): string {
  return `你已註冊為 ${name}`;
}
export function staffDisabled(name: string): string {
  return `${name} 已停用，請聯絡管理員`;
}
export function staffAdminRegistrationNotice(displayId: string, name: string): string {
  return `員工註冊申請 ${displayId} ${name}。核准請回：核准 ${displayId} 時薪 200`;
}
export function staffRegistrationApprovedGroup(name: string): string {
  return `${name} 已可打卡`;
}
export function staffRegistrationRejectedDm(name: string): string {
  return `${name} 的註冊申請未通過`;
}
export function staffBelowMinimum(minWage: number): string {
  return `注意：時薪低於基本工資 ${staffMoney(minWage)}`;
}
export function staffApprovedRegistration(
  displayId: string,
  name: string,
  wage: number,
  from: LocalDate,
): string {
  return `已核准 ${displayId} ${name}，時薪 ${staffMoney(wage)} 自 ${staffDay(from)} 起`;
}
export function staffRejectedRegistration(displayId: string, name: string): string {
  return `已駁回 ${displayId} ${name} 的註冊申請`;
}
export function staffNotFound(displayId: string): string {
  return `找不到 ${displayId}`;
}
export function staffNotPending(displayId: string, name: string): string {
  return `${displayId} ${name} 不是申請中的註冊`;
}
export function staffNotApproved(displayId: string, name: string): string {
  return `${displayId} ${name} 尚未核准註冊`;
}

// --- §5 punches ---

export function staffClockedIn(name: string, iso: string): string {
  return `${name} 上班 ${staffTime(iso)}`;
}
export function staffStaleShiftNote(startIso: string): string {
  return `前一班（${staffDayTime(startIso)} 上班）未下班，請用補卡補下班時間`;
}
export function staffAlreadyIn(name: string, startIso: string): string {
  return `${name} 已在上班中（${staffTime(startIso)} 起）`;
}
export function staffClockedOut(name: string, endIso: string, minutes: number): string {
  return `${name} 下班 ${staffTime(endIso)}，本次 ${staffDuration(minutes)}`;
}
export function staffNoOpenShift(name: string, today: LocalDate): string {
  return `${name} 沒有上班紀錄，請用補卡：補卡 ${staffDay(today)} 09:00 上班`;
}
export function staffOverdue(name: string, maxHours: number): string {
  return `${name} 上班紀錄已超過 ${maxHours} 小時，請用補卡補下班時間`;
}

// --- §6 corrections ---

/**
 * `11/12 09:00 上班`; a whole shift (§15.4, `endIso` set) → `11/12 09:00–18:00 整班`
 * (`11/12 22:00–11/13 02:00 整班` across midnight).
 */
export function staffCorrectionWhat(
  atIso: string,
  kind: CorrectionKind,
  endIso: string | null = null,
): string {
  if (kind === 'shift') return `${staffSpan(atIso, endIso)} 整班`;
  return `${staffDayTime(atIso)} ${staffKind(kind)}`;
}
export function staffCorrectionRequested(
  displayId: string,
  atIso: string,
  kind: CorrectionKind,
  endIso: string | null = null,
): string {
  return `已送出補卡申請 ${displayId}（${staffCorrectionWhat(atIso, kind, endIso)}），等待管理員核准`;
}
export function staffCorrectionDuplicate(
  displayId: string,
  atIso: string,
  kind: CorrectionKind,
  endIso: string | null = null,
): string {
  return `補卡申請 ${displayId}（${staffCorrectionWhat(atIso, kind, endIso)}）已在審核中`;
}
/** §15.4: a whole-shift request longer than STAFF_MAX_SHIFT_HOURS. */
export function staffCorrectionTooLong(maxHours: number): string {
  return `整班補卡不能超過 ${maxHours} 小時`;
}
export function staffAdminCorrectionNotice(
  displayId: string,
  name: string,
  atIso: string,
  kind: CorrectionKind,
  endIso: string | null = null,
): string {
  return `補卡申請 ${displayId} ${name} ${staffCorrectionWhat(atIso, kind, endIso)}。核准請回：核准 ${displayId}，駁回請回：駁回 ${displayId}`;
}
export function staffCorrectionApprovedDm(displayId: string): string {
  return `補卡 ${displayId} 已核准`;
}
export function staffCorrectionRejectedDm(displayId: string): string {
  return `補卡 ${displayId} 已駁回`;
}
/** Group fallback when the applicant cannot be DMed. */
export function staffCorrectionDecisionGroup(
  name: string,
  displayId: string,
  approved: boolean,
): string {
  return `${name} 補卡 ${displayId} ${approved ? '已核准' : '已駁回'}`;
}
export function staffApprovedCorrection(
  displayId: string,
  name: string,
  atIso: string,
  kind: CorrectionKind,
  pairedDisplayId: string | null,
  endIso: string | null = null,
): string {
  const paired = pairedDisplayId ? `，同時套用 ${pairedDisplayId}` : '';
  return `已核准補卡 ${displayId}（${name} ${staffCorrectionWhat(atIso, kind, endIso)}）${paired}`;
}
export function staffRejectedCorrection(displayId: string, name: string): string {
  return `已駁回補卡 ${displayId}（${name}）`;
}
export function staffAdminCorrectionApplied(
  employeeDisplayId: string,
  name: string,
  atIso: string,
  kind: CorrectionKind,
  requestDisplayId: string,
  endIso: string | null = null,
): string {
  return `已代補 ${employeeDisplayId} ${name} ${staffCorrectionWhat(atIso, kind, endIso)}（${requestDisplayId}）`;
}

export type StaffCorrectionFailureReason = 'noOpenShift' | 'overlap' | 'exceedsMaxHours';
export interface StaffConflictView {
  displayId: string;
  startAt: string;
  endAt: string | null;
}

/** §15.1 reason wording, shared by the admin answer and the applicant notice. */
function staffCorrectionReason(
  reason: StaffCorrectionFailureReason,
  conflict: StaffConflictView | null,
  maxHours: number,
): string {
  switch (reason) {
    case 'noOpenShift':
      return '找不到可配對的上班紀錄';
    case 'exceedsMaxHours':
      return `超過 ${maxHours} 小時`;
    case 'overlap':
      return conflict
        ? `和 ${conflict.displayId}（${staffSpan(conflict.startAt, conflict.endAt)}）重疊`
        : '和其他班重疊';
  }
}
/** Admin answer when an approval / 代補 cannot be applied. */
export function staffCorrectionFailed(
  displayId: string,
  reason: StaffCorrectionFailureReason,
  conflict: StaffConflictView | null,
  maxHours: number,
): string {
  return `補卡 ${displayId} 無法套用：${staffCorrectionReason(reason, conflict, maxHours)}`;
}
/**
 * §15.1 notice to the applicant of a failed approval. A 下班 without a 上班 stays waiting for one
 * (§6), so it is told the pairing will happen later instead of being sent to the admin.
 */
export function staffCorrectionFailedDm(
  displayId: string,
  reason: StaffCorrectionFailureReason,
  conflict: StaffConflictView | null,
  maxHours: number,
): string {
  const head = `補卡 ${displayId} 無法套用：${staffCorrectionReason(reason, conflict, maxHours)}`;
  return reason === 'noOpenShift' ? `${head}，等補上班紀錄後會自動配對` : `${head}，請聯絡管理員`;
}
/** Group fallback of `staffCorrectionFailedDm`. */
export function staffCorrectionFailedGroup(
  name: string,
  displayId: string,
  reason: StaffCorrectionFailureReason,
  conflict: StaffConflictView | null,
  maxHours: number,
): string {
  return `${name} ${staffCorrectionFailedDm(displayId, reason, conflict, maxHours)}`;
}

const STAFF_CORRECTION_STATUS_LABEL: Record<string, string> = {
  approved: '已核准',
  rejected: '已駁回',
  failed: '核准失敗',
  cancelled: '已取消',
};
/** 核准 / 駁回 of a request that is no longer pending; cancelled → `R001 已取消` (§15.3). */
export function staffCorrectionAlreadyDecided(displayId: string, status: string): string {
  if (status === 'cancelled') return `${displayId} 已取消`;
  return `${displayId} 已處理過（${STAFF_CORRECTION_STATUS_LABEL[status] ?? status}）`;
}
/** §15.3 `取消 R001` done. */
export function staffCorrectionCancelled(
  displayId: string,
  atIso: string,
  kind: CorrectionKind,
  endIso: string | null = null,
): string {
  return `已取消補卡申請 ${displayId}（${staffCorrectionWhat(atIso, kind, endIso)}）`;
}
/** §15.3 `取消 R001` on a request that is no longer pending. */
export function staffCorrectionNotCancellable(displayId: string, status: string): string {
  return `${displayId} ${STAFF_CORRECTION_STATUS_LABEL[status] ?? status}，無法取消`;
}

/** §15.2: extra answer line when a change touches a month that already has a payroll run. */
export function staffSettledHint(month: Month): string {
  return `${month} 已結算，請輸入：結算 ${month} 重新結算`;
}

// --- §7 wages / admin ops ---

export function staffWageSet(
  displayId: string,
  name: string,
  wage: number,
  from: LocalDate,
  previous: number | null,
): string {
  const prev = previous !== null ? `（原 ${staffMoney(previous)}）` : '';
  return `已設定 ${displayId} ${name} 時薪 ${staffMoney(wage)}，自 ${staffDay(from)} 起${prev}`;
}
export function staffStatusUpdated(displayId: string, name: string, disabled: boolean): string {
  return `已${disabled ? '停用' : '啟用'} ${displayId} ${name}`;
}
export function staffStatusUnchanged(displayId: string, name: string, disabled: boolean): string {
  return `${displayId} ${name} 已是${disabled ? '停用' : '啟用'}狀態`;
}
export function staffShiftDeleted(
  shiftDisplayId: string,
  name: string,
  startIso: string,
  endIso: string | null,
): string {
  return `已刪除 ${shiftDisplayId}（${name} ${staffDayTime(startIso)}–${endIso ? staffTime(endIso) : '未下班'}）`;
}
export function staffShiftAlreadyDeleted(shiftDisplayId: string): string {
  return `${shiftDisplayId} 已刪除過`;
}

/** §15.2 `修改 S0123` done: `已修改 S0123 王小明 11/12 09:00–18:30（9 小時 30 分）`. */
export function staffShiftEdited(
  shiftDisplayId: string,
  name: string,
  startIso: string,
  endIso: string | null,
  minutes: number | null,
): string {
  const length = minutes !== null ? `（${staffDuration(minutes)}）` : '';
  return `已修改 ${shiftDisplayId} ${name} ${staffSpan(startIso, endIso)}${length}`;
}
export function staffShiftEditDeleted(shiftDisplayId: string): string {
  return `${shiftDisplayId} 已刪除，無法修改`;
}
/** §15.2 refused edit (nothing written). */
export function staffShiftEditRefused(
  shiftDisplayId: string,
  reason: 'notAfterStart' | 'exceedsMaxHours' | 'future' | 'tooOld' | 'overlap',
  conflict: StaffConflictView | null,
  maxHours: number,
): string {
  const head = `無法修改 ${shiftDisplayId}：`;
  switch (reason) {
    case 'notAfterStart':
      return `${head}上班時間須早於下班時間`;
    case 'exceedsMaxHours':
      return `${head}該班會超過 ${maxHours} 小時`;
    case 'future':
      return `${head}不能改成未來的時間`;
    case 'tooOld':
      return `${head}只能修改上個月 1 日以後的打卡`;
    case 'overlap':
      return `${head}${staffCorrectionReason('overlap', conflict, maxHours)}`;
  }
}

const STAFF_STATUS_LABEL: Record<string, string> = {
  pending: '申請中',
  active: '啟用',
  disabled: '停用',
};

export function staffEmployeeList(
  rows: { displayId: string; name: string; status: string; currentWage: number | null }[],
): string[] {
  if (rows.length === 0) return [staffTexts.noEmployees];
  return [
    '員工列表',
    ...rows.map(
      (r) =>
        `${r.displayId} ${r.name}｜${STAFF_STATUS_LABEL[r.status] ?? r.status}｜${
          r.currentWage !== null ? staffMoney(r.currentWage) : '未設定時薪'
        }`,
    ),
  ];
}

export interface StaffPendingView {
  registrations: { displayId: string; name: string }[];
  corrections: {
    displayId: string;
    name: string;
    at: string;
    kind: CorrectionKind;
    endAt: string | null;
  }[];
  openShifts: {
    shiftDisplayId: string;
    employeeDisplayId: string;
    name: string;
    startAt: string;
    overdue: boolean;
  }[];
}

export function staffPendingList(p: StaffPendingView): string[] {
  const lines: string[] = [];
  if (p.registrations.length > 0) {
    lines.push('註冊申請：');
    for (const r of p.registrations) lines.push(`${r.displayId} ${r.name}`);
  }
  if (p.corrections.length > 0) {
    lines.push('補卡申請：');
    for (const c of p.corrections) {
      lines.push(`${c.displayId} ${c.name} ${staffCorrectionWhat(c.at, c.kind, c.endAt)}`);
    }
  }
  if (p.openShifts.length > 0) {
    lines.push('未下班：');
    for (const s of p.openShifts) {
      const mark = s.overdue ? '（超過上限，需補卡）' : '（上班中）';
      lines.push(
        `${s.employeeDisplayId} ${s.name} ${s.shiftDisplayId} ${staffDayTime(s.startAt)} 上班${mark}`,
      );
    }
  }
  return lines.length === 0 ? [staffTexts.noPending] : lines;
}

/** One shift line: `11/3 09:02–18:05｜9 小時 3 分`, open → `11/12 09:02–未下班`. */
function staffShiftLine(s: ShiftDetail, showId: boolean): string {
  const id = showId ? `${s.displayId} ` : '';
  const start = `${staffDay(s.date)} ${staffTime(s.startAt)}`;
  if (!s.endAt || s.minutes === null) return `${id}${start}–未下班`;
  const nextDay = taipeiDate(new Date(s.endAt)) !== s.date ? '（隔日）' : '';
  return `${id}${start}–${staffTime(s.endAt)}${nextDay}｜${staffDuration(s.minutes)}`;
}

/** `我的打卡` (showIds false) and admin `打卡紀錄` (showIds true). Returns lines. */
export function staffShiftRecords(
  header: string,
  shifts: ShiftDetail[],
  showIds: boolean,
): string[] {
  if (shifts.length === 0) return [`${header}：沒有打卡紀錄`];
  const done = shifts.filter((s) => s.minutes !== null);
  const minutes = done.reduce((n, s) => n + (s.minutes ?? 0), 0);
  return [
    header,
    ...shifts.map((s) => staffShiftLine(s, showIds)),
    `合計 ${done.length} 班｜${staffDuration(minutes)}`,
  ];
}
export function staffMyShiftsHeader(month: Month, name: string): string {
  return `${month} 打卡紀錄（${name}）`;
}
export function staffShiftRecordsHeader(displayId: string, name: string, month: Month): string {
  return `${displayId} ${name} ${month} 打卡紀錄`;
}

/** `刪除打卡 E001 11/12` listing. */
export function staffShiftsOnDay(
  displayId: string,
  name: string,
  date: LocalDate,
  shifts: ShiftDetail[],
): string[] {
  const head = `${displayId} ${name} ${staffDay(date)}`;
  if (shifts.length === 0) return [`${head} 沒有打卡紀錄`];
  return [
    `${head} 的打卡：`,
    ...shifts.map((s) => staffShiftLine(s, true)),
    `刪除請回：刪除 ${shifts[0]!.displayId}`,
  ];
}

// --- §8 payroll ---

/** Employee pay message (monthly DM and `我的薪資`). `current`: the month is still running. */
export function staffPayMessage(
  line: PayrollEmployeeLine,
  month: Month,
  payday: number,
  current: boolean,
): string {
  const lines = [
    `${month} ${current ? '目前累計' : '薪資'}（${staffPayday(month, payday)} 發薪）`,
    `${line.name}｜${line.shiftCount} 班｜${staffDuration(line.totalMinutes)}`,
    `應發 ${staffMoney(line.pay)}`,
  ];
  for (const r of line.rates) {
    lines.push(`時薪 ${staffMoney(r.hourlyWage)}：${r.shiftCount} 班，${staffDuration(r.minutes)}`);
  }
  if (line.openShifts.length > 0) {
    lines.push(`另有 ${line.openShifts.length} 班未下班，未計入，請用補卡補下班時間`);
  }
  if (line.unpricedShifts.length > 0) {
    lines.push(`另有 ${line.unpricedShifts.length} 班沒有時薪，未計入，請聯絡管理員`);
  }
  lines.push(`明細請輸入：我的打卡 ${month}`);
  return lines.join('\n');
}

/**
 * Admin payroll summary as lines (the caller packs them into LINE messages). `notNotified`:
 * employee ids whose DM could not be delivered (「未加好友，未通知」).
 */
export function staffPayrollSummary(
  result: PayrollResult,
  payday: number,
  notNotified: ReadonlySet<number> = new Set(),
): string[] {
  const { month } = result;
  const lines = [`${month} 薪資結算（${staffPayday(month, payday)} 發薪）`];
  if (result.employees.length === 0) lines.push('沒有員工資料');
  for (const e of result.employees) {
    const disabled = e.status === 'disabled' ? '（已停用）' : '';
    const unsent = notNotified.has(e.employeeId) ? '｜未加好友，未通知' : '';
    lines.push(
      `${e.displayId} ${e.name}${disabled}｜${e.shiftCount} 班｜${staffDuration(e.totalMinutes)}｜${staffMoney(e.pay)}${unsent}`,
    );
  }
  lines.push(
    `合計｜${result.totals.shiftCount} 班｜${staffDuration(result.totals.totalMinutes)}｜${staffMoney(result.totals.pay)}`,
  );

  const flags: string[] = [];
  for (const e of result.employees) {
    for (const d of e.longDays) {
      flags.push(
        `${e.displayId} ${e.name} ${staffDay(d.date)} 超過 8 小時（${staffDuration(d.minutes)}）`,
      );
    }
    for (const w of e.longWeeks) {
      flags.push(
        `${e.displayId} ${e.name} ${staffDay(w.weekStart)}–${staffDay(w.weekEnd)} 週超過 40 小時（${staffDuration(w.minutes)}）`,
      );
    }
  }
  if (flags.length > 0) lines.push('工時標註（不另計加班費）：', ...flags);

  if (result.hasPending) {
    lines.push('待處理：');
    for (const e of result.employees) {
      for (const s of e.openShifts) {
        lines.push(
          `未下班 ${e.displayId} ${e.name} ${s.displayId} ${staffDayTime(s.startAt)} 上班`,
        );
      }
      for (const s of e.unpricedShifts) {
        lines.push(`沒有時薪 ${e.displayId} ${e.name} ${s.displayId} ${staffDay(s.date)}`);
      }
    }
    for (const c of result.pending.corrections) {
      lines.push(
        `補卡申請 ${c.displayId} ${c.name} ${staffCorrectionWhat(c.at, c.kind, c.endAt ?? null)}`,
      );
    }
    for (const r of result.pending.registrations) {
      lines.push(`註冊申請 ${r.displayId} ${r.name}`);
    }
    lines.push(`處理後可輸入：結算 ${month} 重新結算`);
  }
  return lines;
}

// --- §15.5 pending-correction reminder ---

/** At most this many requests are listed per reminder part; the rest are 「另有 N 筆」. */
export const STAFF_REMINDER_MAX_ITEMS = 10;

export interface StaffReminderItem {
  displayId: string;
  name: string;
  at: string;
  kind: CorrectionKind;
  endAt: string | null;
}

function staffReminderList(items: StaffReminderItem[]): string {
  const shown = items
    .slice(0, STAFF_REMINDER_MAX_ITEMS)
    .map((i) => `${i.displayId} ${i.name} ${staffCorrectionWhat(i.at, i.kind, i.endAt)}`);
  const rest = items.length - STAFF_REMINDER_MAX_ITEMS;
  if (rest > 0) shown.push(`另有 ${rest} 筆`);
  return shown.join('；');
}

/**
 * The daily admin reminder as lines (one message): requests pending longer than `staleDays`,
 * and on the day before payday the previous month's pending requests. Empty parts are left out.
 */
export function staffCorrectionReminder(r: {
  staleDays: number;
  stale: StaffReminderItem[];
  payday: { date: LocalDate; month: Month; items: StaffReminderItem[] } | null;
}): string[] {
  const lines: string[] = [];
  if (r.stale.length > 0) {
    lines.push(
      `有 ${r.stale.length} 筆補卡待處理超過 ${r.staleDays} 天：${staffReminderList(r.stale)}。輸入：待處理`,
    );
  }
  if (r.payday && r.payday.items.length > 0) {
    const { date, month, items } = r.payday;
    lines.push(
      `明天 ${staffDay(date)} 發薪，${month} 還有 ${items.length} 筆補卡待處理：${staffReminderList(items)}。處理後請輸入：結算 ${month}`,
    );
  }
  return lines;
}

// --- §16 monthly backup to Google Sheets ---

/** Tab names and header rows of the backup sheet, in tab order (§16.2). */
export const STAFF_BACKUP_SHEETS = {
  employees: {
    name: '員工',
    header: ['編號', '名字', '狀態', 'LINE userId', '申請時間', '核准時間', '核准者'],
  },
  wages: {
    name: '時薪',
    header: ['員工編號', '名字', '時薪', '生效日', '設定者', '設定時間'],
  },
  shifts: {
    name: '打卡',
    header: [
      '班號',
      '員工編號',
      '名字',
      '上班',
      '下班',
      '分鐘',
      '上班來源',
      '下班來源',
      '刪除時間',
      '建立時間',
      '更新時間',
    ],
  },
  corrections: {
    name: '補卡',
    header: [
      '編號',
      '員工編號',
      '名字',
      '類型',
      '時間',
      '結束時間',
      '狀態',
      '原因',
      '申請者',
      '群組',
      '班號',
      '申請時間',
      '處理者',
      '處理時間',
    ],
  },
  payroll: {
    name: '結算',
    header: [
      '結算編號',
      '月份',
      '執行時間',
      '觸發者',
      '員工編號',
      '名字',
      '班數',
      '分鐘',
      '應發金額',
    ],
  },
  audit: {
    name: '操作紀錄',
    header: ['編號', '操作者', '動作', '對象', '修改前', '修改後', '時間'],
  },
  info: {
    name: '備份資訊',
    header: ['備份時間', '觸發者', '資料庫版本'],
  },
} as const;

/** Cell labels for stored codes (one label per code, so the sheet stays faithful to the DB). */
export const STAFF_BACKUP_LABELS = {
  employeeStatus: { pending: '申請中', active: '啟用', disabled: '停用' } as Record<string, string>,
  correctionStatus: {
    pending: '待審',
    approved: '已核准',
    rejected: '已駁回',
    failed: '核准失敗',
    cancelled: '已取消',
  } as Record<string, string>,
  correctionKind: { in: '上班', out: '下班', shift: '整班' } as Record<string, string>,
  correctionReason: {
    noOpenShift: '找不到可配對的上班紀錄',
    overlap: '重疊',
    exceedsMaxHours: '超過時數上限',
  } as Record<string, string>,
  shiftSource: { punch: '打卡', correction: '補卡', admin: '管理員' } as Record<string, string>,
  /** `triggered_by` of scheduled payroll runs and backups. */
  schedule: '排程',
};

/** Why a backup failed (§16.5); `table` is the tab name for `shrink`. */
export type StaffBackupFailure =
  | { code: 'network' | 'timeout' | 'badResponse' | 'unauthorized' | 'busy' }
  | { code: 'http'; status: number }
  | { code: 'shrink'; table: string }
  | { code: 'script'; detail: string };

export function staffBackupReason(f: StaffBackupFailure): string {
  switch (f.code) {
    case 'network':
      return '網路錯誤';
    case 'timeout':
      return '連線逾時';
    case 'badResponse':
      return '試算表回應異常';
    case 'http':
      return `試算表回應異常（HTTP ${f.status}）`;
    case 'unauthorized':
      return '驗證碼不符';
    case 'busy':
      return '試算表忙碌中';
    case 'shrink':
      return `筆數減少（${f.table}）`;
    case 'script':
      return `試算表錯誤：${f.detail}`;
  }
}

/** Manual `備份` succeeded: `備份完成：員工 3、時薪 3、打卡 120…`. */
export function staffBackupDone(counts: { name: string; count: number }[]): string {
  return `備份完成：${counts.map((c) => `${c.name} ${c.count}`).join('、')}`;
}

/** Manual `備份` failed; a row-count drop also says how to overwrite anyway. */
export function staffBackupFailed(f: StaffBackupFailure): string {
  const hint = f.code === 'shrink' ? '。確定要覆寫請輸入：備份 強制' : '';
  return `備份失敗：${staffBackupReason(f)}${hint}`;
}

/** First failure of a streak of scheduled daily backups, DMed to every admin once. */
export function staffBackupScheduledFailed(date: LocalDate, f: StaffBackupFailure): string {
  return `${staffDay(date)} 每日備份失敗：${staffBackupReason(f)}。處理後可輸入：備份`;
}
