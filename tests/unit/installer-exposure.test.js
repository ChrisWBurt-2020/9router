import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, "../../scripts/install-linux-desktop.sh");

function printBind(expose) {
  const args = [SCRIPT, "--print-bind"];
  if (expose) args.push("--expose", expose);
  return execFileSync("bash", args, { encoding: "utf8" }).trim();
}

describe("Linux installer exposure default", () => {
  it("defaults to loopback-only binding", () => {
    expect(printBind()).toBe("127.0.0.1");
  });

  it("binds 0.0.0.0 only when explicitly choosing LAN", () => {
    expect(printBind("lan")).toBe("0.0.0.0");
  });

  it("rejects unknown exposure modes", () => {
    const r = spawnSync("bash", [SCRIPT, "--print-bind", "--expose", "internet"]);
    expect(r.status).not.toBe(0);
  });

  it("tailnet mode requires a resolvable Tailscale IP (fails without tailscale)", () => {
    const r = spawnSync("bash", [SCRIPT, "--print-bind", "--expose", "tailnet"]);
    // Either tailscale resolved a bind, or the mode correctly errors out —
    // it must never silently fall back to 0.0.0.0.
    const out = r.stdout?.toString().trim() || "";
    if (out) {
      expect(out).not.toBe("0.0.0.0");
      expect(out).not.toBe("127.0.0.1");
    } else {
      expect(r.status).not.toBe(0);
    }
  });
});
