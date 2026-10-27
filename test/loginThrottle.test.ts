import { describe, expect, it } from 'vitest';
import { createLoginThrottle } from '../src/panel/loginThrottle.js';

describe('createLoginThrottle', () => {
  it('bloqueia após `max` falhas e libera ao fim da janela ou após sucesso', () => {
    let now = 0;
    const throttle = createLoginThrottle({ max: 2, windowMs: 1000, now: () => now });
    throttle.registerFailure('ip');
    expect(throttle.isBlocked('ip')).toBe(false);
    throttle.registerFailure('ip');
    expect(throttle.isBlocked('ip')).toBe(true);
    expect(throttle.isBlocked('outro-ip')).toBe(false);
    now = 1000;
    expect(throttle.isBlocked('ip')).toBe(false);
    throttle.registerFailure('ip');
    throttle.reset('ip');
    throttle.registerFailure('ip');
    expect(throttle.isBlocked('ip')).toBe(false);
  });
});
