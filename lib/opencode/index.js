//#region src/opencode-plugin.ts
var opencode_plugin_default = {
	id: "dsh-tool-bridge",
	async setup(ctx) {
		const baseUrl = process.env.DSH_OPENCODE_BRIDGE_URL;
		const token = process.env.DSH_OPENCODE_BRIDGE_TOKEN;
		if (baseUrl === void 0 || token === void 0 || !/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) throw new Error("DSH tool bridge transport is unavailable");
		const rpc = async (route, sessionId, body = {}, signal = AbortSignal.timeout(1e4)) => {
			const response = await fetch(baseUrl + route, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json"
				},
				body: JSON.stringify({
					...body,
					sessionId
				}),
				signal
			});
			const result = await response.json();
			if (!response.ok) {
				if (route === "/tools/list" && response.status === 403) return void 0;
				throw new Error(result.error ?? "DSH tool bridge request failed");
			}
			return result;
		};
		const registrations = [];
		try {
			registrations.push(await ctx.tool.transform((editor) => {
				editor.namespace({
					name: "dsh",
					description: "Tools supplied by the current DeepSeek Harness session and its plugins."
				});
				editor.add({
					name: "list",
					options: {
						namespace: "dsh",
						codemode: false
					},
					description: "List the DSH tool plugins available in this session, including their argument schemas. Use dsh_call to run a listed tool.",
					input: {
						type: "object",
						properties: {},
						additionalProperties: false
					},
					execute: async (_, context) => ({ content: JSON.stringify(await rpc("/tools/list", context.sessionID, {}, context.signal) ?? { tools: [] }) })
				});
				editor.add({
					name: "call",
					options: {
						namespace: "dsh",
						codemode: false
					},
					description: "Run a DSH tool by its exact name and arguments. DSH applies its normal policies and approvals and records the result. Only tools listed for this session may run.",
					input: {
						type: "object",
						properties: {
							name: { type: "string" },
							arguments: {
								type: "object",
								additionalProperties: true
							}
						},
						required: ["name", "arguments"],
						additionalProperties: false
					},
					execute: async (input, context) => {
						const args = input;
						const result = await rpc("/tools/call", context.sessionID, {
							name: args.name,
							arguments: args.arguments,
							callId: context.id
						}, context.signal);
						if (result === void 0) throw new Error("DSH tool returned no result");
						return { content: JSON.stringify(result) };
					}
				});
			}));
			registrations.push(await ctx.session.hook("context", async (context) => {
				const catalogue = await rpc("/tools/list", context.sessionID);
				if (catalogue === void 0) {
					delete context.tools.dsh_list;
					delete context.tools.dsh_call;
					return;
				}
				if (catalogue.concluded) {
					context.tools = {};
					context.system.push({
						type: "text",
						text: "The DSH tool has concluded this turn. Give a brief final response based on its result."
					});
					return;
				}
				context.system.push({
					type: "text",
					text: [
						catalogue.system ?? "",
						"DSH tool plugins are available through dsh_call. Use the exact listed name and arguments; dsh_list can refresh their schemas. Instructions naming a DSH tool mean to invoke it through dsh_call.",
						JSON.stringify(catalogue.tools)
					].filter(Boolean).join("\n\n")
				});
			}));
		} catch (error) {
			await Promise.all(registrations.map((registration) => registration.dispose()));
			throw error;
		}
		return async () => {
			for (const registration of registrations.reverse()) await registration.dispose();
		};
	}
};

//#endregion
export { opencode_plugin_default as default };