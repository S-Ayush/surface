// SPEC-001 AC-9 (length part): the password rule shared by the setup, invite and reset forms.
import { describe, expect, it } from 'vitest';
import {
  EMAIL_MAX_LENGTH,
  emailProblem,
  normaliseEmail,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordProblem,
} from './auth.js';

describe('passwordProblem', () => {
  it('accepts 10 characters or more', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(10);
    expect(passwordProblem('a'.repeat(10))).toBeUndefined();
    expect(passwordProblem('correct horse battery staple')).toBeUndefined();
  });

  it('refuses fewer than 10 characters, saying how many are needed', () => {
    expect(passwordProblem('a'.repeat(9))).toBe('Password must be at least 10 characters long');
    expect(passwordProblem('')).toBeDefined();
  });

  it('counts characters as the user sees them, not UTF-16 units', () => {
    expect(passwordProblem('🔑'.repeat(9))).toBeDefined();
    expect(passwordProblem('🔑'.repeat(10))).toBeUndefined();
  });

  it('refuses a password longer than the maximum', () => {
    expect(passwordProblem('a'.repeat(PASSWORD_MAX_LENGTH))).toBeUndefined();
    expect(passwordProblem('a'.repeat(PASSWORD_MAX_LENGTH + 1))).toBeDefined();
  });
});

describe('emailProblem', () => {
  it('accepts an ordinary address, ignoring surrounding spaces', () => {
    expect(emailProblem('ada@example.com')).toBeUndefined();
    expect(emailProblem('  Ada.Lovelace+setup@example.co.uk ')).toBeUndefined();
  });

  it('refuses what the server refuses, so the form says it first', () => {
    for (const email of ['', 'ada', 'ada@', '@example.com', 'ada@example', 'a@b..c', 'a b@c.de']) {
      expect(emailProblem(email), email).toBeDefined();
    }
  });

  it('refuses an address longer than the maximum', () => {
    const long = `${'a'.repeat(EMAIL_MAX_LENGTH - '@example.com'.length + 1)}@example.com`;
    expect(emailProblem(long)).toBe('Email must be at most 254 characters long');
  });
});

describe('normaliseEmail', () => {
  it('drops surrounding spaces and lowercases, so any spelling finds the account (E2)', () => {
    expect(normaliseEmail('  Ada@Example.COM ')).toBe('ada@example.com');
  });
});
