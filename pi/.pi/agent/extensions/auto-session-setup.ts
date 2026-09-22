/**
 * Auto Session Setup Extension
 *
 * On the first user message:
 * 1. Uses deepseek-v4.1-flash to generate a concise session name
 * 2. Sets the Pi session name
 * 3. Updates the terminal title and current Herdr tab label
 */

import type { ExtensionAPI, Model } from "@earendil-works/pi-coding-agent";
import type { Api, TextContent } from "@earendil-works/pi-ai";

export default function (pi: ExtensionAPI) {
	// A side chat is a split pane inside its source tab. It must not rename the
	// shared tab, terminal title, or its ephemeral Pi session from a side prompt.
	if (process.env.PI_HERDR_SIDE === "1") return;

	let isFirstMessage = true;
	let targetModel: Model<Api> | undefined;

	/**
	 * Set the terminal tab/window title using standard OSC escape sequence.
	 * Works in cmux, Ghostty, iTerm2, and most modern terminals.
	 */
	function setTabTitle(title: string): void {
		try {
			// OSC 0 sets both icon name and window title
			process.stdout.write(`\x1b]0;${title}\x07`);
		} catch {
			// Silently ignore if stdout is not writable
		}
	}

	async function setHerdrTabName(name: string): Promise<void> {
		const tabId = process.env.HERDR_TAB_ID;
		if (process.env.HERDR_ENV !== "1" || !tabId) return;
		const result = await pi.exec("herdr", ["tab", "rename", tabId, name], { timeout: 5_000 });
		if (result.code !== 0) {
			throw new Error(result.stderr.trim() || result.stdout.trim() || "Herdr tab rename failed");
		}
	}

	// ── Reset state and find the model for session naming ────────────────
	pi.on("session_start", (event, ctx) => {
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

		// Use the latest DeepSeek Flash model only; a missing model should be visible
		// rather than silently selecting an unrelated DeepSeek variant.
		targetModel = ctx.modelRegistry.find("opencode-go", "deepseek-v4.1-flash");
		if (!targetModel) {
			targetModel = ctx.modelRegistry
				.getAll()
				.find((m) => m.id === "deepseek-v4.1-flash");
		}
	});

	// ── On first user message, generate session name asynchronously ──────
	pi.on("before_agent_start", async (event, ctx) => {
		if (!isFirstMessage) return;
		isFirstMessage = false;

		const userMessage = event.prompt?.trim();
		if (!userMessage) return;

		// Set a temporary name immediately so the user sees something
		const tempName = userMessage.split("\n")[0].trim().slice(0, 60);
		pi.setSessionName(tempName);
		setTabTitle(`${tempName} — pi`);
		void setHerdrTabName(tempName).catch((error) => {
			ctx.ui.notify(`Could not rename Herdr tab: ${error instanceof Error ? error.message : String(error)}`, "warning");
		});

		// Fire off the model call in the background — don't block the agent
		if (targetModel) {
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
					// Console Go requires this routing header for nested model calls.
					{
						maxTokens: 2_048,
						reasoning: "low",
						headers: { "x-opencode-session": ctx.sessionManager.getSessionId() },
					},
				)
				.then((result) => {
					if (!result) return;
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
					setTabTitle(`${name} — pi`);
					return setHerdrTabName(name);
				})
				.catch((error) => {
					ctx.ui.notify(
						`Session naming with deepseek-v4.1-flash failed; keeping the prompt fallback: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
				});
		} else {
			ctx.ui.notify("deepseek-v4.1-flash is unavailable; keeping the prompt fallback name", "warning");
		}
	});
}
