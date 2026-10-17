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
		pending.set(id, { resolve, reject });
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
			pending.get(message.id).resolve(message.result);
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

	// Fail instead of waiting forever when the server dies
	child.on('exit', (code) => pending.forEach(({ reject }) => reject(new Error(`Server exited with ${code}`))));

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
	assert.equal(link.targetSelectionRange.start.line, fs.readFileSync(fileURLToPath(link.targetUri), 'utf8').split('\n').findIndex((line) => line.includes(`'contact-forms'`)));
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

	assert.equal(messages.length, 8);
	assert.match(messages[0], /Snippet “head” not found/);
	assert.match(messages[1], /Snippet “m-nav-footer” not found/);
	assert.match(messages[2], /Collection “missing” not found/);
	assert.match(messages[3], /Translation “missing.key” not found/);
	assert.match(messages[4], /Translation “missing.plural” not found/);
	assert.match(messages[5], /File “assets\/images\/missing.svg” not found/);
	assert.match(messages[6], /Template “missing-template” not found: no blueprint pages\/missing-template or files\/missing-template, no template missing-template.php and no page that uses it/);
	assert.equal(messages[7], 'Variable “$block” is not defined: the template doesn’t set it and its controller doesn’t return it.');
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

test('completes file paths in the docroot', async () => {
	const position = positionOf(`hashedUrl('assets/css`, `hashedUrl('assets/`.length);
	const items = await request('textDocument/completion', { textDocument: { uri: templateUri }, position });

	assert.deepEqual(items.map((item) => item.label), ['css/', 'images/']);
	assert.equal(items[0].textEdit.range.start.character, position.character);

	const top = await request('textDocument/completion', { textDocument: { uri: templateUri }, position: positionOf(`hashedUrl('`, `hashedUrl('`.length) });
	assert.deepEqual(top.map((item) => item.label), ['assets/']);

	const url = await request('textDocument/completion', { textDocument: { uri: templateUri }, position: positionOf(`url('search`, `url('`.length) });
	assert.deepEqual(url.map((item) => item.label), ['assets/']);
});

test('jumps to a file in the docroot', async () => {
	const [link] = await request('textDocument/definition', {
		textDocument: { uri: templateUri },
		position: positionOf(`logo.svg`, 2),
	});

	assert.equal(fileURLToPath(link.targetUri), `${project}/public/assets/images/logo.svg`);
});

/**
 * Opens a blueprint of the fixture project
 * @param {string} name
 */
function openBlueprint(name) {
	const file = `${project}/public/site/blueprints/${name}.yml`;
	const uri = pathToFileURL(file).href;
	const text = fs.readFileSync(file, 'utf8');

	send({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'yaml', version: 1, text } } });

	const position = (needle, shift = 0) => {
		const lines = text.slice(0, text.indexOf(needle) + shift).split('\n');
		return { line: lines.length - 1, character: lines.at(-1).length };
	};

	return { uri, position };
}

test('warns about blueprints that don’t exist', async () => {
	const { uri } = openBlueprint('pages/project');
	const messages = await diagnosticsOf(uri);

	assert.deepEqual(messages, [
		'Blueprint “fields/gallery” not found. Kirby ignores it.',
		'Blueprint “textarea” not found. Kirby ignores it. For a field type, use “type: textarea”.',
		'Blueprint “tabs/missing” not found. Kirby ignores it.',
	]);
});

test('completes blueprint names, the fitting folder first', async () => {
	const { uri, position } = openBlueprint('pages/project');
	const items = await request('textDocument/completion', { textDocument: { uri }, position: position('fields/cover', 'fields/'.length) });
	const sorted = items.sort((a, b) => a.sortText.localeCompare(b.sortText)).map((item) => item.label);

	assert.equal(sorted[0], 'fields/contact-form');
	assert.ok(sorted.indexOf('fields/cover') < sorted.indexOf('pages/contact'));
	assert.ok(sorted.includes('blocks/text'));
	assert.equal(items.find((item) => item.label === 'pages/contact').detail, 'plugin site-contact · site/plugins/site-contact/blueprints/pages/contact.yml');
});

test('opens the blueprint a blueprint extends', async () => {
	const { uri, position } = openBlueprint('pages/project');
	const [link] = await request('textDocument/definition', { textDocument: { uri }, position: position('tabs/seo', 3) });

	assert.equal(fileURLToPath(link.targetUri), `${project}/public/site/blueprints/tabs/seo.yml`);

	const hover = await request('textDocument/hover', { textDocument: { uri }, position: position('fields/cover', 3) });
	assert.equal(hover.contents.value, '**fields/cover** · site/blueprints/fields/cover.yml');
});

test('warns about templates that don’t exist in blueprints', async () => {
	const { uri } = openBlueprint('pages/projects');
	const messages = await diagnosticsOf(uri);

	assert.deepEqual(messages, [
		'Template “missing-change” not found: no blueprint pages/missing-change, no template missing-change.php and no page that uses it.',
		'Template “missing-page” not found: no blueprint pages/missing-page, no template missing-page.php and no page that uses it.',
		'File template “missing-file” has no blueprint files/missing-file. Kirby uses files/default.',
	]);
});

test('completes page and file templates in blueprints', async () => {
	const { uri, position } = openBlueprint('pages/projects');
	const pages = await request('textDocument/completion', { textDocument: { uri }, position: position('- note', 2) });
	const labels = pages.map((item) => item.label);

	for (const name of ['project', 'note', 'contact', 'default', 'projects', 'error']) {
		assert.ok(labels.includes(name), name);
	}

	assert.equal(labels.includes('image'), false);
	assert.equal(labels.includes('project.json'), false);
	assert.match(pages.find((item) => item.label === 'contact').documentation.value, /- blueprint: plugin site-contact/);
	assert.equal(pages.find((item) => item.label === 'error').detail, 'content/error/error.de.txt');

	const files = await request('textDocument/completion', { textDocument: { uri }, position: position('template: image', 'template: '.length) });
	assert.deepEqual(files.map((item) => item.label).sort(), ['default', 'image']);
});

test('opens the blueprint of a template in a blueprint', async () => {
	const { uri, position } = openBlueprint('pages/projects');
	const [link] = await request('textDocument/definition', { textDocument: { uri }, position: position('- project\n', 4) });

	assert.equal(fileURLToPath(link.targetUri), `${project}/public/site/blueprints/pages/project.yml`);
});

test('completes and opens templates in PHP', async () => {
	const items = await request('textDocument/completion', { textDocument: { uri: templateUri }, position: positionOf(`template(['project`, `template(['`.length) });
	const sorted = items.sort((a, b) => a.sortText.localeCompare(b.sortText)).map((item) => item.label);

	assert.ok(sorted.includes('note'));
	assert.ok(sorted.indexOf('note') < sorted.indexOf('image'));

	const files = await request('textDocument/completion', { textDocument: { uri: templateUri }, position: positionOf(`template('image`, `template('`.length) });
	assert.equal(files.sort((a, b) => a.sortText.localeCompare(b.sortText))[0].label, 'image');

	const [link] = await request('textDocument/definition', { textDocument: { uri: templateUri }, position: positionOf(`'note'`, 2) });
	assert.equal(fileURLToPath(link.targetUri), `${project}/public/site/templates/note.php`);
});

test('completes the options of a field', async () => {
	const { uri, position } = openBlueprint('pages/project');
	const items = await request('textDocument/completion', { textDocument: { uri }, position: position('label: Titelbild', 2) });
	const labels = items.map((item) => item.label);

	// cover extends fields/cover, a filepicker
	assert.ok(labels.includes('uploads'));
	assert.ok(labels.includes('label'));
	assert.equal(labels.includes('extends'), false);
	assert.equal(items.find((item) => item.label === 'multiple').detail, 'bool|null = true');
	assert.equal(items.find((item) => item.label === 'multiple').textEdit.newText, 'multiple: ');
});

/**
 * Opens a PHP file of the fixture site with the given text
 * @param {string} file relative to site/
 * @param {string} text
 */
function openPhp(file, text) {
	const uri = pathToFileURL(`${project}/public/site/${file}`).href;

	send({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'php', version: 1, text } } });

	const position = (needle, shift = 0) => {
		const lines = text.slice(0, text.indexOf(needle) + shift).split('\n');
		return { line: lines.length - 1, character: lines.at(-1).length };
	};

	return { uri, position };
}

test('completes the fields of the page in a controller', async () => {
	const { uri, position } = openPhp('controllers/project.php', fs.readFileSync(`${project}/public/site/controllers/project.php`, 'utf8'));
	const items = await request('textDocument/completion', { textDocument: { uri }, position: position('$page->', 7) });

	assert.deepEqual(items.filter((item) => item.kind === 5).map((item) => item.label), ['cover', 'gallery', 'intro', 'text', 'metaTitle', 'metaDescription']);
	assert.equal(items[0].detail, 'filepicker · pages/project');
	assert.equal(items[0].documentation, 'Titelbild');

	// The rest of the name after the cursor is replaced, the existing parentheses kept
	assert.equal(items[0].textEdit.newText, 'cover');
	assert.deepEqual(items[0].textEdit.range.end, position('$page->cover', 12));
});

test('completes the fields of the site, a block and pages in a snippet', async () => {
	const site = openPhp('templates/default.php', '<?= $site-> ?>');
	const siteItems = await request('textDocument/completion', { textDocument: { uri: site.uri }, position: site.position('$site->', 7) });
	assert.deepEqual(siteItems.map((item) => [item.label, item.textEdit.newText]), [['footer', 'footer()'], ['contactPage', 'contactPage()']]);

	const block = openPhp('snippets/blocks/text.php', '<?= $block->te ?>');
	const blockItems = await request('textDocument/completion', { textDocument: { uri: block.uri }, position: block.position('$block->te', 10) });
	assert.deepEqual(blockItems.map((item) => [item.label, item.detail]), [['text', 'writer · blocks/text']]);

	const snippet = openPhp('snippets/m-card.php', '<?= $page-> ?>');
	const labels = (await request('textDocument/completion', { textDocument: { uri: snippet.uri }, position: snippet.position('$page->', 7) })).map((item) => item.label);
	assert.ok(labels.includes('related'));
	assert.ok(labels.includes('cover'));
	assert.equal(labels.includes('drafts'), false);

	const other = openPhp('snippets/m-card.php', '<?= $this-> ?>');
	assert.deepEqual(await request('textDocument/completion', { textDocument: { uri: other.uri }, position: other.position('$this->', 7) }), []);
});

test('completes true, false and null for an option', async () => {
	const text = 'fields:\n  title:\n    type: text\n    translate: \n    counter: f\n    label: \n  list:\n    type: pagelist\n    create: \n';
	const uri = pathToFileURL(`${project}/public/site/blueprints/pages/options.yml`).href;
	const at = (needle) => {
		const lines = text.slice(0, text.indexOf(needle) + needle.length).split('\n');
		return { line: lines.length - 1, character: lines.at(-1).length };
	};

	send({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'yaml', version: 1, text } } });

	const translate = await request('textDocument/completion', { textDocument: { uri }, position: at('translate: ') });
	assert.deepEqual(translate.map((item) => [item.label, item.detail]), [['true', 'default'], ['false', undefined], ['null', undefined]]);

	const counter = await request('textDocument/completion', { textDocument: { uri }, position: at('counter: f') });
	assert.equal(counter[0].textEdit.range.start.character, 13);

	// A string option has no literal values; null alone would fit almost every option
	assert.deepEqual(await request('textDocument/completion', { textDocument: { uri }, position: at('label: ') }), []);

	// create: takes templates or false
	const create = (await request('textDocument/completion', { textDocument: { uri }, position: at('create: ') })).map((item) => item.label);
	assert.ok(create.includes('project'));
	assert.deepEqual(create.slice(-3), ['true', 'false', 'null']);
});

test('completes methods of plugins and the page’s model', async () => {
	const { uri, position } = openPhp('templates/project.php', '<?= $page-> ?>');
	const items = await request('textDocument/completion', { textDocument: { uri }, position: position('$page->', 7) });
	const contactForm = items.find((item) => item.label === 'contactForm');
	const year = items.find((item) => item.label === 'year');

	assert.equal(contactForm.detail, '(string $name = \'default\'): ?Page · plugin site-contact · site/plugins/site-contact/index.php');
	assert.equal(contactForm.documentation, 'The contact form of the page');
	assert.equal(year.detail, '(): int · model · site/models/project.php');
	assert.equal(items.some((item) => item.label === 'secret'), false);
	assert.ok(items.find((item) => item.label === 'cover').sortText < year.sortText);
});

test('completes field methods, the fitting ones first', async () => {
	const { uri, position } = openPhp('templates/project.php', '<?= $page->cover()-> ?> <?= $page->children()-> ?>');
	const items = await request('textDocument/completion', { textDocument: { uri }, position: position('cover()->', 9) });
	const sorted = items.sort((a, b) => a.sortText.localeCompare(b.sortText)).map((item) => item.label);

	assert.deepEqual(sorted.slice(0, 2), ['toFile', 'toFiles']);
	assert.ok(sorted.includes('kirbytext'));
	assert.equal(items.find((item) => item.label === 'toPhone').detail, '(string $format = \'international\'): string · plugin site-contact · site/plugins/site-contact/index.php');
	assert.equal(items.find((item) => item.label === 'kt').documentation, 'Alias of kirbytext()');

	// Not a field: left to PHP's language server
	assert.deepEqual(await request('textDocument/completion', { textDocument: { uri }, position: position('children()->', 12) }), []);
});

test('completes, checks and opens the variables of a template’s controllers', async () => {
	const text = '<?php foreach ($navigation as $item): ?>\n<?= $item->title() ?> <?= $cover ?> <?= $missing ?>\n<?php endforeach ?>\n<?= $c';
	const { uri, position } = openPhp('templates/project.php', text);
	const items = await request('textDocument/completion', { textDocument: { uri }, position: { line: 3, character: 6 } });
	const labels = items.map((item) => item.label);

	assert.deepEqual(labels.slice(0, 2), ['$navigation', '$cover']);
	assert.ok(labels.includes('$page'));
	assert.equal(items.find((item) => item.label === '$cover').detail, '$page->cover()->toFile()');
	assert.equal(items[0].textEdit.range.start.character, 4);

	assert.deepEqual(await diagnosticsOf(uri), ['$missing', '$c'].map((name) => `Variable “${name}” is not defined: the template doesn’t set it and its controller doesn’t return it.`));

	const [link] = await request('textDocument/definition', { textDocument: { uri }, position: position('$cover', 2) });
	assert.equal(fileURLToPath(link.targetUri), `${project}/public/site/controllers/project.php`);
	assert.equal(link.targetSelectionRange.start.line, 4);

	const hover = await request('textDocument/hover', { textDocument: { uri }, position: position('$navigation', 2) });
	assert.match(hover.contents.value, /\*\*\$navigation\*\* · site\/controllers\/site.php/);
});

test('doesn’t warn about variables of snippets or of controllers it can’t read', async () => {
	const snippet = openPhp('snippets/m-teaser.php', '<?= $title ?>');
	assert.deepEqual(await diagnosticsOf(snippet.uri), []);

	const template = openPhp('templates/default.php', '<?php extract($data) ?><?= $title ?>');
	assert.deepEqual(await diagnosticsOf(template.uri), []);
});

test('completes, checks and opens fields defined at the top and block types', async () => {
	const { uri, position } = openBlueprint('pages/article');

	assert.deepEqual(await diagnosticsOf(uri), [
		'Field “nope” is not defined in fields at the top of the blueprint. Kirby shows an error instead.',
		'Block type “missing-block” not found: there is no blueprint blocks/missing-block, so the block has no fields.',
		'Block type “blocks/custom-missing” not found: there is no blueprint blocks/custom-missing, so the block has no fields.',
	]);

	const fields = await request('textDocument/completion', { textDocument: { uri }, position: position('- nope', 2) });
	assert.deepEqual(fields.map((item) => item.label), ['intro', 'text', 'layout']);

	const blocks = (await request('textDocument/completion', { textDocument: { uri }, position: position('- heading', 4) })).map((item) => item.label);
	assert.ok(blocks.includes('heading') && blocks.includes('gallery'));

	const [link] = await request('textDocument/definition', { textDocument: { uri }, position: position('- intro', 4) });
	assert.deepEqual([fileURLToPath(link.targetUri), link.targetSelectionRange.start.line], [`${project}/public/site/blueprints/pages/article.yml`, 3]);

	const [block] = await request('textDocument/definition', { textDocument: { uri }, position: position('- image', 4) });
	assert.equal(fileURLToPath(block.targetUri), `${project}/public/kirby/config/blocks/image/image.yml`);
});

test('doesn’t check field references in partials', async () => {
	const uri = pathToFileURL(`${project}/public/site/blueprints/tabs/content.yml`).href;
	send({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'yaml', version: 1, text: 'label: Content\nfields:\n  - intro\n' } } });
	assert.deepEqual(await diagnosticsOf(uri), []);
});
