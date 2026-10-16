import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";
import stylistic from '@stylistic/eslint-plugin'

export default defineConfig([
	{
		ignores: ["Kirby.novaextension/Server/**"],
	},
	{
		files: ["**/*.{js,mjs,cjs}"],
		plugins: {
			'@stylistic': stylistic,
			js,
		},
		extends: ["js/recommended"],
		languageOptions: { globals: globals.node },
		rules: {
			'@stylistic/indent': ['error', 'tab'],
		}
	},
	{
		// Nova's extension runtime
		files: ["Kirby.novaextension/Scripts/**/*.js"],
		languageOptions: {
			sourceType: "commonjs",
			globals: {
				exports: "writable",
				nova: "readonly",
				LanguageClient: "readonly",
				NotificationRequest: "readonly",
				Process: "readonly",
				Range: "readonly",
			},
		},
	},
]);
