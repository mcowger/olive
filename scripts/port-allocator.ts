#!/usr/bin/env bun
/**
 * Deterministic, branch-stable port allocation for Olive and Paseo's `servicePorts.portScript`.
 *
 * Range is `PASEO_PORT_RANGE` (e.g. "4470-4499") or DEFAULT_RANGE.
 */

export interface PortRange {
  start: number;
  end: number;
}

export const DEFAULT_RANGE = "4470-4499";

export function parseRange(spec: string): PortRange {
  const match = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(spec);
  if (!match) {
    throw new Error(`Invalid port range: "${spec}" (expected "START-END")`);
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start < 1 || end > 65535 || end < start) {
    throw new Error(`Invalid port range: "${spec}" (bounds must be 1-65535 and START <= END)`);
  }
  return { start, end };
}

export function resolveRange(env: NodeJS.ProcessEnv = process.env): PortRange {
  return parseRange(env.PASEO_PORT_RANGE ?? DEFAULT_RANGE);
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export interface AllocateOptions {
  service: string;
  branch?: string;
  range?: PortRange;
}

export function allocatePort({ service, branch = "", range }: AllocateOptions): number {
  const { start, end } = range ?? resolveRange();
  const span = end - start + 1;
  const key = `${service}@${branch}`;
  return start + (fnv1a(key) % span);
}

export function currentGitBranch(): string {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
    if (proc.exitCode !== 0) return "";
    const branch = proc.stdout.toString().trim();
    return branch === "HEAD" ? "" : branch;
  } catch {
    return "";
  }
}

export function resolvePort(service = "web", env: NodeJS.ProcessEnv = process.env): number {
  const branch = env.PASEO_BRANCH_NAME ?? currentGitBranch();
  return allocatePort({ service, branch, range: resolveRange(env) });
}

if (import.meta.main) {
  const service = process.argv[2] ?? "web";
  process.stdout.write(String(resolvePort(service)));
}
