import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadSkills, extractFrontmatterDescription, discoverTargetRepoSkills } from '../../src/services/skill-loader.ts';

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

describe('extractFrontmatterDescription', () => {
  test('extracts quoted description from YAML frontmatter', () => {
    const content = `---
name: online-investigate
description: "Investigates mappings between AL and C#."
---

# Online Investigator
`;
    expect(extractFrontmatterDescription(content)).toBe('Investigates mappings between AL and C#.');
  });

  test('extracts unquoted description', () => {
    const content = `---
name: my-skill
description: A simple skill.
---

Body text.
`;
    expect(extractFrontmatterDescription(content)).toBe('A simple skill.');
  });

  test('returns empty string when no frontmatter', () => {
    expect(extractFrontmatterDescription('# Just a heading\nSome text.')).toBe('');
  });

  test('returns empty string when no description in frontmatter', () => {
    const content = `---
name: no-desc
---

Body.
`;
    expect(extractFrontmatterDescription(content)).toBe('');
  });

  test('returns empty string for empty content', () => {
    expect(extractFrontmatterDescription('')).toBe('');
  });
});

describe('discoverTargetRepoSkills', () => {
  test('returns empty array when .claude/skills does not exist', () => {
    const dir = makeTmpDir();
    expect(discoverTargetRepoSkills(dir)).toEqual([]);
  });

  test('returns empty array when .claude/skills has no subdirectories', () => {
    const dir = makeTmpDir();
    const skillsRoot = join(dir, '.claude', 'skills');
    mkdirSync(skillsRoot, { recursive: true });
    writeFileSync(join(skillsRoot, 'stray-file.md'), 'not a skill', 'utf-8');

    expect(discoverTargetRepoSkills(dir)).toEqual([]);
  });

  test('discovers skills with SKILL.md and valid frontmatter', () => {
    const dir = makeTmpDir();
    const skillDir = join(dir, '.claude', 'skills', 'online-investigate');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: online-investigate
description: "Investigates online mappings."
---

# Online Investigator
`,
      'utf-8',
    );

    const result = discoverTargetRepoSkills(dir);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('online-investigate');
    expect(result[0]!.description).toBe('Investigates online mappings.');
    expect(result[0]!.skillDir).toBe(skillDir);
  });

  test('skips subdirectories without SKILL.md', () => {
    const dir = makeTmpDir();
    const skillsRoot = join(dir, '.claude', 'skills');

    const goodDir = join(skillsRoot, 'good-skill');
    mkdirSync(goodDir, { recursive: true });
    writeFileSync(
      join(goodDir, 'SKILL.md'),
      '---\nname: good\ndescription: Good skill.\n---\n',
      'utf-8',
    );

    const badDir = join(skillsRoot, 'no-skill-md');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'README.md'), '# Not a skill', 'utf-8');

    const result = discoverTargetRepoSkills(dir);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('good-skill');
  });

  test('skips skills without description in frontmatter', () => {
    const dir = makeTmpDir();
    const skillDir = join(dir, '.claude', 'skills', 'no-desc');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: no-desc\n---\n# No description',
      'utf-8',
    );

    expect(discoverTargetRepoSkills(dir)).toEqual([]);
  });

  test('discovers multiple skills', () => {
    const dir = makeTmpDir();
    const skillsRoot = join(dir, '.claude', 'skills');

    for (const name of ['alpha', 'beta']) {
      const sDir = join(skillsRoot, name);
      mkdirSync(sDir, { recursive: true });
      writeFileSync(
        join(sDir, 'SKILL.md'),
        `---\nname: ${name}\ndescription: "${name} skill."\n---\n`,
        'utf-8',
      );
    }

    const result = discoverTargetRepoSkills(dir);
    expect(result).toHaveLength(2);
    const names = result.map((s) => s.name).sort();
    expect(names).toEqual(['alpha', 'beta']);
  });
});
