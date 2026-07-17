#!/usr/bin/env node
/**
 * MCP server over the local Learnweb mirror. Deliberately token-free:
 * it only reads files that `learnweb sync` has already downloaded, so
 * agents get course data without ever touching credentials.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "./core/config.js";
import { loadManifest, loadCourseIndex } from "./sync/manifest.js";

const execFileAsync = promisify(execFile);

function text(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function mirrorOrError(): string | null {
  return loadConfig()?.mirror ?? null;
}

const NOT_SYNCED = {
  error: "No local mirror found. Run `learnweb login` and `learnweb sync` in a terminal first.",
};

const server = new McpServer({ name: "learnweb", version: "0.1.0" });

server.registerTool(
  "list_courses",
  {
    description:
      "Lists all mirrored Learnweb courses with their local directory paths. Read course files directly from these paths with normal file tools.",
  },
  async () => {
    const mirror = mirrorOrError();
    if (!mirror) return text(NOT_SYNCED);
    const courses = loadCourseIndex(mirror);
    return text(courses.length ? courses : NOT_SYNCED);
  }
);

server.registerTool(
  "search_materials",
  {
    description:
      "Searches mirrored course materials by filename/path substring (case-insensitive). Returns absolute local paths to read directly.",
    inputSchema: { query: z.string().describe("substring to match against file paths") },
  },
  async ({ query }) => {
    const mirror = mirrorOrError();
    if (!mirror) return text(NOT_SYNCED);
    const manifest = loadManifest(mirror);
    const q = query.toLowerCase();
    const hits = Object.values(manifest.files)
      .filter((f) => f.path.toLowerCase().includes(q))
      .map((f) => ({ path: f.path, course: f.courseShortname, sizeKb: Math.round(f.filesize / 1024) }))
      .slice(0, 100);
    return text(hits);
  }
);

server.registerTool(
  "list_materials",
  {
    description:
      "Lists all mirrored files of one course (by course id, shortname or name fragment).",
    inputSchema: { course: z.string().describe("course id, shortname or name fragment") },
  },
  async ({ course }) => {
    const mirror = mirrorOrError();
    if (!mirror) return text(NOT_SYNCED);
    const manifest = loadManifest(mirror);
    const q = course.toLowerCase();
    const files = Object.values(manifest.files);
    let hits = files.filter(
      (f) => String(f.courseId) === q || f.courseShortname.toLowerCase() === q
    );
    if (!hits.length) hits = files.filter((f) => f.courseShortname.toLowerCase().includes(q));
    return text(hits.map((f) => ({ path: f.path, sizeKb: Math.round(f.filesize / 1024) })));
  }
);

server.registerTool(
  "sync_status",
  { description: "Shows when the mirror was last synced and how many files it holds." },
  async () => {
    const mirror = mirrorOrError();
    if (!mirror) return text(NOT_SYNCED);
    const manifest = loadManifest(mirror);
    return text({
      mirror,
      lastSync: manifest.lastSync,
      files: Object.keys(manifest.files).length,
    });
  }
);

server.registerTool(
  "sync_now",
  {
    description:
      "Triggers a fresh sync by running the learnweb CLI as a subprocess (the CLI holds the credentials, this server does not). May take a while.",
  },
  async () => {
    const cliPath = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
    try {
      const { stdout } = await execFileAsync(process.execPath, [cliPath, "sync", "--json"], {
        timeout: 10 * 60 * 1000,
      });
      return text(JSON.parse(stdout));
    } catch (e) {
      return text({ error: `Sync failed: ${(e as Error).message}` });
    }
  }
);

await server.connect(new StdioServerTransport());
