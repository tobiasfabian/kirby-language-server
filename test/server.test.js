/**
 * Talks to the built server over stdio, like an editor does.
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
const templateUri = pathToFileURL(template).href;
const text = fs.readFileSync(template, 'utf8');

let child;
let buffer = Buffer.alloc(0);
let nextId = 1;
const pending = new Map();
const notifications = [];

function send(message) {
	const body = JSON.stringify({ jsonrpc: '2.0', ...message });
	child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function request(method, params) {
	const id = nextId++;
	send({ id, method, params });

	return new Promise((resolve, reject) => {
		pending.set(id, resolve);

		// Fail instead of waiting forever when the server dies
		child.once('exit', (code) => reject(new Error(`Server exited with ${code}`)));
	});
}

function onData(chunk) {
	buffer = Buffer.concat([buffer, chunk]);

	while (true) {
		const headerEnd = buffer.indexOf('\r\n\r\n');

		if (headerEnd === -1) {
			return;
		}

		const length = Number(buffer.subarray(0, headerEnd).toString().match(/Content-Length: (\d+)/)[1]);

		if (buffer.length < headerEnd + 4 + length) {
			return;
		}

		const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString());
		buffer = buffer.subarray(headerEnd + 4 + length);

		if (message.id !== undefined && pending.has(message.id)) {
			pending.get(message.id)(message.result);
			pending.delete(message.id);
		} else if (message.method !== undefined) {
			notifications.push(message);
		}
	}
}

function positionOf(needle, shift = 0) {
	const offset = text.indexOf(needle) + shift;
	const lines = text.slice(0, offset).split('\n');
	return { line: lines.length - 1, character: lines.at(-1).length };
}

before(async () => {
	child = spawn(process.execPath, [server, '--stdio']);
	child.stdout.on('data', onData);

	await request('initialize', {
		processId: process.pid,
		rootUri: pathToFileURL(project).href,
		workspaceFolders: [{ uri: pathToFileURL(project).href, name: 'project' }],
		// As Nova sends it
		capabilities: { textDocument: { definition: { linkSupport: true } } },
	});
	send({ method: 'initialized', params: {} });
	send({ method: 'textDocument/didOpen', params: { textDocument: { uri: templateUri, languageId: 'php', version: 1, text } } });
});

after(() => child.kill());

test('completes snippet names', async () => {
	const position = positionOf(`snippet('o-header`, `snippet('o-`.length);
	const items = await request('textDocument/completion', { textDocument: { uri: templateUri }, position });
	const labels = items.map((item) => item.label);

	assert.ok(labels.includes('m-card'));
	assert.ok(labels.includes('m-form-contact'));
	assert.ok(labels.includes('blocks/image'));

	const card = items.find((item) => item.label === 'm-card');
	assert.match(card.documentation.value, /\$size \?\?= 'medium';/);
	assert.equal(card.textEdit.range.start.character, position.character - 2);
});

test('jumps to the snippet file', async () => {
	const location = await request('textDocument/definition', {
		textDocument: { uri: templateUri },
		position: positionOf(`'m-card', [`, 2),
	});

	const [link] = location;
	assert.equal(fileURLToPath(link.targetUri), `${project}/public/site/snippets/m-card.php`);
	assert.deepEqual(link.originSelectionRange, { start: positionOf(`'m-card', [`, 1), end: positionOf(`'m-card', [`, 7) });
});

test('shows the snippet on hover', async () => {
	const hover = await request('textDocument/hover', {
		textDocument: { uri: templateUri },
		position: positionOf(`'m-form-contact'`, 2),
	});

	assert.match(hover.contents.value, /plugin site-contact/);
});

test('completes collection names', async () => {
	const position = positionOf(`collection('projects`, `collection('pro`.length);
	const items = await request('textDocument/completion', { textDocument: { uri: templateUri }, position });

	assert.deepEqual(items.map((item) => item.label).sort(), ['blog/recent', 'contact-forms', 'projects', 'team']);
	assert.match(items.find((item) => item.label === 'projects').documentation.value, /return function \(Site \$site\): Pages/);
});

test('jumps to a collection defined in a plugin', async () => {
	const location = await request('textDocument/definition', {
		textDocument: { uri: templateUri },
		position: positionOf(`'contact-forms'`, 2),
	});

	const [link] = location;
	assert.equal(fileURLToPath(link.targetUri), `${project}/public/site/plugins/site-contact/index.php`);
	assert.equal(link.targetSelectionRange.start.line, 10);
});

test('shows the origin above each call', async () => {
	const lenses = await request('textDocument/codeLens', { textDocument: { uri: templateUri } });
	const titles = lenses.map((lens) => lens.command.title);

	assert.ok(titles.includes('site/snippets/m-card.php'));
	assert.ok(titles.includes('plugin site-contact · site/plugins/site-contact/snippets/m-form-contact.php'));
	assert.ok(titles.includes('config · site/config/config.php'));
});

/**
 * Waits for the diagnostics of a document
 * @param {string} uri
 */
async function diagnosticsOf(uri) {
	for (let attempt = 0; attempt < 50; attempt++) {
		const message = notifications.findLast((notification) => notification.method === 'textDocument/publishDiagnostics' && notification.params.uri === uri);

		if (message !== undefined) {
			return message.params.diagnostics.map((diagnostic) => diagnostic.message);
		}

		await new Promise((resolve) => setTimeout(resolve, 20));
	}

	return null;
}

test('completes translation keys with their text', async () => {
	const position = positionOf(`t('project.completed`, `t('pro`.length);
	const items = await request('textDocument/completion', { textDocument: { uri: templateUri }, position });
	const completed = items.find((item) => item.label === 'project.completed');

	assert.equal(completed.detail, 'Abgeschlossen');
	assert.match(completed.documentation.value, /- en: Completed/);
	const save = items.find((item) => item.label === 'save');
	assert.equal(save.detail, 'Save');
	assert.ok(save.sortText > completed.sortText);
});

test('jumps to the translation in the default language', async () => {
	const [link] = await request('textDocument/definition', {
		textDocument: { uri: templateUri },
		position: positionOf(`t('project.completed`, 4),
	});

	assert.equal(fileURLToPath(link.targetUri), `${project}/public/site/languages/de.php`);
	assert.equal(link.targetSelectionRange.start.line, 8);
});

test('warns about missing snippets, collections and translations', async () => {
	const messages = await diagnosticsOf(templateUri);

	assert.equal(messages.length, 5);
	assert.match(messages[0], /Snippet “head” not found/);
	assert.match(messages[1], /Snippet “m-nav-footer” not found/);
	assert.match(messages[2], /Collection “missing” not found/);
	assert.match(messages[3], /Translation “missing.key” not found/);
	assert.match(messages[4], /Translation “missing.plural” not found/);
});

test('checks collections in blueprint queries', async () => {
	const blueprint = `${project}/public/site/blueprints/pages/default.yml`;
	const uri = pathToFileURL(blueprint).href;

	send({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'yaml', version: 1, text: fs.readFileSync(blueprint, 'utf8') } } });

	const messages = await diagnosticsOf(uri);

	assert.equal(messages.length, 1);
	assert.match(messages[0], /Collection “unknown” not found/);
});

test('completes field types in blueprints', async () => {
	const blueprint = `${project}/public/site/blueprints/pages/default.yml`;
	const uri = pathToFileURL(blueprint).href;
	const text = fs.readFileSync(blueprint, 'utf8');
	const line = text.split('\n').findIndex((row) => row.includes('type: pages'));

	const items = await request('textDocument/completion', {
		textDocument: { uri },
		position: { line, character: text.split('\n')[line].indexOf('pages') + 2 },
	});

	assert.ok(items.some((item) => item.label === 'pagelist'));
	assert.equal(items.find((item) => item.label === 'pages').detail, 'deprecated: use pagepicker');
});

test('completes the variables a snippet expects', async () => {
	const items = await request('textDocument/completion', {
		textDocument: { uri: templateUri },
		position: positionOf(`'size' => 'large'`, 3),
	});

	assert.deepEqual(items.map((item) => item.label), ['page', 'size']);
	assert.equal(items[1].detail, '= \'medium\'');
	assert.equal(items[1].textEdit.newText, 'size');
});
