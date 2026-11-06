import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { VALID_ENV } from './helpers.js';

function problemsFor(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
}

describe('loadConfig', () => {
  it('builds a config with defaults from the minimal environment', () => {
    const config = loadConfig({ ...VALID_ENV });
    expect(config).toMatchObject({
      publicUrl: 'https://surface.example.com',
      secureCookies: true,
      databaseUrl: 'postgres://surface:pg-password@db:5432/surface',
      smtp: null,
      uploadMaxMb: 25,
      mcpEnabled: true,
      role: 'all',
      logLevel: 'info',
      metricsEnabled: false,
      trustProxy: true,
      port: 3000,
      host: '0.0.0.0',
      nodeEnv: 'production',
    });
  });

  it('reports every missing required variable at once, with how to fix it', () => {
    const problems = problemsFor({});
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/^SURFACE_URL is missing\. .*https:\/\/surface\.example\.com/);
    expect(problems[1]).toBe('SESSION_SECRET is missing. Generate one with: openssl rand -hex 32');
    expect(problems[2]).toMatch(/^DATABASE_URL is missing\. .*POSTGRES_PASSWORD/);
  });

  it('formats a readable message naming each variable', () => {
    expect(() => loadConfig({})).toThrowError(
      /Surface cannot start[\s\S]*✗ SURFACE_URL[\s\S]*\.env\.example/,
    );
  });

  it('treats blank values as unset', () => {
    expect(problemsFor({ ...VALID_ENV, SESSION_SECRET: '   ' })).toEqual([
      'SESSION_SECRET is missing. Generate one with: openssl rand -hex 32',
    ]);
  });

  it('normalises SURFACE_URL to its origin and derives secure cookies from the scheme', () => {
    const config = loadConfig({ ...VALID_ENV, SURFACE_URL: 'http://localhost:3000/' });
    expect(config.publicUrl).toBe('http://localhost:3000');
    expect(config.secureCookies).toBe(false);
  });

  it.each([
    ['surface.example.com', /absolute http\(s\) URL/],
    ['ftp://surface.example.com', /absolute http\(s\) URL/],
    ['https://example.com/surface', /without a path/],
  ])('rejects SURFACE_URL=%s', (value, message) => {
    const [problem] = problemsFor({ ...VALID_ENV, SURFACE_URL: value });
    expect(problem).toMatch(message);
  });

  it('rejects a short SESSION_SECRET without echoing it', () => {
    const [problem] = problemsFor({ ...VALID_ENV, SESSION_SECRET: 'not-a-real-secret-value' });
    expect(problem).toMatch(/at least 32 bytes .*openssl rand -hex 32/);
    expect(problem).not.toContain('not-a-real-secret-value');
  });

  it('prefers DATABASE_URL and never echoes its password', () => {
    expect(
      loadConfig({
        ...VALID_ENV,
        DATABASE_URL: 'postgresql://u:p@db.internal:5432/s?sslmode=require',
      }).databaseUrl,
    ).toBe('postgresql://u:p@db.internal:5432/s?sslmode=require');

    const [problem] = problemsFor({ ...VALID_ENV, DATABASE_URL: 'mysql://u:hunter2@h/db' });
    expect(problem).toMatch(/must be a PostgreSQL connection URL/);
    expect(problem).not.toContain('hunter2');
  });

  it('URL-encodes POSTGRES_PASSWORD into the composed DATABASE_URL', () => {
    expect(loadConfig({ ...VALID_ENV, POSTGRES_PASSWORD: 'p@ss/w:rd' }).databaseUrl).toBe(
      'postgres://surface:p%40ss%2Fw%3Ard@db:5432/surface',
    );
  });

  it('enables SMTP only with both SMTP_URL and SMTP_FROM', () => {
    const smtp = {
      SMTP_URL: 'smtps://user:mailpw@smtp.example.com:465',
      SMTP_FROM: 'Surface <s@example.com>',
    };
    expect(loadConfig({ ...VALID_ENV, ...smtp }).smtp).toEqual({
      url: smtp.SMTP_URL,
      from: smtp.SMTP_FROM,
    });
    expect(problemsFor({ ...VALID_ENV, SMTP_URL: smtp.SMTP_URL })).toEqual([
      expect.stringMatching(/^SMTP_FROM is missing/),
    ]);
    const [problem] = problemsFor({
      ...VALID_ENV,
      SMTP_URL: 'http://user:mailpw@host',
      SMTP_FROM: 'x',
    });
    expect(problem).toMatch(/^SMTP_URL must look like smtp:\/\//);
    expect(problem).not.toContain('mailpw');
  });

  it.each([
    ['METRICS_ENABLED', 'maybe', /METRICS_ENABLED must be true or false \(got "maybe"\)/],
    ['TRUST_PROXY', '2', /TRUST_PROXY must be true or false/],
    ['UPLOAD_MAX_MB', '0', /UPLOAD_MAX_MB must be a whole number from 1 to 10240/],
    ['PORT', '3000.5', /PORT must be a whole number/],
    ['LOG_LEVEL', 'verbose', /LOG_LEVEL must be one of fatal, error, warn, info/],
    ['SURFACE_ROLE', 'api', /SURFACE_ROLE must be one of all, web, worker/],
    ['SURFACE_SETUP_TOKEN', 'short', /at least 16 characters/],
  ])('rejects %s=%s', (name, value, message) => {
    expect(problemsFor({ ...VALID_ENV, [name]: value })).toEqual([expect.stringMatching(message)]);
  });

  it('parses booleans, numbers and enums', () => {
    const config = loadConfig({
      ...VALID_ENV,
      METRICS_ENABLED: 'yes',
      TRUST_PROXY: 'false',
      MCP_ENABLED: '0',
      UPLOAD_MAX_MB: '100',
      LOG_LEVEL: 'DEBUG',
      SURFACE_ROLE: 'worker',
    });
    expect(config).toMatchObject({
      metricsEnabled: true,
      trustProxy: false,
      mcpEnabled: false,
      uploadMaxMb: 100,
      logLevel: 'debug',
      role: 'worker',
    });
  });
});
