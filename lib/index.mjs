import z from "@deepseek-ai/schemastery";
// src/index.ts
const inject = [];
const Config = z.object({});
function apply(ctx) {
	ctx.logger?.info?.("[nano-market] market page ready (browser module)");
}
export { Config, apply, inject };
