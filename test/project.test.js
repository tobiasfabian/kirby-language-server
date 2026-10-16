import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { collectionSignature, findSites, listCollections, listSnippets, listTranslations, snippetProps, snippetVariables } from '../src/project.js';

const project = fileURLToPath(new URL('./fixtures/project', import.meta.url));
const site = path.join(project, 'public', 'site');

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
	assert.equal(collections.get('contact-forms')?.line, 10);
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
