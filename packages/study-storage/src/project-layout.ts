/**
 * 项目目录布局（《Electron 开发设计》第 4 节）。
 *
 * 用户选择的项目目录/
 * ├── project.json         格式版本、项目 ID 和显示名称
 * ├── .study/
 * │   ├── study.db         权威知识点、证据、作答、会话与收据
 * │   ├── sources/         不可变版本的原始/规范化材料
 * │   └── assets/          本地课堂图片、互动资源和可选音频
 * └── exports/             导出的 Markdown 与 JSON
 *
 * manifest 只承载身份与格式说明；目标、日期、计划和知识点等领域事实统一在数据库中维护。
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { StudyError } from '@sew/study-contracts';

export const PROJECT_FORMAT_VERSION = 1;

export interface ProjectManifest {
  formatVersion: number;
  projectId: string;
  displayName: string;
  createdAt: string;
}

export interface ProjectPaths {
  root: string;
  manifestFile: string;
  studyDir: string;
  databaseFile: string;
  sourcesDir: string;
  assetsDir: string;
  exportsDir: string;
}

export const projectPaths = (root: string): ProjectPaths => {
  const studyDir = join(root, '.study');
  return {
    root,
    manifestFile: join(root, 'project.json'),
    studyDir,
    databaseFile: join(studyDir, 'study.db'),
    sourcesDir: join(studyDir, 'sources'),
    assetsDir: join(studyDir, 'assets'),
    exportsDir: join(root, 'exports'),
  };
};

export const ensureProjectLayout = (root: string): ProjectPaths => {
  const paths = projectPaths(root);
  for (const dir of [paths.studyDir, paths.sourcesDir, paths.assetsDir, paths.exportsDir]) {
    // 项目目录由用户选择、路径在构建期不可知；忽略静态追踪，避免把整个工程打进 standalone。
    mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true });
  }
  return paths;
};

export const readManifest = (root: string): ProjectManifest | null => {
  const { manifestFile } = projectPaths(root);
  if (!existsSync(/* turbopackIgnore: true */ manifestFile)) return null;
  const parsed = JSON.parse(readFileSync(/* turbopackIgnore: true */ manifestFile, 'utf8')) as ProjectManifest;
  return parsed;
};

export const writeManifest = (root: string, manifest: ProjectManifest): void => {
  const { manifestFile } = projectPaths(root);
  writeFileSync(/* turbopackIgnore: true */ manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
};

export const isDirectory = (path: string): boolean => {
  try {
    return statSync(/* turbopackIgnore: true */ path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * 打开前校验格式版本。较新格式用明确错误说明，不能尝试降级覆盖。
 */
export const assertManifestCompatible = (manifest: ProjectManifest | null): void => {
  if (!manifest) return;
  if (manifest.formatVersion > PROJECT_FORMAT_VERSION) {
    throw new StudyError('PROJECT_FORMAT_UNSUPPORTED', {
      formatVersion: manifest.formatVersion,
      supported: PROJECT_FORMAT_VERSION,
    });
  }
};
