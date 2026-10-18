/**
 * Starts the Kirby language server for VS Code. It runs in VS Code's own
 * Node.js and talks over IPC, so no separate Node.js installation is needed.
 */

import path from 'node:path';
import { LanguageClient, TransportKind } from 'vscode-languageclient/node';

/** @type {LanguageClient | undefined} */
let client;

/**
 * @param {import('vscode').ExtensionContext} context
 */
export async function activate(context) {
	const server = context.asAbsolutePath(path.join('dist', 'server.js'));

	client = new LanguageClient(
		'kirby',
		'Kirby',
		{
			run: { module: server, transport: TransportKind.ipc },
			debug: { module: server, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6009'] } },
		},
		{
			documentSelector: [
				{ scheme: 'file', language: 'php' },
				{ scheme: 'file', language: 'yaml' },
			],
		},
	);

	await client.start();
}

export function deactivate() {
	return client?.stop();
}
