import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  baseUrl: string;
  username: string;
  mirror: string;
  excludeCourses?: number[];
  /** always synced even when the semester filter would drop them */
  includeCourses?: number[];
}

export const DEFAULT_BASE_URL = "https://www.uni-muenster.de/LearnWeb/learnweb2";
export const DEFAULT_MIRROR = join(homedir(), "Learnweb");

const CONFIG_DIR = join(homedir(), ".config", "learnweb");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export function loadConfig(): Config | null {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Config;
  } catch {
    return null;
  }
}

export function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
}
