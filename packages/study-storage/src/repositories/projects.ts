/**
 * 项目生命周期（repository）。
 *
 * 只处理 projects 表；不感知材料、候选或题目。
 */

import { StudyError } from '@sew/study-contracts';
import type { SqlDatabase } from '../driver';
import { mapProject, type ProjectRow, type Row } from './types';

export interface CreateProjectInput {
  projectId: string;
  displayName: string;
  subject?: string;
  goal?: string;
  examDate?: string | null;
  dailyMinutes?: number;
  learningMode?: 'beginner' | 'review';
}

export type ProjectSettingsPatch = Partial<{
  displayName: string;
  subject: string;
  goal: string;
  examDate: string | null;
  dailyMinutes: number;
  learningMode: 'beginner' | 'review';
}>;

export class ProjectsRepository {
  constructor(private readonly db: SqlDatabase) {}

  createProject(input: CreateProjectInput): ProjectRow {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO projects (project_id, display_name, subject, goal, exam_date, daily_minutes, learning_mode, format_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        input.projectId,
        input.displayName,
        input.subject ?? '',
        input.goal ?? '',
        input.examDate ?? null,
        input.dailyMinutes ?? 0,
        input.learningMode ?? 'beginner',
        now,
        now,
      );
    const project = this.getProject(input.projectId);
    if (!project) throw new StudyError('INTERNAL', { projectId: input.projectId });
    return project;
  }

  getProject(projectId: string): ProjectRow | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId) as
      | Row
      | undefined;
    return row ? mapProject(row) : null;
  }

  listProjects(): ProjectRow[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as Row[]).map(
      mapProject,
    );
  }

  updateProjectSettings(projectId: string, patch: ProjectSettingsPatch): ProjectRow {
    const current = this.getProject(projectId);
    if (!current) throw new StudyError('NOT_FOUND', { projectId });
    this.db
      .prepare(
        `UPDATE projects SET display_name = ?, subject = ?, goal = ?, exam_date = ?, daily_minutes = ?, learning_mode = ?, updated_at = ?
         WHERE project_id = ?`,
      )
      .run(
        patch.displayName ?? current.displayName,
        patch.subject ?? current.subject,
        patch.goal ?? current.goal,
        patch.examDate === undefined ? current.examDate : patch.examDate,
        patch.dailyMinutes ?? current.dailyMinutes,
        patch.learningMode ?? current.learningMode,
        new Date().toISOString(),
        projectId,
      );
    const updated = this.getProject(projectId);
    if (!updated) throw new StudyError('NOT_FOUND', { projectId });
    return updated;
  }
}
