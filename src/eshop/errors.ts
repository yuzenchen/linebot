/**
 * Error classes for the eshop read-only client. Every error carries a zh-TW `userMessage`
 * the admin handler can show as-is.
 */

export class EshopError extends Error {
  readonly userMessage: string;
  constructor(message: string, userMessage: string) {
    super(message);
    this.name = 'EshopError';
    this.userMessage = userMessage;
  }
}

export type EshopAuthReason =
  'login_failed' | 'login_locked_out' | 'bad_login_response' | 'network_error';

const authMessages: Record<EshopAuthReason, string> = {
  login_failed: '後台登入失敗，請檢查 bot 帳號設定',
  login_locked_out: '後台登入暫時被鎖定，15 分鐘後再試',
  bad_login_response: '後台登入回應格式異常',
  network_error: '無法連線到後台，請稍後再試',
};

export class EshopAuthError extends EshopError {
  readonly reason: EshopAuthReason;
  readonly status?: number;
  constructor(reason: EshopAuthReason, detail?: string, status?: number) {
    super(detail ? `${reason}: ${detail}` : reason, authMessages[reason]);
    this.name = 'EshopAuthError';
    this.reason = reason;
    this.status = status;
  }
}

export class EshopRateLimited extends EshopError {
  readonly retryAfter?: number;
  constructor(retryAfter?: number) {
    super(
      retryAfter === undefined
        ? 'rate limited (429)'
        : `rate limited (429), retry after ${retryAfter}s`,
      '後台目前請求過多，請稍後再試',
    );
    this.name = 'EshopRateLimited';
    this.retryAfter = retryAfter;
  }
}

export class EshopHttpError extends EshopError {
  readonly status: number;
  readonly bodySnippet: string;
  constructor(status: number, bodySnippet: string) {
    super(`HTTP ${status}: ${bodySnippet}`, `後台回應錯誤（HTTP ${status}），請稍後再試`);
    this.name = 'EshopHttpError';
    this.status = status;
    this.bodySnippet = bodySnippet;
  }
}

export class EshopBadResponse extends EshopError {
  readonly path: string;
  constructor(path: string, detail: string) {
    super(`bad response from ${path}: ${detail}`, '後台回應格式異常，請稍後再試');
    this.name = 'EshopBadResponse';
    this.path = path;
  }
}

export class EshopTimeout extends EshopError {
  constructor(path: string) {
    super(`timeout: ${path}`, '後台回應逾時，請稍後再試');
    this.name = 'EshopTimeout';
  }
}

export class EshopNetworkError extends EshopError {
  constructor(path: string, detail: string) {
    super(`network error on ${path}: ${detail}`, '無法連線到後台，請稍後再試');
    this.name = 'EshopNetworkError';
  }
}
