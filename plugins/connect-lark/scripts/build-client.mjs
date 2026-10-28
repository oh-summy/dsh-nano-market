// Build the DSH browser module for the native connect-lark settings page.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const body = readFileSync(new URL("../client-src/client.js", import.meta.url), "utf8");
const { name } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const out = `window.__ModuleLoader__.load({
	id: ${JSON.stringify(name)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		${body}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
`;
mkdirSync(new URL("../lib", import.meta.url), { recursive: true });
writeFileSync(new URL("../lib/client.js", import.meta.url), out);
console.log("lib/client.js written (" + out.length + " bytes)");
