import { access, readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, parse, relative, resolve } from "node:path";

export type PackageManager = "pnpm" | "yarn" | "bun" | "npm" | "composer";

export interface PackageScript {
  name: string;
  body: string;
  invocation: string;
  command: string;
}

export interface PackageScriptProject {
  label: string;
  manifest: "package.json" | "composer.json";
  packageJsonPath: string;
  root: string;
  boundary: string;
  manager: PackageManager;
  scripts: PackageScript[];
}

export interface PackageScriptWorkspace {
  root: string;
  projects: PackageScriptProject[];
}

const LOCKFILES: ReadonlyArray<{ manager: PackageManager; names: readonly string[] }> = [
  { manager: "pnpm", names: ["pnpm-lock.yaml"] },
  { manager: "yarn", names: ["yarn.lock"] },
  { manager: "bun", names: ["bun.lock", "bun.lockb"] },
  { manager: "npm", names: ["package-lock.json"] },
];

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function gitBoundary(cwd: string): Promise<string | undefined> {
  let directory = resolve(cwd);
  const filesystemRoot = parse(directory).root;
  while (true) {
    if (await exists(join(directory, ".git"))) return directory;
    if (directory === filesystemRoot) return undefined;
    directory = dirname(directory);
  }
}

async function manifestBetween(cwd: string, boundary: string, manifest: string): Promise<string | undefined> {
  let directory = resolve(cwd);
  while (true) {
    const candidate = join(directory, manifest);
    if (await exists(candidate)) return candidate;
    if (directory === boundary) return undefined;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function packageJsonBetween(cwd: string, boundary: string): Promise<string | undefined> {
  return manifestBetween(cwd, boundary, "package.json");
}

export async function detectPackageManager(packageRoot: string, boundary = packageRoot): Promise<PackageManager> {
  let directory = resolve(packageRoot);
  const stop = resolve(boundary);
  while (true) {
    for (const lockfile of LOCKFILES) {
      for (const name of lockfile.names) {
        if (await exists(join(directory, name))) return lockfile.manager;
      }
    }
    if (directory === stop) return "npm";
    const parent = dirname(directory);
    if (parent === directory) return "npm";
    directory = parent;
  }
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function shellWord(value: string): string {
  return /^[a-zA-Z0-9_:@./+-]+$/u.test(value) ? value : shellQuote(value);
}

export function scriptInvocation(manager: PackageManager, scriptName: string): string {
  return `${manager} run ${shellWord(scriptName)}`;
}

export function executionCommand(root: string, invocation: string): string {
  return `cd -- ${shellQuote(root)} && ${invocation}`;
}

async function readProject(packageJsonPath: string, boundary: string, label: string): Promise<PackageScriptProject> {
  const root = dirname(packageJsonPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${packageJsonPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const scriptsValue = parsed && typeof parsed === "object" ? (parsed as { scripts?: unknown }).scripts : undefined;
  const entries = scriptsValue && typeof scriptsValue === "object" && !Array.isArray(scriptsValue)
    ? Object.entries(scriptsValue).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    : [];
  const manager = await detectPackageManager(root, boundary);
  const scripts = entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, body]) => {
      const invocation = scriptInvocation(manager, name);
      return { name, body, invocation, command: executionCommand(root, invocation) };
    });

  return { label, manifest: "package.json", packageJsonPath, root, boundary, manager, scripts };
}

async function readComposerProject(composerJsonPath: string, boundary: string, label: string): Promise<PackageScriptProject> {
  const root = dirname(composerJsonPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(composerJsonPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${composerJsonPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const scriptsValue = parsed && typeof parsed === "object" ? (parsed as { scripts?: unknown }).scripts : undefined;
  const entries = scriptsValue && typeof scriptsValue === "object" && !Array.isArray(scriptsValue)
    ? Object.entries(scriptsValue).flatMap(([name, value]): Array<[string, string]> => {
      if (typeof value === "string") return [[name, value]];
      if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
        return [[name, value.join(" → ")]];
      }
      return [];
    })
    : [];
  const scripts = entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, body]) => {
      const invocation = `composer run-script ${shellWord(name)}`;
      return { name, body, invocation, command: executionCommand(root, invocation) };
    });
  return {
    label,
    manifest: "composer.json",
    packageJsonPath: composerJsonPath,
    root,
    boundary,
    manager: "composer",
    scripts,
  };
}

export async function discoverPackageScripts(cwd: string): Promise<PackageScriptProject | undefined> {
  const start = resolve(cwd);
  const boundary = (await gitBoundary(start)) ?? start;
  const packageJsonPath = await packageJsonBetween(start, boundary);
  if (!packageJsonPath) return undefined;
  const root = dirname(packageJsonPath);
  const relativeLabel = relative(boundary, root);
  return readProject(packageJsonPath, boundary, relativeLabel || basename(root));
}

/**
 * Discover the current Git project, or a bounded multi-repo workspace when cwd
 * is not in Git. Workspace mode inspects cwd itself plus immediate child Git
 * worktrees only; it never recursively crawls arbitrary directories.
 */
export async function discoverPackageScriptWorkspace(cwd: string): Promise<PackageScriptWorkspace> {
  const start = resolve(cwd);
  const boundary = await gitBoundary(start);
  if (boundary) {
    const projects: PackageScriptProject[] = [];
    const packageJsonPath = await packageJsonBetween(start, boundary);
    if (packageJsonPath) {
      const root = dirname(packageJsonPath);
      const label = relative(boundary, root) || basename(root);
      projects.push(await readProject(packageJsonPath, boundary, label));
    }
    const composerJsonPath = await manifestBetween(start, boundary, "composer.json");
    if (composerJsonPath) {
      const root = dirname(composerJsonPath);
      const label = relative(boundary, root) || basename(root);
      projects.push(await readComposerProject(composerJsonPath, boundary, label));
    }
    return { root: boundary, projects };
  }

  const projects: PackageScriptProject[] = [];
  const rootPackageJson = join(start, "package.json");
  if (await exists(rootPackageJson)) {
    projects.push(await readProject(rootPackageJson, start, basename(start)));
  }
  const rootComposerJson = join(start, "composer.json");
  if (await exists(rootComposerJson)) {
    projects.push(await readComposerProject(rootComposerJson, start, basename(start)));
  }

  let children;
  try {
    children = await readdir(start, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Could not inspect workspace ${start}: ${error instanceof Error ? error.message : String(error)}`);
  }
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    if (!child.isDirectory()) continue;
    const repository = join(start, child.name);
    if (!await exists(join(repository, ".git"))) continue;
    const packageJsonPath = join(repository, "package.json");
    if (await exists(packageJsonPath)) {
      projects.push(await readProject(packageJsonPath, repository, child.name));
    }
    const composerJsonPath = join(repository, "composer.json");
    if (await exists(composerJsonPath)) {
      projects.push(await readComposerProject(composerJsonPath, repository, child.name));
    }
  }

  return { root: start, projects };
}
