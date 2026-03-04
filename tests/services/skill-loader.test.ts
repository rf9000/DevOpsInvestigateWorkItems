import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadSkills } from '../../src/services/skill-loader.ts';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'skill-loader-test-'));
}

describe('loadSkills', () => {
  test('returns empty array for non-existent directory', async () => {
    const skills = await loadSkills('/nonexistent/path/to/skills');
    expect(skills).toEqual([]);
  });

  test('returns empty array for directory with no .md files', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'notes.txt'), 'not a skill', 'utf-8');
    writeFileSync(join(dir, 'config.json'), '{}', 'utf-8');

    const skills = await loadSkills(dir);
    expect(skills).toEqual([]);
  });

  test('loads all .md files from directory', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'coding-standards.md'), 'Use strict mode.', 'utf-8');
    writeFileSync(join(dir, 'testing.md'), 'Write unit tests.', 'utf-8');

    const skills = await loadSkills(dir);

    expect(skills.length).toBe(2);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(['coding-standards', 'testing']);

    const codingSkill = skills.find((s) => s.name === 'coding-standards')!;
    expect(codingSkill.content).toBe('Use strict mode.');

    const testingSkill = skills.find((s) => s.name === 'testing')!;
    expect(testingSkill.content).toBe('Write unit tests.');
  });

  test('ignores non-.md files in directory', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'skill.md'), 'A skill.', 'utf-8');
    writeFileSync(join(dir, 'notes.txt'), 'Not a skill.', 'utf-8');

    const skills = await loadSkills(dir);

    expect(skills.length).toBe(1);
    expect(skills[0]!.name).toBe('skill');
  });

  test('strips .md extension from name', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'my-awesome-skill.md'), 'content', 'utf-8');

    const skills = await loadSkills(dir);

    expect(skills[0]!.name).toBe('my-awesome-skill');
  });
});
