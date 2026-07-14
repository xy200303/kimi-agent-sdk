import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { ProtocolClient, type InitializeResult, type KimiConfig } from "@moonshot-ai/kimi-agent-sdk";
import type { CLICheckResult } from "shared/types";

const execAsync = promisify(execFile);

const MIN_CLI_VERSION = "0.82";
const MIN_WIRE_VERSION = "1.1";

let instance: CLIManager;

function errorText(err: unknown): string {
  const stderr = textFromErrorField(err, "stderr");
  const stdout = textFromErrorField(err, "stdout");
  const message = err instanceof Error ? err.message : String(err);
  return stderr || stdout || message;
}

function textFromErrorField(err: unknown, field: "stdout" | "stderr"): string {
  const value = (err as { stdout?: unknown; stderr?: unknown } | null)?.[field];
  if (!value) {
    return "";
  }
  return Buffer.isBuffer(value) ? value.toString().trim() : String(value).trim();
}

export const initCLIManager = (ctx: vscode.ExtensionContext) => (instance = new CLIManager(ctx));
export const getCLIManager = () => {
  if (!instance) {
    throw new Error("CLI not init");
  }
  return instance;
};

export function compareVersion(a: string, b: string): number {
  const v1 = a.split(".").map(Number);
  const v2 = b.split(".").map(Number);
  for (let i = 0; i < Math.max(v1.length, v2.length); i++) {
    const diff = (v1[i] || 0) - (v2[i] || 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

export class CLIManager {
  private acpConfig: KimiConfig | null = null;
  private acpAuthenticated = false;

  constructor(_ctx: vscode.ExtensionContext) {}

  getExecutablePath(): string {
    const custom = this.getCustomPath();
    if (custom) {
      return custom;
    }

    return this.findInstalledCLI() ?? "";
  }

  getAcpConfig(): KimiConfig | null {
    return this.acpConfig;
  }

  isAcpAuthenticated(): boolean {
    return this.acpAuthenticated;
  }

  async checkInstalled(workDir: string): Promise<CLICheckResult> {
    const resolved = { isCustomPath: this.isCustomPath(), path: this.getExecutablePath() };
    if (!resolved.path) {
      return {
        ok: false,
        resolved,
        error: {
          type: "not_found",
          message: "Kimi Code CLI was not found. Install it and ensure its directory is on PATH, or set kimi.executablePath.",
        },
      };
    }

    return this.verify(workDir, resolved);
  }

  private getCustomPath(): string {
    return vscode.workspace.getConfiguration("kimi").get<string>("executablePath", "").trim();
  }

  private isCustomPath(): boolean {
    return !!this.getCustomPath();
  }

  private findInstalledCLI(): string | undefined {
    const executable = process.platform === "win32" ? "kimi.exe" : "kimi";
    const pathEntries = process.env.PATH?.split(path.delimiter) ?? [];
    const home = process.env.HOME ?? process.env.USERPROFILE;
    const fallbackDirectories = home
      ? process.platform === "win32"
        ? [path.join(home, ".kimi-code", "bin")]
        : [path.join(home, ".local", "bin"), path.join(home, ".kimi-code", "bin")]
      : [];

    for (const directory of [...pathEntries, ...fallbackDirectories]) {
      const candidate = path.join(directory.replace(/^"|"$/g, ""), executable);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return undefined;
  }

  private async verify(workDir: string, resolved: { isCustomPath: boolean; path: string }): Promise<CLICheckResult> {
    const execPath = resolved.path;
    let wireVersionTooLow = false;

    try {
      const info = await this.getInfo(execPath);
      if (compareVersion(info.kimi_cli_version, MIN_CLI_VERSION) < 0) {
        console.error(`CLI version too low: ${info.kimi_cli_version} < ${MIN_CLI_VERSION}`);
        return { ok: false, resolved, error: { type: "version_low", message: `CLI ${info.kimi_cli_version} < ${MIN_CLI_VERSION}` } };
      }
      if (compareVersion(info.wire_protocol_version, MIN_WIRE_VERSION) < 0) {
        console.error(`Wire protocol version too low: ${info.wire_protocol_version} < ${MIN_WIRE_VERSION}`);
        // The CLI may still expose ACP even though the legacy Wire version is
        // old. Let ProtocolClient.start negotiate ACP instead of failing here.
        wireVersionTooLow = true;
      }
    } catch (err) {
      console.log("CLI does not support the legacy info command; trying ACP handshake", err);
    }

    try {
      const initResult = await this.verifyWire(execPath, workDir);
      return { ok: true, resolved, slashCommands: initResult.slash_commands };
    } catch (err) {
      console.error("Error verifying protocol:", err);
      if (wireVersionTooLow) {
        return { ok: false, resolved, error: { type: "version_low", message: `Wire ${MIN_WIRE_VERSION}+ or ACP required` } };
      }
      return { ok: false, resolved, error: { type: "protocol_error", message: errorText(err) } };
    }
  }

  private async getInfo(execPath: string): Promise<{ kimi_cli_version: string; wire_protocol_version: string }> {
    const { stdout } = await execAsync(execPath, ["info", "--json"]);
    return JSON.parse(stdout);
  }

  private async verifyWire(execPath: string, workDir: string): Promise<InitializeResult> {
    const client = new ProtocolClient();
    try {
      const initialized = await client.start({ sessionId: undefined, workDir, executablePath: execPath });
      const acpConfig = client.acpSessionConfig;
      if (acpConfig) {
        this.acpAuthenticated = true;
        this.acpConfig = toKimiConfig(acpConfig);
      } else {
        this.acpAuthenticated = false;
        this.acpConfig = null;
      }
      return initialized;
    } finally {
      await client.stop();
    }
  }
}

function toKimiConfig(config: NonNullable<ProtocolClient["acpSessionConfig"]>): KimiConfig {
  const model = config.configOptions.find((option) => option.id === "model");
  const thinking = config.configOptions.find((option) => option.id === "thinking");
  return {
    defaultModel: model?.currentValue ?? null,
    defaultThinking: thinking?.currentValue === "on",
    models: (model?.options ?? []).map((option) => ({
      id: option.value,
      name: option.name,
      capabilities: thinking ? ["thinking"] : [],
    })),
  };
}
