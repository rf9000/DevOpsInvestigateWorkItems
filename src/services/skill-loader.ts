import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, basename, extname } from 'path';
import type { Skill } from '../types/index.ts';

export async function loadSkills(skillsDir: string): Promise<Skill[]> {
  if (!existsSync(skillsDir)) {
    return [];
  }

  const files = readdirSync(skillsDir).filter(
    (f) => extname(f).toLowerCase() === '.md',
  );

  const skills: Skill[] = [];
  for (const file of files) {
    const filePath = join(skillsDir, file);
    const content = readFileSync(filePath, 'utf-8');
    const name = basename(file, '.md');
    skills.push({ name, content });
  }

  return skills;
}
