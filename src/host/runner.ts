import { spawn } from "node:child_process";
import type { JobPayload, OpenClawRunJobPayload, ShellJobPayload } from "../types.js";

export interface RunResult {
  success: boolean;
  durationMs: number;
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface HostExecutionConfig {
  allowedCommands: string[];
  defaultTimeoutMs: number;
  maxOutputBytes: number;
  openclawCommand: string;
}

function resolveCommand(payload: JobPayload, config: HostExecutionConfig): ShellJobPayload {
  if (payload.kind === "shell") {
    return payload;
  }

  const openclawPayload = payload as OpenClawRunJobPayload;
  return {
    kind: "shell",
    command: config.openclawCommand,
    args: openclawPayload.args ?? ["run"],
    cwd: openclawPayload.openclawDir,
    env: openclawPayload.env,
    timeoutMs: openclawPayload.timeoutMs
  };
}

function clampOutput(chunks: Buffer[], maxBytes: number): string {
  const merged = Buffer.concat(chunks);
  if (merged.length <= maxBytes) {
    return merged.toString("utf8");
  }
  const suffix = Buffer.from("\n[output truncated]\n", "utf8");
  const keep = Math.max(0, maxBytes - suffix.length);
  return Buffer.concat([merged.subarray(0, keep), suffix]).toString("utf8");
}

export async function runJob(payload: JobPayload, config: HostExecutionConfig): Promise<RunResult> {
  const shellPayload = resolveCommand(payload, config);
  const allowed = new Set(config.allowedCommands);

  if (!allowed.has(shellPayload.command)) {
    return {
      success: false,
      durationMs: 0,
      exitCode: 126,
      stdout: "",
      stderr: "",
      error: `command not allowed: ${shellPayload.command}`
    };
  }

  const started = Date.now();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const timeoutMs = Math.max(1_000, shellPayload.timeoutMs ?? config.defaultTimeoutMs);

  return await new Promise<RunResult>((resolve) => {
    const child = spawn(shellPayload.command, shellPayload.args ?? [], {
      cwd: shellPayload.cwd,
      env: {
        ...process.env,
        ...(shellPayload.env ?? {})
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      resolve({
        success: false,
        durationMs: Date.now() - started,
        exitCode: 1,
        stdout: clampOutput(stdoutChunks, config.maxOutputBytes),
        stderr: clampOutput(stderrChunks, config.maxOutputBytes),
        error: err.message
      });
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      const durationMs = Date.now() - started;
      resolve({
        success: !timedOut && code === 0,
        durationMs,
        exitCode: code ?? 1,
        stdout: clampOutput(stdoutChunks, config.maxOutputBytes),
        stderr: clampOutput(stderrChunks, config.maxOutputBytes),
        error: timedOut ? `timed out after ${timeoutMs}ms` : undefined
      });
    });
  });
}
