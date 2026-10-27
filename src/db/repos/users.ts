import type { DB } from '../database.js';

export interface User {
  id: number;
  email: string;
  passwordHash: string;
}

export function createUser(db: DB, email: string, passwordHash: string, now: number): number {
  return Number(
    db.prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)').run(email.toLowerCase(), passwordHash, now)
      .lastInsertRowid,
  );
}

export function setUserPassword(db: DB, email: string, passwordHash: string): boolean {
  return db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(passwordHash, email.toLowerCase()).changes > 0;
}

export function findUserByEmail(db: DB, email: string): User | undefined {
  return db
    .prepare('SELECT id, email, password_hash AS passwordHash FROM users WHERE email = ?')
    .get(email.toLowerCase()) as User | undefined;
}

export function findUserById(db: DB, id: number): User | undefined {
  return db.prepare('SELECT id, email, password_hash AS passwordHash FROM users WHERE id = ?').get(id) as User | undefined;
}
