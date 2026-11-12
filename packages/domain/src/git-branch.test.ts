// SPEC-012 AC-10 and D19: <displayName>/<identifier lowercased>-<title slug>, at most 60 characters.
import { describe, expect, it } from 'vitest';
import { BRANCH_NAME_MAX, foldToSlug, gitBranchName } from './git-branch.js';

describe('gitBranchName', () => {
  it('joins the name, the lowercased identifier and the slug', () => {
    expect(gitBranchName('Ada Lovelace', 'ENG-42', 'fix-login-redirect')).toBe(
      'ada-lovelace/eng-42-fix-login-redirect',
    );
  });

  it('folds accents and symbols in the display name to ASCII hyphens', () => {
    expect(gitBranchName('José  Núñez!', 'ENG-1', 'a')).toBe('jose-nunez/eng-1-a');
  });

  it('leaves out the name when it has no letters or digits', () => {
    expect(gitBranchName('日本', 'ENG-7', 'x')).toBe('eng-7-x');
    expect(gitBranchName('', 'ENG-7', 'x')).toBe('eng-7-x');
  });

  it('leaves out the slug when the title had none', () => {
    expect(gitBranchName('ada', 'ENG-42', '')).toBe('ada/eng-42');
  });

  it('cuts a long slug on a word boundary so the whole name is at most 60 characters', () => {
    const slug = 'this-is-a-rather-long-title-that-keeps-going-and-going-forever-and-ever';
    const name = gitBranchName('ada', 'ENG-42', slug);
    expect(name.length).toBeLessThanOrEqual(BRANCH_NAME_MAX);
    expect(name.startsWith('ada/eng-42-this-is-a-rather-long-title-that-keeps-going')).toBe(true);
    expect(name.endsWith('-')).toBe(false);
    expect(slug.startsWith(name.slice('ada/eng-42-'.length))).toBe(true);
    expect(`${slug}-`.startsWith(`${name.slice('ada/eng-42-'.length)}-`)).toBe(true);
  });

  it('cuts inside a word when the first word alone does not fit', () => {
    const name = gitBranchName('ada', 'ENG-42', 'x'.repeat(100));
    expect(name).toBe(`ada/eng-42-${'x'.repeat(BRANCH_NAME_MAX - 'ada/eng-42-'.length)}`);
  });

  it('cuts the prefix when the name alone is too long', () => {
    const name = gitBranchName('a'.repeat(80), 'ENG-42', 'title');
    expect(name.length).toBeLessThanOrEqual(BRANCH_NAME_MAX);
    expect(name).toBe('a'.repeat(BRANCH_NAME_MAX));
  });

  it('is stable for the same input', () => {
    expect(gitBranchName('Ada', 'ENG-42', 'fix-it')).toBe(gitBranchName('Ada', 'ENG-42', 'fix-it'));
  });
});

describe('foldToSlug', () => {
  it.each([
    ['Søren', 'soren'],
    ['Straße', 'strasse'],
    ['Æther Œuvre', 'aether-oeuvre'],
    ['Đorđe Łukasz', 'dorde-lukasz'],
    ['Þór', 'thor'],
    ['ØÆŒ', 'oaeoe'],
    ['Café  Crème!', 'cafe-creme'],
  ])('folds %s to %s', (input, expected) => {
    expect(foldToSlug(input)).toBe(expected);
  });

  it('gives an empty slug for text with no Latin letters or digits', () => {
    expect(foldToSlug('山田 太郎')).toBe('');
  });

  it('drops the name prefix for a non-Latin display name', () => {
    expect(gitBranchName('山田太郎', 'ENG-42', 'fix-it')).toBe('eng-42-fix-it');
  });
});
