/**
 * Auto Session Setup Extension
 *
 * On the first user message:
 * 1. Uses openai/gpt-6-luna to generate a concise session name
 * 2. Sets the Pi session name
 * 3. Updates the terminal title and current Herdr tab label
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model, TextContent } from "@earendil-works/pi-ai";

export default function (pi: ExtensionAPI) {
	// A side chat is a split pane inside its source tab. It must not rename the
	// shared tab, terminal title, or its ephemeral Pi session from a side prompt.
	if (process.env.PI_HERDR_SIDE === "1") return;

	let isFirstMessage = true;
	let targetModel: Model<Api> | undefined;
	let generation = 0;
	let namingAbort: AbortController | undefined;

	// Never emit terminal escapes into JSON/RPC output, even on a TTY.
	function setTabTitle(title: string, ctx: ExtensionContext): void {
		if (ctx.mode === "tui") ctx.ui.setTitle(title);
	}

	async function setHerdrTabName(name: string, ctx: ExtensionContext): Promise<void> {
		const tabId = process.env.HERDR_TAB_ID;
		if (ctx.mode !== "tui" || process.env.HERDR_ENV !== "1" || !tabId) return;
		const result = await pi.exec("herdr", ["tab", "rename", tabId, name], { timeout: 5_000 });
		if (result.code !== 0) {
			throw new Error(result.stderr.trim() || result.stdout.trim() || "Herdr tab rename failed");
		}
	}

	// ── Reset state and find the model for session naming ────────────────
	pi.on("session_start", (event, ctx) => {
		generation++;
		namingAbort?.abort();
		namingAbort = undefined;
		// Only auto-name truly empty/new sessions. On /reload the extension runtime
		// is recreated, so the module-level default would otherwise make the next
		// user message look like the first message and rename an existing session.
		if (event.reason === "reload" || event.reason === "resume" || event.reason === "fork") {
			isFirstMessage = false;
			return;
		}

		const hasExistingName = Boolean(pi.getSessionName());
		const hasUserMessages = ctx.sessionManager
			.getEntries()
			.some((entry) => entry.type === "message" && entry.message.role === "user");
		isFirstMessage = !hasExistingName && !hasUserMessages;

		// Use GPT Luna through OpenAI only; keep the prompt fallback if
		// unavailable rather than silently switching models or providers.
		targetModel = ctx.modelRegistry.find("openai", "gpt-6-luna");
	});

	// ── On first user message, generate session name asynchronously ──────
	pi.on("before_agent_start", async (event, ctx) => {
		if (!isFirstMessage) return;
		isFirstMessage = false;

		const userMessage = event.prompt?.trim();
		if (!userMessage) return;

		const requestGeneration = generation;

		// Set a temporary name immediately so the user sees something
		const tempName = userMessage.split("\n")[0].trim().slice(0, 60);
		pi.setSessionName(tempName);
		setTabTitle(`${tempName} — pi`, ctx);
		void setHerdrTabName(tempName, ctx).catch((error) => {
			if (requestGeneration !== generation) return;
			ctx.ui.notify(`Could not rename Herdr tab: ${error instanceof Error ? error.message : String(error)}`, "warning");
		});

		// Fire off the model call in the background — don't block the agent
		if (targetModel) {
			namingAbort = new AbortController();
			ctx.modelRegistry
				.complete(
					targetModel,
					{
						systemPrompt:
							"Generate a very short session name (max 60 chars) that summarizes the user's goal from their first message. "
							+ "Output ONLY the name — no quotes, no labels, no explanation, no punctuation.",
						messages: [
							{
								role: "user",
								content: [{ type: "text", text: userMessage }],
								timestamp: Date.now(),
							},
						],
					},
					{
						signal: namingAbort.signal,
						maxTokens: 2_048,
						reasoning: "low",
					},
				)
				.then((result) => {
					if (!result || requestGeneration !== generation) return;
					const text = result.content
						.filter((b): b is TextContent => b.type === "text")
						.map((b) => b.text)
						.join("")
						.trim();

					if (result.stopReason === "error") {
						throw new Error(result.errorMessage || "model request failed");
					}
					if (!text) {
						throw new Error(`model returned no visible text (stop reason: ${result.stopReason})`);
					}

					let name = text.replace(/^["'\u201C\u201D]+|["'\u201C\u201D]+$/g, "").trim();
					if (name.length > 60) name = name.slice(0, 57) + "...";

					// Update the session name and titles with the model-generated name.
					pi.setSessionName(name);
					setTabTitle(`${name} — pi`, ctx);
					return setHerdrTabName(name, ctx);
				})
				.catch((error) => {
					if (requestGeneration !== generation) return;
					ctx.ui.notify(
						`Session naming with openai/gpt-6-luna failed; keeping the prompt fallback: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
				})
				.finally(() => {
					if (requestGeneration === generation) namingAbort = undefined;
				});
		} else {
			ctx.ui.notify("openai/gpt-6-luna is unavailable; keeping the prompt fallback name", "warning");
		}
	});

	pi.on("session_shutdown", () => {
		generation++;
		namingAbort?.abort();
		namingAbort = undefined;
	});
}
