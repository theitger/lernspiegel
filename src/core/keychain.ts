import { execFileSync } from "node:child_process";

const SERVICE = "learnweb-cli";

export function saveToken(account: string, token: string): void {
  execFileSync(
    "security",
    ["add-generic-password", "-U", "-s", SERVICE, "-a", account, "-w", token],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
}

export function getToken(): string | null {
  try {
    return execFileSync("security", ["find-generic-password", "-s", SERVICE, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function deleteToken(): void {
  try {
    execFileSync("security", ["delete-generic-password", "-s", SERVICE], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // not present — fine
  }
}
