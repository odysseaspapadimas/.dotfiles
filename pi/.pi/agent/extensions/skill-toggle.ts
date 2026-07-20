import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	formatSkillsForPrompt,
	DynamicBorder,
	getAgentDir,
	getSettingsListTheme,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";

interface SkillToggleConfig {
	disabledSkills: string[];
}

const CONFIG_PATH = join(getAgentDir(), "skill-toggle.json");

function loadDisabledSkills(): Set<string> {
	try {
		const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<SkillToggleConfig>;
		return new Set(
			Array.isArray(config.disabledSkills)
				? config.disabledSkills.filter((name): name is string => typeof name === "string")
				: [],
		);
	} catch {
		return new Set();
	}
}

function saveDisabledSkills(disabledSkills: Set<string>): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	const tempPath = `${CONFIG_PATH}.tmp`;
	const config: SkillToggleConfig = {
		disabledSkills: [...disabledSkills].sort(),
	};
	writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	renameSync(tempPath, CONFIG_PATH);
}

function skillsFromOptions(options: BuildSystemPromptOptions): Skill[] {
	return options.skills ?? [];
}

export default function skillToggleExtension(pi: ExtensionAPI) {
	let disabledSkills = loadDisabledSkills();

	function isEnabled(name: string): boolean {
		return !disabledSkills.has(name);
	}

	function setEnabled(name: string, enabled: boolean): void {
		if (enabled) disabledSkills.delete(name);
		else disabledSkills.add(name);
		saveDisabledSkills(disabledSkills);
	}

	function replaceSkillsInPrompt(systemPrompt: string, allSkills: Skill[]): string {
		const originalBlock = formatSkillsForPrompt(allSkills);
		if (!originalBlock) return systemPrompt;

		const enabledBlock = formatSkillsForPrompt(allSkills.filter((skill) => isEnabled(skill.name)));
		return systemPrompt.includes(originalBlock)
			? systemPrompt.replace(originalBlock, enabledBlock)
			: systemPrompt;
	}

	pi.on("before_agent_start", (event) => {
		const skills = skillsFromOptions(event.systemPromptOptions);
		if (skills.length === 0 || disabledSkills.size === 0) return;

		return {
			systemPrompt: replaceSkillsInPrompt(event.systemPrompt, skills),
		};
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
				const lines = skills.map((skill) => `${isEnabled(skill.name) ? "visible" : "hidden "}  ${skill.name}`);
				ctx.ui.notify(lines.length > 0 ? lines.join("\n") : "No skills loaded", "info");
				return;
			}

			if (argument === "enable-all" || argument === "disable-all") {
				const enabled = argument === "enable-all";
				for (const skill of skills) {
					if (enabled) disabledSkills.delete(skill.name);
					else disabledSkills.add(skill.name);
				}
				saveDisabledSkills(disabledSkills);
				ctx.ui.notify(`${enabled ? "Exposed" : "Hidden"} ${skills.length} skill(s) in model context`, "info");
				return;
			}

			if (argument) {
				const skill = byName.get(argument);
				if (!skill) {
					ctx.ui.notify(`Unknown skill: ${argument}`, "error");
					return;
				}
				const enabled = !isEnabled(skill.name);
				setEnabled(skill.name, enabled);
				ctx.ui.notify(`${enabled ? "Exposed" : "Hidden"} ${skill.name} in model context`, "info");
				return;
			}

			if (ctx.mode !== "tui") {
				ctx.ui.notify("Use /skills <name>, /skills list, /skills enable-all, or /skills disable-all", "info");
				return;
			}

			if (skills.length === 0) {
				ctx.ui.notify("No skills loaded", "info");
				return;
			}

			await ctx.ui.custom(
				(tui, theme, _keybindings, done) => {
					const items: SettingItem[] = skills.map((skill) => ({
						id: skill.name,
						label: skill.name,
						description: skill.description,
						currentValue: isEnabled(skill.name) ? "visible" : "hidden",
						values: ["visible", "hidden"],
					}));

					const container = new Container();
					container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
					container.addChild(new Text(theme.fg("accent", theme.bold("Skills in Model Context")), 1, 1));

					const settingsList = new SettingsList(
						items,
						Math.min(items.length + 2, 18),
						getSettingsListTheme(),
						(id, newValue) => {
							setEnabled(id, newValue === "visible");
						},
						() => done(undefined),
						{ enableSearch: true },
					);
					container.addChild(settingsList);
					container.addChild(new Text(theme.fg("dim", "Enter/space toggle • type to search • Esc close"), 1, 1));
					container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

					return {
						render: (width: number) => container.render(width),
						invalidate: () => container.invalidate(),
						handleInput: (data: string) => {
							settingsList.handleInput?.(data);
							tui.requestRender();
						},
					};
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "70%",
						minWidth: 48,
						maxHeight: "80%",
						margin: 1,
					},
				},
			);
		},
	});
}
