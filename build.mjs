import esbuild from "esbuild";

const dev = process.argv.includes("--dev");

// The server is bundled into the Nova extension, so it runs without node_modules
const options = {
	entryPoints: ["src/server.js"],
	outfile: "Kirby.novaextension/Server/server.cjs",
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node18",
	minify: !dev,
	sourcemap: dev,
};

if (dev) {
	const ctx = await esbuild.context(options);
	await ctx.watch();
} else {
	await esbuild.build(options);
}
