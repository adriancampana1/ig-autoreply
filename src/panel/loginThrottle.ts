/** Limita tentativas de login com falha por chave (IP): `max` falhas a cada `windowMs`. */
export function createLoginThrottle(options: { max: number; windowMs: number; now: () => number }) {
  const failures = new Map<string, { count: number; resetAt: number }>();

  const current = (key: string) => {
    const entry = failures.get(key);
    if (entry && entry.resetAt <= options.now()) {
      failures.delete(key);
      return undefined;
    }
    return entry;
  };

  return {
    isBlocked(key: string): boolean {
      return (current(key)?.count ?? 0) >= options.max;
    },
    registerFailure(key: string): void {
      const entry = current(key);
      if (entry) entry.count += 1;
      else failures.set(key, { count: 1, resetAt: options.now() + options.windowMs });
    },
    reset(key: string): void {
      failures.delete(key);
    },
  };
}
