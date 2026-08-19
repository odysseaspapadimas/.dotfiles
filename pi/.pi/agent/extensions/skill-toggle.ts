import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";

const managedRoot = realpathSync(join(homedir(), ".dotfiles", "pi", ".pi", "agent", "skills"));

function skillPath(skill: Skill): string | undefined {
	try {
		return realpathSync(skill.filePath);
	} catch {
		return undefined;
	}
}

function isManaged(skill: Skill): boolean {
	const path = skillPath(skill);
	return Boolean(path && path.startsWith(`${managedRoot}${sep}`));
}

function setManualOnly(skill: Skill, manualOnly: boolean): void {
	const path = skillPath(skill);
	if (!path || !isManaged(skill)) throw new Error(`${skill.name} is not managed by ~/.dotfiles`);

	const source = readFileSync(path, "utf8");
	const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (!frontmatter) throw new Error(`${skill.name} has no YAML frontmatter`);

	const property = /^disable-model-invocation:\s*(?:true|false)\s*$/m;
	let body = frontmatter[1]!;
	if (manualOnly) {
		body = property.test(body)
			? body.replace(property, "disable-model-invocation: true")
			: `${body}\ndisable-model-invocation: true`;
	} else {
		body = body.replace(property, "").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "");
	}

	const updated = source.replace(frontmatter[0], `---\n${body}\n---\n`);
	writeFileSync(`${path}.tmp`, updated, { mode: 0o644 });
	renameSync(`${path}.tmp`, path);
}

function status(skill: Skill): string {
	if (!isManaged(skill)) return "read only";
	return skill.disableModelInvocation ? "manual" : "automatic";
}

export default function skillToggleExtension(pi: ExtensionAPI) {
	pi.registerCommand("skills", {
		description: "Set a skill as automatic or manual-only",
		getArgumentCompletions: (prefix) => {
			const names = pi.getCommands()
				.filter((command) => command.source === "skill")
				.map((command) => command.name.replace(/^skill:/, ""))
				.filter((name) => name.startsWith(prefix));
			return names.length ? names.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const skills = ctx.getSystemPromptOptions().skills ?? [];
			let skill: Skill | undefined;
			const name = args.trim();

			if (name) {
				skill = skills.find((candidate) => candidate.name === name);
			} else {
				const labels = skills.map((candidate) => `${candidate.name}  ·  ${status(candidate)}`);
				const choice = await ctx.ui.select("Skill policy", labels);
				if (!choice) return;
				skill = skills[labels.indexOf(choice)];
			}

			if (!skill) {
				ctx.ui.notify(`Unknown skill: ${name}`, "error");
				return;
			}
			if (!isManaged(skill)) {
				ctx.ui.notify(`${skill.name} is read-only because it is not managed by ~/.dotfiles`, "warning");
				return;
			}

			try {
				const manualOnly = !skill.disableModelInvocation;
				setManualOnly(skill, manualOnly);
				ctx.ui.notify(`${skill.name} is now ${manualOnly ? "manual-only" : "automatic"}`, "info");
				await ctx.reload();
				return;
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : "Failed to update skill", "error");
			}
		},
	});
}
