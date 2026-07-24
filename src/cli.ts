#!/usr/bin/env node
import { Command } from "commander";
import { MoodleClient } from "./core/client.js";
import { buildCategoryPaths, isCurrentCourse } from "./core/types.js";
import { loadConfig, saveConfig, DEFAULT_BASE_URL, DEFAULT_MIRROR } from "./core/config.js";
import { saveToken, getToken, deleteToken } from "./core/keychain.js";
import { loadManifest, loadCourseIndex } from "./sync/manifest.js";
import { syncCourses, fmtSize } from "./sync/sync.js";
import { createInterface } from "node:readline/promises";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode?.(true);
    stdin.resume();
    let value = "";
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n" || char === "\u0004") {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          process.stdout.write("\n");
          process.exit(130);
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on("data", onData);
  });
}

function renderProgress(p: {
  done: number;
  total: number;
  bytesDone: number;
  bytesTotal: number;
  file: string;
}): void {
  const width = 24;
  const filled = p.total ? Math.round((p.done / p.total) * width) : width;
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  const cols = process.stdout.columns ?? 100;
  const line = `${bar} ${p.done}/${p.total} · ${fmtSize(p.bytesDone)}/${fmtSize(p.bytesTotal)} · ${p.file}`;
  process.stdout.write("\r" + line.slice(0, cols - 1).padEnd(cols - 1));
}

function requireAuth(): { client: MoodleClient; mirror: string } {
  const config = loadConfig();
  const token = getToken();
  if (!config || !token) {
    console.error("Not logged in. Run `learnweb login` first.");
    process.exit(1);
  }
  return { client: new MoodleClient(config.baseUrl, token), mirror: config.mirror };
}

/** Resolves ids, shortnames or name fragments to course ids. */
async function resolveCourseIds(client: MoodleClient, args: string[]): Promise<number[]> {
  const site = await client.getSiteInfo();
  const courses = await client.getCourses(site.userid);
  const ids: number[] = [];
  for (const arg of args) {
    if (/^\d+$/.test(arg)) {
      ids.push(Number(arg));
      continue;
    }
    const q = arg.toLowerCase();
    const exact = courses.filter((c) => c.shortname.toLowerCase() === q);
    const hits = exact.length
      ? exact
      : courses.filter(
          (c) => c.shortname.toLowerCase().includes(q) || c.fullname.toLowerCase().includes(q)
        );
    if (hits.length === 1) ids.push(hits[0].id);
    else if (hits.length === 0)
      throw new Error(`No course matches "${arg}" (see \`learnweb courses\`).`);
    else
      throw new Error(
        `"${arg}" is ambiguous: ${hits.map((c) => `${c.id} (${c.shortname})`).join(", ")}`
      );
  }
  return ids;
}

const program = new Command();
program
  .name("learnweb")
  .description("Mirrors Uni Münster Learnweb (Moodle) courses to local files")
  .version(version);

program
  .command("login")
  .description("Log in: obtains an API token and stores it in the macOS keychain")
  .option("--url <baseUrl>", "Moodle base URL", DEFAULT_BASE_URL)
  .option("--user <username>", "university username")
  .option("--token <token>", "use an existing web service token directly")
  .option("--mirror <dir>", "target directory for the mirror", DEFAULT_MIRROR)
  .action(async (opts: { url: string; user?: string; token?: string; mirror: string }) => {
    let username = opts.user;
    let token = opts.token;
    if (!token) {
      if (!username) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        username = (await rl.question("University username: ")).trim();
        rl.close();
      }
      const password = await promptHidden("Password (stays local, never stored): ");
      token = await MoodleClient.login(opts.url, username, password);
    }
    const client = new MoodleClient(opts.url, token);
    const site = await client.getSiteInfo();
    saveToken(site.username, token);
    saveConfig({ baseUrl: opts.url, username: site.username, mirror: opts.mirror });
    console.log(`Logged in as ${site.fullname} (${site.username}) @ ${site.sitename}`);
    console.log("Token stored in the macOS keychain (service: learnweb-cli).");
  });

program
  .command("logout")
  .description("Delete the token from the keychain")
  .action(() => {
    deleteToken();
    console.log("Token deleted.");
  });

program
  .command("courses")
  .description("List enrolled courses")
  .option("--json", "JSON output")
  .action(async (opts: { json?: boolean }) => {
    const { client } = requireAuth();
    const site = await client.getSiteInfo();
    const courses = await client.getCourses(site.userid);
    if (opts.json) {
      console.log(JSON.stringify(courses, null, 2));
      return;
    }
    const config = loadConfig();
    const excluded = new Set(config?.excludeCourses ?? []);
    const forced = new Set(config?.includeCourses ?? []);
    let categoryPaths = new Map<number, string>();
    try {
      categoryPaths = buildCategoryPaths(await client.getCategories());
    } catch {
      console.error("warning: course categories unreadable — everything counts as current");
    }
    const now = Date.now() / 1000;
    for (const c of courses) {
      const flag = excluded.has(c.id)
        ? "excluded"
        : forced.has(c.id)
          ? "forced"
          : isCurrentCourse(c, categoryPaths, now)
            ? "current"
            : "old";
      const where = categoryPaths.get(c.category ?? -1) ?? "";
      console.log(`${String(c.id).padStart(6)}  [${flag.padEnd(8)}]  ${c.shortname}  —  ${where}`);
    }
  });

program
  .command("exclude")
  .description("Permanently exclude courses from syncing")
  .argument("<courses...>", "id, shortname or name fragment (see `learnweb courses`)")
  .action(async (courseArgs: string[]) => {
    const { client } = requireAuth();
    const config = loadConfig()!;
    const excluded = new Set(config.excludeCourses ?? []);
    const forced = new Set(config.includeCourses ?? []);
    for (const id of await resolveCourseIds(client, courseArgs)) {
      excluded.add(id);
      forced.delete(id);
    }
    saveConfig({
      ...config,
      excludeCourses: [...excluded].sort((a, b) => a - b),
      includeCourses: [...forced].sort((a, b) => a - b),
    });
    console.log(`Excluded: ${[...excluded].join(", ")}`);
  });

program
  .command("include")
  .description("Always sync these courses, even when the semester filter would skip them")
  .argument("<courses...>", "id, shortname or name fragment")
  .action(async (courseArgs: string[]) => {
    const { client } = requireAuth();
    const config = loadConfig()!;
    const excluded = new Set(config.excludeCourses ?? []);
    const forced = new Set(config.includeCourses ?? []);
    for (const id of await resolveCourseIds(client, courseArgs)) {
      forced.add(id);
      excluded.delete(id);
    }
    saveConfig({
      ...config,
      excludeCourses: [...excluded].sort((a, b) => a - b),
      includeCourses: [...forced].sort((a, b) => a - b),
    });
    console.log(`Always included: ${[...forced].join(", ")}`);
  });

program
  .command("sync")
  .description("Mirror course materials locally (incremental)")
  .argument("[courses...]", "only sync these courses (id, shortname or name fragment)")
  .option("--all", "sync every enrolled course (default: current semester only)")
  .option("--dry-run", "only show what would be downloaded")
  .option("--max-size <mb>", "skip files above this size", "200")
  .option("--json", "print the result as JSON")
  .action(
    async (
      courseArgs: string[],
      opts: { all?: boolean; dryRun?: boolean; maxSize: string; json?: boolean }
    ) => {
      const { client, mirror } = requireAuth();
      const config = loadConfig();
      const useBar = !opts.json && !opts.dryRun && process.stdout.isTTY;
      const result = await syncCourses(client, {
        mirror,
        courseIds: courseArgs.length ? await resolveCourseIds(client, courseArgs) : undefined,
        all: opts.all,
        excludeCourses: config?.excludeCourses,
        includeCourses: config?.includeCourses,
        dryRun: opts.dryRun,
        maxSizeMb: Number(opts.maxSize),
        log: opts.json ? undefined : (line) => console.log(line),
        onProgress: useBar ? renderProgress : undefined,
      });
      if (useBar && result.downloaded + result.errors.length > 0) process.stdout.write("\n");
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else if (!opts.dryRun) {
        if (result.downloaded === 0 && result.errors.length === 0 && result.tooLarge === 0) {
          console.log(`Nothing to sync — everything up to date (${result.skipped} files checked).`);
        } else {
          console.log(
            `Done: ${result.downloaded} downloaded (${fmtSize(result.bytes)}), ` +
              `${result.skipped} up to date, ${result.tooLarge} over the size limit, ` +
              `${result.errors.length} errors`
          );
        }
        for (const err of result.errors) console.error(`  error: ${err}`);
      }
      if (result.errors.length) process.exitCode = 1;
    }
  );

program
  .command("status")
  .description("Show the state of the local mirror")
  .option("--json", "JSON output")
  .action((opts: { json?: boolean }) => {
    const config = loadConfig();
    if (!config) {
      console.error("Not configured. Run `learnweb login` first.");
      process.exit(1);
    }
    const manifest = loadManifest(config.mirror);
    const courses = loadCourseIndex(config.mirror);
    const info = {
      mirror: config.mirror,
      lastSync: manifest.lastSync,
      courses: courses.length,
      files: Object.keys(manifest.files).length,
    };
    if (opts.json) console.log(JSON.stringify(info, null, 2));
    else {
      console.log(`Mirror:     ${info.mirror}`);
      console.log(`Last sync:  ${info.lastSync ?? "never"}`);
      console.log(`Courses:    ${info.courses}`);
      console.log(`Files:      ${info.files}`);
    }
  });

program.parseAsync().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
