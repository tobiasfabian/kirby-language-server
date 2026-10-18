/**
 * Talks to the server bundled for VS Code the way VS Code starts it:
 * as a Node.js child process over IPC (`--node-ipc`).
 * Run `npm run build` first.
 */

import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const server = fileURLToPath(new URL('../vscode/dist/server.js', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL('../vscode/package.json', import.meta.url), 'utf8'));
const project = fileURLToPath(new URL('./fixtures/project', import.meta.url));
const template = `${project}/public/site/templates/default.php`;
const uri = pathToFileURL(template).href;
const text = fs.readFileSync(template, 'utf8');

let child;
let nextId = 1;
const pending = new Map();

function request(method, params) {
	const id = nextId++;
	child.send({ jsonrpc: '2.0', id, method, params });
	return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

before(async () => {
	child = fork(server, ['--node-ipc'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
	child.on('message', (message) => pending.get(message.id)?.resolve(message.result));
	child.on('exit', (code) => pending.forEach(({ reject }) => reject(new Error(`Server exited with ${code}`))));

	await request('initialize', { processId: process.pid, rootUri: pathToFileURL(project).href, workspaceFolders: [{ uri: pathToFileURL(project).href, name: 'project' }], capabilities: {} });
	child.send({ jsonrpc: '2.0', method: 'initialized', params: {} });
	child.send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'php', version: 1, text } } });
});

after(() => child.kill());

test('the VS Code bundle answers over IPC', async () => {
	const lines = text.slice(0, text.indexOf(`snippet('o-header`) + `snippet('`.length).split('\n');
	const items = await request('textDocument/completion', { textDocument: { uri }, position: { line: lines.length - 1, character: lines.at(-1).length } });

	assert.ok(items.some((item) => item.label === 'm-card'));
});

test('the manifest starts the extension for PHP and YAML', () => {
	assert.deepEqual(manifest.activationEvents, ['onLanguage:php', 'onLanguage:yaml']);
	assert.equal(manifest.main, './dist/extension.js');
	assert.ok(fs.existsSync(new URL('../vscode/dist/extension.js', import.meta.url)));
});
