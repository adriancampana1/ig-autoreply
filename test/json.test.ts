import { describe, expect, it } from 'vitest';
import { quoteLargeIds } from '../src/lib/json.js';

describe('quoteLargeIds', () => {
  it('transforma id/user_id numéricos em string, preservando todos os dígitos', () => {
    const parsed = JSON.parse(quoteLargeIds('{"id":17841405793187219,"user_id": 17841405793187221,"n":1}'));
    expect(parsed).toEqual({ id: '17841405793187219', user_id: '17841405793187221', n: 1 });
  });

  it('não altera ids que já são string nem outros campos numéricos', () => {
    const text = '{"id":"123","count":99999999999999999999}';
    expect(quoteLargeIds(text)).toBe(text);
  });
});
