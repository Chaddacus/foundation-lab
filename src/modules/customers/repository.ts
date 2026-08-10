/**
 * Customers — persistence abstraction.
 *
 * Responsibility: own the `customers`, `users`, and `sessions` tables and every statement
 * touching them.
 *
 * Place in the system: internal to the Customers module. This is the only code permitted to
 * read or write those tables (SPEC §3.2).
 *
 * Boundary: rows in, rows out. No password hashing, no authorization decisions.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from '../../spine/database.ts';
import type { Customer, User } from './contract.ts';

export const migration: Migration = {
  module: 'customers',
  statements: [
    `CREATE TABLE IF NOT EXISTS customers (
       id         TEXT PRIMARY KEY,
       name       TEXT NOT NULL,
       created_at TEXT NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS users (
       id                  TEXT PRIMARY KEY,
       email               TEXT NOT NULL UNIQUE COLLATE NOCASE,
       password_verifier   TEXT NOT NULL,
       customer_id         TEXT NOT NULL REFERENCES customers(id),
       failed_attempts     INTEGER NOT NULL DEFAULT 0,
       locked_until        TEXT,
       created_at          TEXT NOT NULL
     )`,
    // Sessions cascade with the user: deleting a user must not leave usable credentials.
    `CREATE TABLE IF NOT EXISTS sessions (
       id         TEXT PRIMARY KEY,
       user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       expires_at TEXT NOT NULL,
       created_at TEXT NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_users_customer ON users (customer_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)`,
  ],
};

/** Storage row for a user. `password_verifier` exists ONLY here and never enters the contract. */
export interface UserRow {
  id: string;
  email: string;
  password_verifier: string;
  customer_id: string;
  failed_attempts: number;
  locked_until: string | null;
  created_at: string;
}

interface CustomerRow { id: string; name: string; created_at: string }
interface SessionRow { id: string; user_id: string; expires_at: string; created_at: string }

export class CustomersRepository {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  insertCustomer(customer: Customer): void {
    this.#db
      .prepare('INSERT INTO customers (id, name, created_at) VALUES (?, ?, ?)')
      .run(customer.id, customer.name, customer.createdAt);
  }

  findCustomerById(id: string): Customer | null {
    const row = this.#db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as CustomerRow | undefined;
    return row === undefined ? null : { id: row.id, name: row.name, createdAt: row.created_at };
  }

  insertUser(user: User & { passwordVerifier: string }): void {
    this.#db
      .prepare(
        `INSERT INTO users (id, email, password_verifier, customer_id, failed_attempts, created_at)
         VALUES (?, ?, ?, ?, 0, ?)`,
      )
      .run(user.id, user.email, user.passwordVerifier, user.customerId, user.createdAt);
  }

  /** Returns the full row including the verifier — for authentication use only. */
  findUserRowByEmail(email: string): UserRow | null {
    const row = this.#db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email) as UserRow | undefined;
    return row ?? null;
  }

  findUserById(id: string): User | null {
    const row = this.#db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row === undefined ? null : toUser(row);
  }

  /** Users of ONE customer. There is deliberately no unscoped list-all-users query. */
  listUsersByCustomer(customerId: string): readonly User[] {
    const rows = this.#db
      .prepare('SELECT * FROM users WHERE customer_id = ? ORDER BY email')
      .all(customerId) as UserRow[];
    return rows.map(toUser);
  }

  recordFailedAttempt(userId: string, failedAttempts: number, lockedUntil: string | null): void {
    this.#db
      .prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
      .run(failedAttempts, lockedUntil, userId);
  }

  clearFailedAttempts(userId: string): void {
    this.#db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(userId);
  }

  insertSession(session: { id: string; userId: string; expiresAt: string; createdAt: string }): void {
    this.#db
      .prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(session.id, session.userId, session.expiresAt, session.createdAt);
  }

  findSession(id: string): { id: string; userId: string; expiresAt: string } | null {
    const row = this.#db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    return row === undefined ? null : { id: row.id, userId: row.user_id, expiresAt: row.expires_at };
  }

  deleteSession(id: string): void {
    this.#db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  deleteExpiredSessions(now: string): void {
    this.#db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  }
}

function toUser(row: UserRow): User {
  return { id: row.id, email: row.email, customerId: row.customer_id, createdAt: row.created_at };
}
