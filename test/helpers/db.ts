import { migrate, openDatabase, type DB } from '../../src/db/database.js';
import { upsertConnectedAccount, type Account } from '../../src/db/repos/accounts.js';
import { createAutomation, type Automation, type NewAutomation } from '../../src/db/repos/automations.js';

export const T0 = Date.parse('2026-10-27T12:00:00Z');

export function makeDb(): DB {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

export function seedAccount(db: DB, overrides: Partial<{ igId: string; username: string; tokenEnc: string }> = {}): Account {
  return upsertConnectedAccount(
    db,
    {
      igId: overrides.igId ?? 'IG1',
      appUserId: `APP-${overrides.igId ?? 'IG1'}`,
      username: overrides.username ?? 'loja',
      tokenEnc: overrides.tokenEnc ?? 'enc-token',
      tokenExpiresAt: T0 + 60 * 86_400_000,
    },
    T0,
  );
}

export function seedAutomation(db: DB, accountId: number, overrides: Partial<NewAutomation> = {}, createdAt = T0): Automation {
  return createAutomation(
    db,
    {
      accountId,
      mediaId: 'M1',
      mediaPermalink: 'https://www.instagram.com/p/abc/',
      mediaCaption: 'Post de teste',
      keywords: ['eu quero'],
      publicVariations: ['Oi {usuario}, te mandei no direct!', 'Enviado {usuario}!', 'Olha o direct {usuario}'],
      dmText: 'Aqui está o link: https://exemplo.com (mensagem automática)',
      ...overrides,
    },
    createdAt,
  );
}
