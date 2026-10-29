/**
 * All user-facing copy (Traditional Chinese, short, no emoji) lives here.
 * Do not hard-code reply text elsewhere.
 */
export const texts = {
  nonTextMessage: '目前只能處理文字訊息，請用文字描述你的問題。',
  welcomeFallback:
    '你好，我是王媽媽寵物手工零食的客服小幫手。有任何關於商品、訂單或網站使用的問題都可以直接問我。',
  placeholderAck: '已收到你的訊息，客服功能建置中，稍後會回覆你。',
} as const;
