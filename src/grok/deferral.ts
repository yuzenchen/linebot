/**
 * Phrases a Cursor agent uses when it hands a service question to a human instead of answering
 * it. A `done` callback whose text matches is treated as a deferral and opens a ticket
 * (SPEC-ADMIN §12.4), so the customer is not left waiting for a human nobody knows about.
 */
export const DEFERRAL_RE =
  /轉給專人|轉交專人|專人(查詢|確認|回覆|處理|聯繫|跟你聯)|人工(客服|處理)|幫你通知專人|已通知專人/;

export function looksLikeDeferral(text: string): boolean {
  return DEFERRAL_RE.test(text);
}
