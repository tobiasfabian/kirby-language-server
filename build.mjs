import fs from "node:fs";
import esbuild from "esbuild";

const dev = process.argv.includes("--dev");

// The server is bundled into each extension, so it runs without node_modules
const builds = [
	// Nova
	{ entryPoints: ["src/server.js"], outfile: "Kirby.novaextension/Server/server.cjs" },
	// VS Code: the same server, and the client that starts it (vscode is VS Code's own module)
	{ entryPoints: ["src/server.js"], outfile: "vscode/dist/server.js" },
	{ entryPoints: ["vscode/src/extension.js"], outfile: "vscode/dist/extension.js", external: ["vscode"] },
].map((build) => ({
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node18",
	minify: !dev,
	sourcemap: dev,
	...build,
}));

// vsce packages the license from the extension's folder
fs.copyFileSync("LICENSE", "vscode/LICENSE");

if (dev) {
	for (const build of builds) {
		const ctx = await esbuild.context(build);
		await ctx.watch();
	}
} else {
	await Promise.all(builds.map((build) => esbuild.build(build)));
}
