import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { extend } from '../src/blueprints.js';
import { collectionSignature, findAsset, findDocroot, findSites, listBlueprints, listCollections, listContentTemplates, listDocroot, listSnippets, listTemplates, listTranslations, readBlueprint, snippetProps, snippetVariables } from '../src/project.js';

const project = fileURLToPath(new URL('./fixtures/project', import.meta.url));
const site = path.join(project, 'public', 'site');

// The 0-based line of a file that contains `needle`
const lineOf = (file, needle) => fs.readFileSync(file, 'utf8').split('\n').findIndex((line) => line.includes(needle));

test('finds the site folder below the project root', () => {
	assert.deepEqual(findSites(project), [site]);
	assert.deepEqual(findSites(site), [site]);
});

test('lists site, plugin and Kirby snippets', () => {
	const snippets = listSnippets(site);

	assert.equal(snippets.get('m-card')?.source, 'site');
	assert.equal(snippets.get('m-form-contact')?.source, 'plugin');
	assert.equal(snippets.get('m-form-contact')?.plugin, 'site-contact');
	assert.equal(snippets.get('m-form-contact')?.file, path.join(site, 'plugins', 'site-contact', 'snippets', 'm-form-contact.php'));
	assert.equal(snippets.get('blocks/image')?.source, 'kirby');
	assert.equal(snippets.has('m-nav-footer'), false);
});

test('own snippets win over Kirby’s', () => {
	assert.equal(listSnippets(site).get('blocks/text')?.source, 'site');
});

test('lists collections from the folder, plugins and the config', () => {
	const collections = listCollections(site);

	assert.deepEqual([...collections.keys()].sort(), ['blog/recent', 'contact-forms', 'projects', 'team']);
	assert.equal(collections.get('projects')?.source, 'site');
	assert.equal(collections.get('contact-forms')?.source, 'plugin');
	assert.equal(collections.get('contact-forms')?.line, lineOf(path.join(site, 'plugins/site-contact/index.php'), `'contact-forms'`));
	assert.equal(collections.get('team')?.source, 'config');
});

test('ignores API collections and keys inside closures', () => {
	const collections = listCollections(site);

	assert.equal(collections.has('api-results'), false);
	assert.equal(collections.has('not-a-collection'), false);
});

test('reads the variables a snippet expects', () => {
	assert.deepEqual(snippetProps(path.join(site, 'snippets', 'm-card.php')), [
		'/** @var \\Kirby\\Cms\\Page|null $page */',
		'$page ??= null;',
		'$size ??= \'medium\';',
	]);
	assert.deepEqual(snippetProps(path.join(site, 'snippets', 'o-header.php')), ['$variant = $variant ?? null;']);
});

test('reads a collection’s signature', () => {
	const collections = listCollections(site);

	assert.equal(collectionSignature(collections.get('projects')), 'return function (Site $site): Pages');
	assert.equal(collectionSignature(collections.get('blog/recent')), 'return fn (Kirby\\Cms\\Site $site)');
	assert.equal(collectionSignature(collections.get('contact-forms')), 'function ()');
});

test('lists translations from languages, plugins and the config', () => {
	const { translations, kirby, languages, complete } = listTranslations(site);

	assert.deepEqual([...translations.keys()].sort(), ['contact.send', 'footer.copyright', 'greeting', 'project', 'project.completed']);
	assert.deepEqual(languages, ['de', 'en']);
	assert.equal(complete, true);
	assert.deepEqual([...kirby.get('save').values], [['en', 'Save']]);
	assert.equal(kirby.get('save').line, 1);

	const completed = translations.get('project.completed');
	assert.deepEqual([...completed.values], [['de', 'Abgeschlossen'], ['en', 'Completed']]);
	assert.equal(completed.file, path.join(site, 'languages', 'de.php'));
	assert.equal(completed.line, 8);

	assert.equal(translations.get('project').values.get('de'), '– / Projekt / Projekte');
	assert.equal(translations.get('contact.send').source, 'plugin');
	assert.equal(translations.get('footer.copyright').source, 'config');
});

test('reads a snippet’s variables with type and default', () => {
	assert.deepEqual(snippetVariables(path.join(site, 'snippets', 'm-card.php')), [
		{ name: 'page', type: '\\Kirby\\Cms\\Page|null', default: 'null' },
		{ name: 'size', default: '\'medium\'' },
	]);
	assert.deepEqual(snippetVariables(path.join(site, 'snippets', 'o-header.php')), [{ name: 'variant', default: 'null' }]);
});

test('finds the docroot', (t) => {
	assert.equal(findDocroot(site), path.join(project, 'public'));

	// Custom roots: site/ next to public/index.php
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kirby-'));
	t.after(() => fs.rmSync(root, { recursive: true }));
	fs.mkdirSync(path.join(root, 'site'));
	fs.mkdirSync(path.join(root, 'public'));
	fs.writeFileSync(path.join(root, 'public', 'index.php'), `<?php\ninclude '../kirby/bootstrap.php';\n`);
	assert.equal(findDocroot(path.join(root, 'site')), path.join(root, 'public'));
});

test('lists files in the docroot', () => {
	assert.deepEqual(listDocroot(site, '').map(({ name }) => name), ['assets']);
	assert.deepEqual(listDocroot(site, 'assets/images/'), [{ name: 'logo.svg', directory: false }, { name: 'monkey@2x.webp', directory: false }]);
	assert.deepEqual(listDocroot(site, 'media/plugins/'), []);
	assert.deepEqual(listDocroot(site, 'site/'), []);
	assert.deepEqual(listDocroot(site, 'missing/'), []);
});

test('finds files in the docroot', () => {
	assert.equal(findAsset(site, '/assets/css/index.css')?.directory, false);
	assert.equal(findAsset(site, 'assets/css')?.directory, true);
	assert.equal(findAsset(site, 'assets/css/missing.css'), null);
});

test('lists blueprints from the site, plugins, the config and Kirby', () => {
	const { blueprints, complete } = listBlueprints(site);

	assert.equal(complete, true);
	assert.equal(blueprints.get('pages/project')?.source, 'site');
	assert.equal(blueprints.get('pages/default')?.source, 'site');
	assert.equal(blueprints.get('files/default')?.source, 'kirby');
	assert.equal(blueprints.get('blocks/text')?.file, path.join(project, 'public/kirby/config/blocks/text/text.yml'));

	const contact = blueprints.get('pages/contact');
	assert.deepEqual([contact?.source, contact?.plugin, contact?.file], ['plugin', 'site-contact', path.join(site, 'plugins/site-contact/blueprints/pages/contact.yml')]);

	const form = blueprints.get('fields/contact-form');
	assert.deepEqual([form?.inline, form?.line], [true, lineOf(path.join(site, 'plugins/site-contact/index.php'), `'fields/contact-form'`)]);
});

test('reads blueprint lists from included files and notices unreadable ones', (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kirby-'));
	t.after(() => fs.rmSync(root, { recursive: true }));

	const write = (file, code) => {
		fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		fs.writeFileSync(path.join(root, file), code);
	};

	write('site/plugins/listed/index.php', `<?php\nKirby::plugin('a/listed', [\n\t'blueprints' => require __DIR__ . '/blueprints.php',\n]);\n`);
	write('site/plugins/listed/blueprints.php', `<?php\nreturn [\n\t'blocks/teaser' => __DIR__ . '/teaser.yml',\n];\n`);
	assert.equal(listBlueprints(path.join(root, 'site')).blueprints.get('blocks/teaser')?.file, path.join(root, 'site/plugins/listed/teaser.yml'));
	assert.equal(listBlueprints(path.join(root, 'site')).complete, true);

	write('site/plugins/runtime/index.php', `<?php\nKirby::plugin('a/runtime', [\n\t'blueprints' => A::map(glob(__DIR__ . '/*.yml'), fn ($file) => $file),\n]);\n`);
	assert.equal(listBlueprints(path.join(root, 'site')).complete, false);
});

test('reads blueprints and what they extend', () => {
	const { blueprints } = listBlueprints(site);
	const find = (name) => blueprints.has(name) ? readBlueprint(blueprints.get(name)) : null;
	const projectBlueprint = find('pages/project');

	assert.deepEqual(extend(projectBlueprint.tabs.content.fields.cover, find), { label: 'Titelbild', type: 'filepicker', multiple: false });
	assert.deepEqual(extend(projectBlueprint.tabs.seo, find), { label: 'SEO', fields: { metaTitle: { type: 'text' }, metaDescription: { type: 'textarea' } } });
	assert.equal(find('fields/contact-form'), null);
	assert.equal(find('blocks/text')?.name, 'Text');
});

test('lists templates from the site and plugins', () => {
	const templates = listTemplates(site);

	assert.deepEqual([...templates.keys()].sort(), ['contact', 'default', 'note']);
	assert.equal(templates.get('contact')?.plugin, 'site-contact');
});

test('lists the templates pages in the content folder use', () => {
	const templates = listContentTemplates(site);

	assert.deepEqual([...templates.keys()].sort(), ['error', 'project']);
	assert.equal(templates.get('error')?.file, path.join(project, 'public/content/error/error.de.txt'));
});
