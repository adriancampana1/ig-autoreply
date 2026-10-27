export class GraphApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code?: number,
    readonly subcode?: number,
    /** Minutos informados pela Meta em X-Business-Use-Case-Usage (estimated_time_to_regain_access). */
    readonly regainAccessMinutes?: number,
  ) {
    super(message);
    this.name = 'GraphApiError';
  }
}

export type FailReason =
  | 'token_invalid'
  | 'rate_limited'
  | 'messaging_disabled'
  | 'abuse_blocked'
  | 'comment_unavailable'
  | 'window_expired'
  | 'permission_denied'
  | 'temporary_error'
  | 'unknown_error';

export type ErrorKind = 'auth' | 'rate_limit' | 'messaging_disabled' | 'abuse' | 'permanent' | 'transient';

export interface ErrorClassification {
  kind: ErrorKind;
  reason: FailReason;
  /** Para 'transient': máximo de tentativas antes de desistir. */
  maxAttempts?: number;
  /** Para 'rate_limit': quanto esperar antes de tentar de novo. */
  retryAfterMs?: number;
  code?: string;
  message: string;
}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80002]);
const DEFAULT_RATE_LIMIT_WAIT_MS = 15 * 60_000;

/** Tabela única de decisão sobre erros da Graph API (spec §9). */
export function classifyError(error: unknown): ErrorClassification {
  if (!(error instanceof GraphApiError)) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: 'transient', reason: 'temporary_error', maxAttempts: 5, message };
  }
  const { code, subcode, httpStatus, message } = error;
  const base = { code: code !== undefined ? String(code) : `http_${httpStatus}`, message };

  if (code === 190) return { ...base, kind: 'auth', reason: 'token_invalid' };
  if (code !== undefined && RATE_LIMIT_CODES.has(code)) {
    const retryAfterMs = error.regainAccessMinutes ? error.regainAccessMinutes * 60_000 : DEFAULT_RATE_LIMIT_WAIT_MS;
    return { ...base, kind: 'rate_limit', reason: 'rate_limited', retryAfterMs };
  }
  if (code === 368 || /temporarily blocked|considered spam|abusive/i.test(message)) {
    return { ...base, kind: 'abuse', reason: 'abuse_blocked' };
  }
  if (/disabled access to instagram direct messaging/i.test(message)) {
    return { ...base, kind: 'messaging_disabled', reason: 'messaging_disabled' };
  }
  if (code === 10 && subcode === 2534022) return { ...base, kind: 'permanent', reason: 'window_expired' };
  if (/outside of allowed window|reply to this comment|already (been )?replied/i.test(message)) {
    return { ...base, kind: 'permanent', reason: 'window_expired' };
  }
  if (code === 100 || code === 551) return { ...base, kind: 'permanent', reason: 'comment_unavailable' };
  if (code === 10 || code === 200 || code === 3) return { ...base, kind: 'permanent', reason: 'permission_denied' };
  if (httpStatus >= 500 || code === 1 || code === 2) {
    return { ...base, kind: 'transient', reason: 'temporary_error', maxAttempts: 5 };
  }
  return { ...base, kind: 'transient', reason: 'unknown_error', maxAttempts: 2 };
}
