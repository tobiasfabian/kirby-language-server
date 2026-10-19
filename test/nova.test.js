/**
 * Starts the built server the way the Nova extension does: Go to Definition and
 * hover only for YAML, registered at runtime, so PHP stays with Intelephense.
 * Run `npm run build` first.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const server = fileURLToPath(new URL('../Kirby.novaextension/Server/server.cjs', import.meta.url));
const project = fileURLToPath(new URL('./fixtures/project', import.meta.url));
const template = `${project}/public/site/templates/default.php`;

let child;
let buffer = Buffer.alloc(0);
let nextId = 1;
let initialized;
const pending = new Map();
const registrations = [];
let registered;
const registeredOnce = new Promise((resolve) => {
	registered = resolve;
});

function send(message) {
	const body = JSON.stringify({ jsonrpc: '2.0', ...message });
	child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function request(method, params) {
	const id = nextId++;
	send({ id, method, params });
	return new Promise((resolve) => pending.set(id, resolve));
}

before(async () => {
	child = spawn(process.execPath, [server, '--stdio']);
	child.stdout.on('data', (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);

		for (let end = buffer.indexOf('\r\n\r\n'); end !== -1; end = buffer.indexOf('\r\n\r\n')) {
			const length = Number(buffer.subarray(0, end).toString().match(/Content-Length: (\d+)/)[1]);

			if (buffer.length < end + 4 + length) {
				return;
			}

			const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
			buffer = buffer.subarray(end + 4 + length);

			// The server registers features at runtime: answer like an editor
			if (message.method === 'client/registerCapability') {
				registrations.push(...message.params.registrations);
				send({ id: message.id, result: null });

				if (registrations.length >= 2) {
					registered();
				}
			} else if (message.id !== undefined && pending.has(message.id)) {
				pending.get(message.id)(message.result);
			}
		}
	});

	initialized = await request('initialize', {
		processId: process.pid,
		rootUri: pathToFileURL(project).href,
		capabilities: { textDocument: { definition: { dynamicRegistration: true, linkSupport: true }, hover: { dynamicRegistration: true } } },
		initializationOptions: { navigation: ['yaml'] },
	});
	send({ method: 'initialized', params: {} });
});

after(() => child.kill());

test('offers Go to Definition and hover only for YAML', async () => {
	assert.equal(initialized.capabilities.definitionProvider, false);
	assert.equal(initialized.capabilities.hoverProvider, false);

	await registeredOnce;
	assert.deepEqual(registrations.map(({ method, registerOptions }) => [method, registerOptions.documentSelector]), [
		['textDocument/definition', [{ language: 'yaml' }]],
		['textDocument/hover', [{ language: 'yaml' }]],
	]);
});

test('still answers a definition request in PHP, as Open Referenced File sends it', async () => {
	const text = fs.readFileSync(template, 'utf8');
	const uri = pathToFileURL(template).href;
	const lines = text.slice(0, text.indexOf(`'m-card'`) + 2).split('\n');

	send({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'php', version: 1, text } } });

	const [link] = await request('textDocument/definition', { textDocument: { uri }, position: { line: lines.length - 1, character: lines.at(-1).length } });
	assert.equal(fileURLToPath(link.targetUri), `${project}/public/site/snippets/m-card.php`);
});
