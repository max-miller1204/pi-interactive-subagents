import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const providers = [
	"amazon-bedrock",
	"ant-ling",
	"anthropic",
	"azure-openai-responses",
	"baseten",
	"cerebras",
	"cloudflare-ai-gateway",
	"cloudflare-workers-ai",
	"deepseek",
	"fireworks",
	"github-copilot",
	"google-vertex",
	"google",
	"groq",
	"huggingface",
	"kimi-coding",
	"meta",
	"minimax-cn",
	"minimax",
	"mistral",
	"moonshotai-cn",
	"moonshotai",
	"nvidia",
	"openai-codex",
	"openai",
	"opencode-go",
	"opencode",
	"openrouter",
	"qwen-token-plan-cn",
	"qwen-token-plan-individual",
	"qwen-token-plan",
	"radius",
	"together",
	"vercel-ai-gateway",
	"xai",
	"xiaomi-token-plan-ams",
	"xiaomi-token-plan-cn",
	"xiaomi-token-plan-sgp",
	"xiaomi",
	"zai-coding-cn",
	"zai",
];

if (process.argv.length > 3) {
	throw new Error(
		"Usage: node scripts/patch-pi-declarations.mjs [pi-ai-directory]",
	);
}
const packageDir = process.argv[2]
	? resolve(process.argv[2])
	: resolve(
			dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"))),
			"..",
		);
const metadata = JSON.parse(
	readFileSync(join(packageDir, "package.json"), "utf8"),
);
if (
	metadata.name !== "@earendil-works/pi-ai" ||
	metadata.version !== "0.87.1"
) {
	throw new Error(
		`Declaration patch requires @earendil-works/pi-ai 0.87.1. Found ${metadata.name} ${metadata.version}.`,
	);
}

const dir = join(packageDir, "dist/providers");
const expectedNames = providers.map((name) => `${name}.models.d.ts`).sort();
const actualNames = readdirSync(dir)
	.filter((name) => name.endsWith(".models.d.ts"))
	.sort();
if (
	actualNames.length !== 41 ||
	actualNames.some((name, index) => name !== expectedNames[index])
) {
	throw new Error(
		"Expected exactly the 41 Pi AI 0.87.1 model declaration files.",
	);
}

// Validate every file before the first write. Accept only the two approved states.
const changes = [];
for (const provider of providers) {
	const name = `${provider}.models.d.ts`;
	const originalImport = `import values from "./data/${provider}.json";`;
	const patchedImport = `import values from "./data/${provider}.json" with { type: "json" };`;
	const original = `${originalImport}\nimport { type ModelCatalog } from "../model-catalog.ts";\nexport declare const ${provider.replaceAll("-", "_").toUpperCase()}_MODELS: ModelCatalog<typeof values, "${provider}">;\n//# sourceMappingURL=${name}.map`;
	const patched = original.replace(originalImport, patchedImport);
	const file = join(dir, name);
	const actual = readFileSync(file, "utf8");
	if (actual !== original && actual !== patched) {
		throw new Error(`Unexpected declaration content: ${name}`);
	}
	if (actual === original) changes.push({ file, patched });
}
for (const { file, patched } of changes) writeFileSync(file, patched);
console.log(`Patched ${changes.length} of 41 Pi AI 0.87.1 model declarations.`);
