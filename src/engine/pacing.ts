// Parâmetros de ritmo e retentativa (spec §6.2, §6.3, §9 e §10). Altere aqui, em um só lugar.
export const PUBLIC_REPLY_DELAY_MS = { min: 15_000, max: 90_000 } as const;
export const PRIVATE_REPLY_EXTRA_DELAY_MS = { min: 3_000, max: 10_000 } as const;
export const MIN_INTERVAL_BETWEEN_ACTIONS_MS = 8_000;
export const SAFETY_PAUSE_MS = 24 * 60 * 60_000;
export const COMMENT_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const RECONNECT_RETRY_MS = 30 * 60_000;
export const TRANSIENT_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 60 * 60_000] as const;

export function randomBetween(range: { min: number; max: number }, random: () => number): number {
  return range.min + Math.floor(random() * (range.max - range.min + 1));
}

/** Espera antes da próxima tentativa após `attempts` falhas transitórias (1 → 1 min, 2 → 5 min ...). */
export function transientBackoff(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), TRANSIENT_BACKOFF_MS.length) - 1;
  return TRANSIENT_BACKOFF_MS[index]!;
}

/**
 * Quando a conta pode executar a próxima ação, respeitando intervalo mínimo e teto por hora.
 * Retorna `now` se já pode agir.
 */
export function nextAllowedAt(input: {
  now: number;
  lastActionAt: number | null;
  actionsLastHour: number;
  maxPerHour: number;
}): number {
  const { now, lastActionAt, actionsLastHour, maxPerHour } = input;
  let at = now;
  if (lastActionAt !== null) at = Math.max(at, lastActionAt + MIN_INTERVAL_BETWEEN_ACTIONS_MS);
  if (actionsLastHour >= maxPerHour) at = Math.max(at, now + 5 * 60_000);
  return at;
}
