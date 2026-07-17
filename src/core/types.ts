export interface SiteInfo {
  sitename: string;
  username: string;
  fullname: string;
  userid: number;
  release?: string;
}

export interface Course {
  id: number;
  shortname: string;
  fullname: string;
  category?: number;
  startdate?: number;
  enddate?: number;
  lastaccess?: number;
  hidden?: boolean;
}

export interface Category {
  id: number;
  name: string;
  parent: number;
  path: string;
}

export interface ModuleContent {
  type: string;
  filename: string;
  filepath: string | null;
  filesize: number;
  fileurl?: string;
  timemodified?: number;
}

export interface Module {
  id: number;
  name: string;
  modname: string;
  url?: string;
  contents?: ModuleContent[];
}

export interface Section {
  id: number;
  name: string;
  section?: number;
  modules: Module[];
}

/** Resolves each category id to its readable path, e.g. "Fachbereich 4 / Archiv FB 4". */
export function buildCategoryPaths(categories: Category[]): Map<number, string> {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const paths = new Map<number, string>();
  for (const cat of categories) {
    const names = cat.path
      .split("/")
      .filter(Boolean)
      .map((id) => byId.get(Number(id))?.name ?? "?");
    paths.set(cat.id, names.join(" / "));
  }
  return paths;
}

/** Lecturers set up semester courses at most ~3 months before term start. */
const SEMESTER_SETUP_GRACE_SECONDS = 90 * 86400;

/** German semesters: SoSe = Apr–Sep, WiSe = Oct–Mar. */
export function currentSemesterStart(nowSeconds: number): number {
  const d = new Date(nowSeconds * 1000);
  const month = d.getMonth() + 1;
  const year = d.getFullYear();
  if (month >= 4 && month <= 9) return Date.UTC(year, 3, 1) / 1000;
  return Date.UTC(month >= 10 ? year : year - 1, 9, 1) / 1000;
}

/**
 * Current = not filed in an "Archiv …" category AND created for this semester
 * (start date no earlier than the setup grace before term start). Standing
 * courses (coordination, Fachschaft, …) carry years-old start dates and are
 * skipped by default — force them in via `include`.
 */
export function isCurrentCourse(
  course: Course,
  categoryPaths: Map<number, string>,
  nowSeconds: number
): boolean {
  const path = course.category != null ? categoryPaths.get(course.category) : undefined;
  if (path && /archiv/i.test(path)) return false;
  if (!course.startdate) return false;
  return course.startdate >= currentSemesterStart(nowSeconds) - SEMESTER_SETUP_GRACE_SECONDS;
}
