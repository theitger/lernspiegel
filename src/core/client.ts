import { createWriteStream } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { Category, Course, Section, SiteInfo } from "./types.js";

interface MoodleError {
  exception?: string;
  errorcode?: string;
  message?: string;
  error?: string;
}

export class MoodleClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string
  ) {}

  static async login(baseUrl: string, username: string, password: string): Promise<string> {
    const body = new URLSearchParams({ username, password, service: "moodle_mobile_app" });
    const res = await fetch(`${baseUrl}/login/token.php`, { method: "POST", body });
    if (!res.ok) throw new Error(`Login endpoint returned HTTP ${res.status}`);
    const data = (await res.json()) as { token?: string } & MoodleError;
    if (!data.token) {
      throw new Error(data.error ?? data.message ?? "Login failed (no token returned)");
    }
    return data.token;
  }

  async call<T>(wsfunction: string, params: Record<string, string | number> = {}): Promise<T> {
    const body = new URLSearchParams({
      wstoken: this.token,
      wsfunction,
      moodlewsrestformat: "json",
    });
    for (const [key, value] of Object.entries(params)) body.set(key, String(value));

    const res = await fetch(`${this.baseUrl}/webservice/rest/server.php`, {
      method: "POST",
      body,
    });
    if (!res.ok) throw new Error(`${wsfunction}: HTTP ${res.status}`);
    const data = (await res.json()) as T & MoodleError;
    if (data && typeof data === "object" && "exception" in data) {
      if (data.errorcode === "invalidtoken") {
        throw new Error("Token is no longer valid. Run `learnweb login` to get a new one.");
      }
      throw new Error(`${wsfunction}: ${data.errorcode} — ${data.message}`);
    }
    return data;
  }

  getSiteInfo(): Promise<SiteInfo> {
    return this.call<SiteInfo>("core_webservice_get_site_info");
  }

  getCourses(userid: number): Promise<Course[]> {
    return this.call<Course[]>("core_enrol_get_users_courses", { userid });
  }

  getCourseContents(courseid: number): Promise<Section[]> {
    return this.call<Section[]>("core_course_get_contents", { courseid });
  }

  getCategories(): Promise<Category[]> {
    return this.call<Category[]>("core_course_get_categories", {});
  }

  /**
   * Downloads a webservice file. The token goes into the URL query — that URL
   * must never be logged or persisted; errors deliberately omit it.
   */
  async downloadFile(fileurl: string, dest: string): Promise<void> {
    const url = new URL(fileurl);
    url.searchParams.set("token", this.token);
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new Error(`download failed (HTTP ${res.status})`);
    }
    // Moodle reports download errors as HTTP 200 + JSON body — but legitimate
    // files can be JSON too (.ipynb!), so only the Moodle error shape counts.
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const buf = Buffer.from(await res.arrayBuffer());
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(buf.toString("utf8"));
      } catch {
        // not valid JSON after all — fall through and store the bytes
      }
      if (parsed && typeof parsed === "object" && ("exception" in parsed || "errorcode" in parsed)) {
        throw new Error(`download failed: ${(parsed as MoodleError).errorcode ?? "unknown error"}`);
      }
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, buf);
      return;
    }
    await mkdir(dirname(dest), { recursive: true });
    const tmp = dest + ".part";
    try {
      await pipeline(
        Readable.fromWeb(res.body as unknown as NodeReadableStream),
        createWriteStream(tmp)
      );
      await rename(tmp, dest);
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
  }
}
