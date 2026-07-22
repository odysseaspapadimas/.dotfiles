import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	formatSkillsForPrompt,
	getAgentDir,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type Skill,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";

interface SkillToggleConfig {
	disabledSkills: string[];
}

const CONFIG_PATH = join(getAgentDir(), "skill-toggle.json");

function loadDisabledSkills(): Set<string> {
	try {
		const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<SkillToggleConfig>;
		return new Set(Array.isArray(config.disabledSkills)
			? config.disabledSkills.filter((name): name is string => typeof name === "string")
			: []);
	} catch {
		return new Set();
	}
}

function saveDisabledSkills(disabledSkills: Set<string>): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	const tempPath = `${CONFIG_PATH}.tmp`;
	writeFileSync(tempPath, `${JSON.stringify({ disabledSkills: [...disabledSkills].sort() }, null, 2)}\n`, { mode: 0o600 });
	renameSync(tempPath, CONFIG_PATH);
}

function skillsFromOptions(options: BuildSystemPromptOptions): Skill[] {
	return options.skills ?? [];
}

function filterSkills(skills: readonly Skill[], query: string): Skill[] {
	const terms = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
	return skills.filter((skill) => {
		const searchable = `${skill.name}\n${skill.description}\n${skill.filePath}`.toLocaleLowerCase();
		return terms.every((term) => searchable.includes(term));
	});
}

class SkillPicker implements Focusable {
	focused = false;
	private query = "";
	private searchMode = false;
	private selected = 0;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly skills: Skill[],
		private readonly maxVisible: number,
		private readonly isEnabled: (name: string) => boolean,
		private readonly setEnabled: (name: string, enabled: boolean) => void,
		private readonly done: () => void,
	) {}

	handleInput(data: string): void {
		const skills = this.filtered();
		if (this.searchMode) {
			if (matchesKey(data, Key.escape) || matchesKey(data, "ctrl+g")) this.searchMode = false;
			else if (matchesKey(data, Key.up)) this.move(-1, skills.length);
			else if (matchesKey(data, Key.down)) this.move(1, skills.length);
			else if (matchesKey(data, Key.pageUp)) this.selected = Math.max(0, this.selected - this.maxVisible);
			else if (matchesKey(data, Key.pageDown)) this.selected = Math.min(Math.max(0, skills.length - 1), this.selected + this.maxVisible);
			else if (matchesKey(data, Key.enter)) this.toggle(skills);
			else if (matchesKey(data, Key.backspace)) { this.query = [...this.query].slice(0, -1).join(""); this.selected = 0; }
			else if (matchesKey(data, "ctrl+u")) { this.query = ""; this.selected = 0; }
			else if ([...data].every((character) => character >= " " && character !== "\x7f")) { this.query += data; this.selected = 0; }
			else return;
		} else if (matchesKey(data, Key.escape) || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
			this.done();
			return;
		} else if (matchesKey(data, "/") || matchesKey(data, "s")) this.searchMode = true;
		else if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.move(-1, skills.length);
		else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.move(1, skills.length);
		else if (matchesKey(data, Key.pageUp)) this.selected = Math.max(0, this.selected - this.maxVisible);
		else if (matchesKey(data, Key.pageDown)) this.selected = Math.min(Math.max(0, skills.length - 1), this.selected + this.maxVisible);
		else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) this.toggle(skills);
		else if (matchesKey(data, "a")) this.setAll(true);
		else if (matchesKey(data, "n")) this.setAll(false);
		else return;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (width < 20) return [truncateToWidth(this.theme.fg("accent", "skills"), Math.max(1, width), "")];
		const innerWidth = width - 2;
		const skills = this.filtered();
		this.selected = Math.min(this.selected, Math.max(0, skills.length - 1));
		const start = Math.max(0, Math.min(this.selected - Math.floor(this.maxVisible / 2), skills.length - this.maxVisible));
		const visible = skills.slice(start, start + this.maxVisible);
		const enabledCount = this.skills.filter((skill) => !skill.disableModelInvocation && this.isEnabled(skill.name)).length;
		const modelSkills = this.skills.filter((skill) => !skill.disableModelInvocation).length;
		const border = (text: string) => this.theme.fg("border", text);
		const row = (content: string) => {
			const clipped = truncateToWidth(content, innerWidth - 2, "");
			return `${border("│")} ${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped) - 1))}${border("│")}`;
		};
		const separator = border(`├${"─".repeat(innerWidth)}┤`);
		const title = this.theme.fg("accent", this.theme.bold(" skills · model context "));
		const top = border("╭─") + title + border(`${"─".repeat(Math.max(0, innerWidth - visibleWidth(title) - 1))}╮`);
		const cursor = this.focused && this.searchMode ? CURSOR_MARKER : "";
		const query = this.query || this.theme.fg("dim", this.searchMode ? "type to filter" : "press / to search");
		const mode = this.searchMode ? this.theme.fg("accent", "SEARCH") : this.theme.fg("muted", "BROWSE");
		const lines = [top, row(`${mode}  ${this.theme.fg("muted", "Query:")} ${query}${cursor}${this.searchMode ? this.theme.fg("accent", "▏") : ""}`), row(this.theme.fg("dim", `${enabledCount}/${modelSkills} skills exposed to the model · ${skills.length} matching`)), separator];

		if (visible.length === 0) lines.push(row(this.theme.fg("warning", "No matching skills")));
		for (let index = 0; index < visible.length; index += 1) {
			const skill = visible[index]!;
			const selected = start + index === this.selected;
			const enabled = this.isEnabled(skill.name);
			const marker = skill.disableModelInvocation ? this.theme.fg("muted", "◇") : enabled ? this.theme.fg("success", "●") : this.theme.fg("dim", "○");
			const name = selected ? this.theme.fg("accent", this.theme.bold(skill.name)) : skill.name;
			const status = skill.disableModelInvocation ? this.theme.fg("muted", "manual only") : enabled ? this.theme.fg("success", "visible") : this.theme.fg("muted", "hidden");
			lines.push(row(`${selected ? this.theme.fg("accent", "→") : " "} ${marker} ${name}  ${status}`));
		}

		lines.push(separator);
		const skill = skills[this.selected];
		if (skill) {
			for (const line of wrapTextWithAnsi(skill.description, Math.max(1, innerWidth - 4)).slice(0, 3)) lines.push(row(`  ${line}`));
			lines.push(row(this.theme.fg("dim", `  ${skill.filePath}`)));
		}
		lines.push(separator);
		lines.push(row(this.theme.fg("dim", this.searchMode ? "↑↓ navigate · Enter toggle · Esc leave search · Ctrl+U clear" : "j/k or ↑↓ navigate · Enter/space toggle · / search")));
		lines.push(row(this.theme.fg("dim", "a expose all · n hide all · q/Esc close · changes save immediately")));
		lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
		return lines;
	}

	invalidate(): void {}

	private filtered(): Skill[] { return filterSkills(this.skills, this.query); }
	private move(delta: number, count: number): void { this.selected = count === 0 ? 0 : (this.selected + delta + count) % count; }
	private toggle(skills: readonly Skill[]): void {
		const skill = skills[this.selected];
		if (skill && !skill.disableModelInvocation) this.setEnabled(skill.name, !this.isEnabled(skill.name));
	}
	private setAll(enabled: boolean): void {
		for (const skill of this.skills) if (!skill.disableModelInvocation) this.setEnabled(skill.name, enabled);
	}
}

export default function skillToggleExtension(pi: ExtensionAPI) {
	let disabledSkills = loadDisabledSkills();
	const isEnabled = (name: string) => !disabledSkills.has(name);
	const setEnabled = (name: string, enabled: boolean) => {
		if (enabled) disabledSkills.delete(name); else disabledSkills.add(name);
		saveDisabledSkills(disabledSkills);
	};

	pi.on("before_agent_start", (event) => {
		const skills = skillsFromOptions(event.systemPromptOptions);
		if (skills.length === 0 || disabledSkills.size === 0) return;
		const originalBlock = formatSkillsForPrompt(skills);
		if (!originalBlock) return;
		const enabledBlock = formatSkillsForPrompt(skills.filter((skill) => isEnabled(skill.name)));
		return { systemPrompt: event.systemPrompt.includes(originalBlock) ? event.systemPrompt.replace(originalBlock, enabledBlock) : event.systemPrompt };
	});

	pi.registerCommand("skills", {
		description: "Show or hide skills in the model context",
		getArgumentCompletions: (prefix) => {
			const commands = pi.getCommands().filter((command) => command.source === "skill");
			const values = ["list", "enable-all", "disable-all", ...commands.map((command) => command.name.replace(/^skill:/, ""))];
			const matches = values.filter((value) => value.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const skills = skillsFromOptions(ctx.getSystemPromptOptions());
			const byName = new Map(skills.map((skill) => [skill.name, skill]));
			const argument = args.trim();
			if (argument === "list") {
				const lines = skills.map((skill) => `${skill.disableModelInvocation ? "manual " : isEnabled(skill.name) ? "visible" : "hidden "}  ${skill.name}`);
				ctx.ui.notify(lines.length > 0 ? lines.join("\n") : "No skills loaded", "info"); return;
			}
			if (argument === "enable-all" || argument === "disable-all") {
				const enabled = argument === "enable-all";
				for (const skill of skills) if (!skill.disableModelInvocation) { if (enabled) disabledSkills.delete(skill.name); else disabledSkills.add(skill.name); }
				saveDisabledSkills(disabledSkills);
				ctx.ui.notify(`${enabled ? "Exposed" : "Hidden"} ${skills.filter((skill) => !skill.disableModelInvocation).length} skill(s)`, "info"); return;
			}
			if (argument) {
				const skill = byName.get(argument);
				if (!skill) { ctx.ui.notify(`Unknown skill: ${argument}`, "error"); return; }
				if (skill.disableModelInvocation) { ctx.ui.notify(`${skill.name} is manual-only and cannot be exposed to the model`, "warning"); return; }
				const enabled = !isEnabled(skill.name); setEnabled(skill.name, enabled);
				ctx.ui.notify(`${enabled ? "Exposed" : "Hidden"} ${skill.name} in model context`, "info"); return;
			}
			if (ctx.mode !== "tui") { ctx.ui.notify("Use /skills <name>, /skills list, /skills enable-all, or /skills disable-all", "info"); return; }
			if (skills.length === 0) { ctx.ui.notify("No skills loaded", "info"); return; }
			await ctx.ui.custom((_tui, theme, _keybindings, done) => new SkillPicker(_tui, theme, skills, Math.max(3, Math.min(10, _tui.terminal.rows - 13)), isEnabled, setEnabled, () => done(undefined)), {
				overlay: true,
				overlayOptions: { anchor: "center", width: 88, minWidth: 48, maxHeight: "85%", margin: 2 },
			});
		},
	});
}
