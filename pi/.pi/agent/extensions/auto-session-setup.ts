/**
 * Auto Session Setup Extension
 *
 * On the first user message:
 * 1. Uses deepseek-v4-flash to generate a concise session name
 * 2. Sets the pi session name
 * 3. Sets the cmux terminal tab title to match
 */

import type { ExtensionAPI, Model } from "@earendil-works/pi-coding-agent";
import { completeSimple, type Api, type TextContent } from "@earendil-works/pi-ai";

export default function (pi: ExtensionAPI) {
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

		// Find deepseek-v4-flash — used only for generating the session name
		targetModel = ctx.modelRegistry.find("opencode-go", "deepseek-v4-flash");

		// Fallback: search across all providers
		if (!targetModel) {
			targetModel = ctx.modelRegistry
				.getAll()
				.find((m) => m.id === "deepseek-v4-flash");
		}

		// If still not found, try any deepseek model as fallback
		if (!targetModel) {
			targetModel = ctx.modelRegistry
				.getAll()
				.find((m) => m.id.toLowerCase().includes("deepseek"));
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

		// Fire off the model call in the background — don't block the agent
		if (targetModel) {
			ctx.modelRegistry
				.getApiKeyAndHeaders(targetModel)
				.then((auth) => {
					if (!auth.ok) return;
					return completeSimple(
						targetModel!,
						{
							systemPrompt:
								"Generate a very short session name (max 60 chars) that summarizes the user's goal from their first message. "
								+ "Output ONLY the name — no quotes, no labels, no explanation, no punctuation.",
							messages: [
								{
									role: "user",
									content: [{ type: "text", text: userMessage }],
								},
							],
						},
						{ apiKey: auth.apiKey, maxTokens: 30 },
					);
				})
				.then((result) => {
					if (!result) return;
					const text = result.content
						.filter((b): b is TextContent => b.type === "text")
						.map((b) => b.text)
						.join("")
						.trim();

					if (!text) return;

					let name = text.replace(/^["'\u201C\u201D]+|["'\u201C\u201D]+$/g, "").trim();
					if (name.length > 60) name = name.slice(0, 57) + "...";

					// Update the session name and tab title with the model-generated name
					pi.setSessionName(name);
					setTabTitle(`${name} — pi`);
				})
				.catch(() => {
					// Model call failed — keep the temporary name, it's fine
				});
		}
	});
}
