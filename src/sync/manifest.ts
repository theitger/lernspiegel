import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface ManifestEntry {
  path: string;
  courseId: number;
  courseShortname: string;
  filesize: number;
  timemodified: number;
}

export interface Manifest {
  lastSync: string | null;
  files: Record<string, ManifestEntry>;
}

export interface CourseIndexEntry {
  id: number;
  shortname: string;
  fullname: string;
  path: string;
}

const META_DIR = ".learnweb";

export function loadManifest(mirror: string): Manifest {
  try {
    return JSON.parse(readFileSync(join(mirror, META_DIR, "manifest.json"), "utf8")) as Manifest;
  } catch {
    return { lastSync: null, files: {} };
  }
}

export function saveManifest(mirror: string, manifest: Manifest): void {
  mkdirSync(join(mirror, META_DIR), { recursive: true });
  writeFileSync(join(mirror, META_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
}

export function loadCourseIndex(mirror: string): CourseIndexEntry[] {
  try {
    return JSON.parse(readFileSync(join(mirror, META_DIR, "courses.json"), "utf8")) as CourseIndexEntry[];
  } catch {
    return [];
  }
}

export function saveCourseIndex(mirror: string, courses: CourseIndexEntry[]): void {
  mkdirSync(join(mirror, META_DIR), { recursive: true });
  writeFileSync(join(mirror, META_DIR, "courses.json"), JSON.stringify(courses, null, 2));
}
