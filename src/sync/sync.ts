import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { MoodleClient } from "../core/client.js";
import { buildCategoryPaths, isCurrentCourse, type Course } from "../core/types.js";
import {
  loadManifest,
  saveManifest,
  saveCourseIndex,
  type Manifest,
  type CourseIndexEntry,
} from "./manifest.js";

export interface SyncOptions {
  mirror: string;
  courseIds?: number[];
  /** sync ended courses too (default: only current ones) */
  all?: boolean;
  excludeCourses?: number[];
  includeCourses?: number[];
  dryRun?: boolean;
  maxSizeMb?: number;
  concurrency?: number;
  log?: (line: string) => void;
  /** When set, replaces the per-file download log lines (e.g. to render a progress bar). */
  onProgress?: (p: {
    done: number;
    total: number;
    bytesDone: number;
    bytesTotal: number;
    file: string;
  }) => void;
}

export interface SyncResult {
  downloaded: number;
  skipped: number;
  tooLarge: number;
  bytes: number;
  errors: string[];
}

export function fmtSize(bytes: number): string {
  if (bytes <= 0) return "0 KB";
  if (bytes >= 2 ** 30) return (bytes / 2 ** 30).toFixed(1) + " GB";
  if (bytes >= 2 ** 20) return (bytes / 2 ** 20).toFixed(1) + " MB";
  return Math.max(1, Math.round(bytes / 1024)) + " KB";
}

interface DownloadJob {
  key: string;
  fileurl: string;
  dest: string;
  relPath: string;
  filesize: number;
  timemodified: number;
  course: Course;
}

/** Makes a string safe as a single path segment. */
function sanitize(segment: string): string {
  const cleaned = segment
    .replace(/[/\\:*?"<>|\x00-\x1f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 120)
    .trim();
  return cleaned || "untitled";
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function syncCourses(client: MoodleClient, opts: SyncOptions): Promise<SyncResult> {
  const log = opts.log ?? (() => {});
  const maxBytes = (opts.maxSizeMb ?? 200) * 1024 * 1024;
  const manifest: Manifest = loadManifest(opts.mirror);
  const result: SyncResult = { downloaded: 0, skipped: 0, tooLarge: 0, bytes: 0, errors: [] };

  const site = await client.getSiteInfo();
  let courses = await client.getCourses(site.userid);
  const total = courses.length;
  if (opts.courseIds?.length) {
    // explicitly named courses bypass the semester filter and exclude list
    courses = courses.filter((c) => opts.courseIds!.includes(c.id));
  } else {
    if (!opts.all) {
      let categoryPaths = new Map<number, string>();
      try {
        categoryPaths = buildCategoryPaths(await client.getCategories());
      } catch {
        log("warning: course categories unreadable — archive detection inactive");
      }
      const now = Date.now() / 1000;
      courses = courses.filter(
        (c) => isCurrentCourse(c, categoryPaths, now) || opts.includeCourses?.includes(c.id)
      );
    }
    if (opts.excludeCourses?.length) {
      courses = courses.filter((c) => !opts.excludeCourses!.includes(c.id));
    }
  }
  log(
    `syncing ${courses.length} of ${total} enrolled courses${opts.all ? "" : " (current semester only; --all for everything)"}`
  );

  const courseIndex: CourseIndexEntry[] = [];
  const jobs: DownloadJob[] = [];

  for (const course of courses) {
    const courseDir = sanitize(course.shortname);
    courseIndex.push({
      id: course.id,
      shortname: course.shortname,
      fullname: course.fullname,
      path: join(opts.mirror, courseDir),
    });

    let sections;
    try {
      sections = await client.getCourseContents(course.id);
    } catch (e) {
      result.errors.push(`${course.shortname}: ${(e as Error).message}`);
      continue;
    }

    const links: string[] = [];
    for (const [i, section] of sections.entries()) {
      const sectionDir = sanitize(section.name || `Section ${section.section ?? i}`);
      for (const mod of section.modules) {
        if (mod.modname === "url" && mod.url) {
          links.push(`- [${mod.name}](${mod.url}) _(${section.name})_`);
          continue;
        }
        for (const content of mod.contents ?? []) {
          if (content.type !== "file" || !content.fileurl) continue;
          const subPath = (content.filepath ?? "/")
            .split("/")
            .filter(Boolean)
            .map(sanitize);
          const dest = join(
            opts.mirror,
            courseDir,
            sectionDir,
            sanitize(mod.name),
            ...subPath,
            sanitize(content.filename)
          );
          const key = `${course.id}:${mod.id}:${content.filepath ?? "/"}${content.filename}`;
          const known = manifest.files[key];
          if (
            known &&
            known.timemodified === (content.timemodified ?? 0) &&
            known.filesize === content.filesize &&
            existsSync(known.path)
          ) {
            result.skipped++;
            continue;
          }
          if (content.filesize > maxBytes) {
            result.tooLarge++;
            log(`  skipped (>${opts.maxSizeMb ?? 200} MB): ${content.filename}`);
            continue;
          }
          jobs.push({
            key,
            fileurl: content.fileurl,
            dest,
            relPath: `${courseDir}/${sectionDir}/${content.filename}`,
            filesize: content.filesize,
            timemodified: content.timemodified ?? 0,
            course,
          });
        }
      }
    }

    if (links.length && !opts.dryRun) {
      mkdirSync(join(opts.mirror, courseDir), { recursive: true });
      writeFileSync(join(opts.mirror, courseDir, "_links.md"), links.join("\n") + "\n");
    }
  }

  if (opts.dryRun) {
    let planned = 0;
    for (const job of jobs) {
      planned += job.filesize;
      log(`would download: ${job.relPath} (${fmtSize(job.filesize)})`);
    }
    if (jobs.length === 0 && result.tooLarge === 0) {
      log(`Nothing to sync — everything up to date (${result.skipped} files checked).`);
    } else {
      log(
        `dry run: ${jobs.length} files would be downloaded (${fmtSize(planned)} total), ` +
          `${result.skipped} up to date, ${result.tooLarge} over the size limit`
      );
    }
    return { ...result, downloaded: jobs.length, bytes: planned };
  }

  const bytesTotal = jobs.reduce((sum, job) => sum + job.filesize, 0);
  let done = 0;
  await pool(jobs, opts.concurrency ?? 3, async (job) => {
    try {
      await client.downloadFile(job.fileurl, job.dest);
      manifest.files[job.key] = {
        path: job.dest,
        courseId: job.course.id,
        courseShortname: job.course.shortname,
        filesize: job.filesize,
        timemodified: job.timemodified,
      };
      result.downloaded++;
      result.bytes += job.filesize;
      if (!opts.onProgress) log(`  downloaded: ${job.relPath} (${fmtSize(job.filesize)})`);
    } catch (e) {
      result.errors.push(`${job.relPath}: ${(e as Error).message}`);
    } finally {
      done++;
      opts.onProgress?.({
        done,
        total: jobs.length,
        bytesDone: result.bytes,
        bytesTotal,
        file: job.relPath.split("/").pop() ?? job.relPath,
      });
    }
  });

  manifest.lastSync = new Date().toISOString();
  saveManifest(opts.mirror, manifest);
  saveCourseIndex(opts.mirror, courseIndex);
  return result;
}
