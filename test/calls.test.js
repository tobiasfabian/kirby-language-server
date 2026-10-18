import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completionContext, fieldContext, fieldMethodContext, findCalls, memberAt, nameAt, propsContext, variableAt, variableContext } from '../src/calls.js';

const names = (text) => findCalls(text).map((call) => [call.kind, ...call.names.map(({ name }) => name)]);

test('finds literal snippet names', () => {
	assert.deepEqual(names(`<?php snippet('m-card') ?>`), [['snippet', 'm-card']]);
	assert.deepEqual(names(`<?php snippet("blocks/text", ['block' => $block]) ?>`), [['snippet', 'blocks/text']]);
	assert.deepEqual(names(`<?= snippet('a-button', return: true) ?>`), [['snippet', 'a-button']]);
	assert.deepEqual(names(`$kirby->snippet('m-card')`), [['snippet', 'm-card']]);
});

test('finds fallback lists', () => {
	assert.deepEqual(names(`snippet(['m-card-project', 'm-card'])`), [['snippet', 'm-card-project', 'm-card']]);
	assert.deepEqual(names(`snippet([\n\t'a',\n\t'b',\n], $data)`), [['snippet', 'a', 'b']]);
});

test('finds collections in PHP and blueprint queries', () => {
	assert.deepEqual(names(`$projects = collection('projects');`), [['collection', 'projects']]);
	assert.deepEqual(names(`$kirby->collection('blog/recent')`), [['collection', 'blog/recent']]);
	assert.deepEqual(names(`query: kirby.collection("products")`), [['collection', 'products']]);
	assert.deepEqual(names(`collection(['a', 'b'])`), []);
});

test('finds translation keys', () => {
	const [plain] = findCalls(`<?= t('project.completed') ?>`);
	assert.deepEqual([plain.kind, plain.fn, plain.more, plain.names[0].name], ['translation', 't', false, 'project.completed']);

	const [fallback] = findCalls(`<?= t('missing', 'Fallback') ?>`);
	assert.equal(fallback.more, true);

	assert.deepEqual(names(`<?= tc('project', $count) ?> <?= tt('greeting', ['name' => $name]) ?>`), [['translation', 'project'], ['translation', 'greeting']]);
	assert.deepEqual(names(`print('x'); count($a); format('y')`), []);
});

test('finds file paths in the docroot', () => {
	assert.deepEqual(names(`<?= hashedUrl('assets/css/index.css') ?>`), [['asset', 'assets/css/index.css']]);
	assert.deepEqual(names(`<?= svg('/assets/images/logo.svg') ?> <?= asset('assets/images/monkey@2x.webp')->url() ?>`), [['asset', '/assets/images/logo.svg'], ['asset', 'assets/images/monkey@2x.webp']]);
	assert.deepEqual(names(`<?= css('assets/css/print.css', 'print') ?> <?= js('assets/js/index.js', ['type' => 'module']) ?>`), [['asset', 'assets/css/print.css'], ['asset', 'assets/js/index.js']]);
	assert.deepEqual(names(`<?= url('assets/images/logo.svg') ?>`), [['asset', 'assets/images/logo.svg']]);
});

test('ignores URLs and generated files', () => {
	assert.deepEqual(names(`<?= css('@auto') ?> <?= js('https://example.com/a.js') ?> <?= css('//example.com/a.css') ?>`), []);
	assert.deepEqual(names(`<?= css('media/plugins/index.css') ?>`), []);
	assert.deepEqual(names(`<?= url('search') ?> <?= url('page://abc') ?> <?= $page->url('de') ?> <?= url('sitemap.xml') ?>`), []);
	assert.deepEqual(names(`<?= svg('assets/images/symbol-' . $name . '.svg') ?>`), []);
});

test('finds template names', () => {
	assert.deepEqual(names(`$page->children()->template('project')`), [['template', 'project']]);
	assert.deepEqual(names(`$pages->notTemplate(['error', 'home'])`), [['template', 'error', 'home']]);
	assert.deepEqual(names(`$page->changeTemplate('note')`), [['template', 'note']]);
	assert.deepEqual(names(`$pages->filterBy('template', 'project') $pages->filterBy('intendedTemplate', 'in', ['a', 'b'])`), [['template', 'project'], ['template', 'a', 'b']]);
	assert.deepEqual(names(`query: page.children.template("project")`), [['template', 'project']]);
	assert.deepEqual(names(`public function template(): Template`), []);
	assert.deepEqual(names(`I18n::template('roomle.dimension', null, [])`), []);
	assert.deepEqual(names(`$pages->filterBy('title', 'project')`), []);
});

test('ignores names built at runtime', () => {
	assert.deepEqual(names(`snippet('blocks/' . $block->type())`), []);
	assert.deepEqual(names(`snippet($name)`), []);
	assert.deepEqual(names(`snippet(['fields/' . $type, 'fields/text'])`), []);
	assert.deepEqual(names(`collection('blog-' . $year)`), []);
});

test('ignores other functions', () => {
	assert.deepEqual(names(`mysnippet('m-card')`), []);
	assert.deepEqual(names(`new Collection('x')`), []);
});

test('returns the name offsets', () => {
	const text = `<?php snippet('m-card') ?>`;
	const [{ names: [name] }] = findCalls(text);
	assert.equal(text.slice(name.start, name.end), 'm-card');
});

test('detects the cursor inside a name', () => {
	const text = `<?php snippet('m-ca`;
	assert.deepEqual(completionContext(text, text.length), { kind: 'snippet', fn: 'snippet', prefix: 'm-ca', start: text.length - 4 });

	const empty = `<?php snippet('`;
	assert.deepEqual(completionContext(empty, empty.length), { kind: 'snippet', fn: 'snippet', prefix: '', start: empty.length });

	const list = `<?php snippet(['m-card-project', 'blocks/`;
	assert.equal(completionContext(list, list.length)?.prefix, 'blocks/');

	const collection = `<?php collection('pro`;
	assert.deepEqual(completionContext(collection, collection.length), { kind: 'collection', fn: 'collection', prefix: 'pro', start: collection.length - 3 });

	const query = `query: kirby.collection("`;
	assert.equal(completionContext(query, query.length)?.kind, 'collection');

	const translation = `<?= t('project.`;
	assert.deepEqual(completionContext(translation, translation.length), { kind: 'translation', fn: 't', prefix: 'project.', start: translation.length - 8 });

	const template = `$pages->filterBy('template', 'in', ['project', 'no`;
	assert.deepEqual(completionContext(template, template.length), { kind: 'template', fn: 'filterBy', prefix: 'no', start: template.length - 2 });

	const asset = `<?= hashedUrl('/assets/c`;
	assert.deepEqual(completionContext(asset, asset.length), { kind: 'asset', fn: 'hashedUrl', prefix: '/assets/c', start: asset.length - 9 });
});

test('offers nothing outside names', () => {
	const data = `<?php snippet('m-card', ['size' => '`;
	assert.equal(completionContext(data, data.length), null);
	assert.equal(completionContext(`<?php echo('`, 12), null);
});

test('finds the name under the cursor', () => {
	const text = `<?php snippet('m-card'); collection('projects') ?>`;
	assert.deepEqual(nameAt(text, text.indexOf('card')), { kind: 'snippet', name: 'm-card', start: 15, end: 21 });
	assert.equal(nameAt(text, text.indexOf('projects'))?.kind, 'collection');
	assert.equal(nameAt(text, 2), null);
});

test('finds the keys of a snippet’s data array', () => {
	const at = (text) => propsContext(text.replace('▮', ''), text.indexOf('▮'));

	assert.deepEqual(at(`<?php snippet('m-card', ['si▮`), { names: ['m-card'], prefix: 'si', start: 26 });
	assert.equal(at(`<?php snippet('m-card', ['page' => $page, '▮`)?.prefix, '');
	assert.deepEqual(at(`<?php snippet('m-card', data: ['▮`)?.names, ['m-card']);
	assert.deepEqual(at(`<?php snippet(['m-card-project', 'm-card'], ['▮`)?.names, ['m-card-project', 'm-card']);
	assert.equal(at(`<?php snippet('m-card', ['page' => '▮`), null);
	assert.equal(at(`<?php snippet('m-card', ['attr' => ['▮`), null);
	assert.equal(at(`<?php snippet('m-card', ['a' => 1]); echo('▮`), null);
	assert.equal(at(`<?php snippet('m-card', compact('▮`), null);
});

test('detects field names after $page->', () => {
	assert.deepEqual(fieldContext('<?= $page->ti', 13), { variable: 'page', prefix: 'ti', start: 11, end: 13, call: false });
	assert.deepEqual(fieldContext('<?= $page->ti() ?>', 13), { variable: 'page', prefix: 'ti', start: 11, end: 13, call: true });
	assert.deepEqual(fieldContext('<?= $site->co|ver() ?>'.replace('|', ''), 13), { variable: 'site', prefix: 'co', start: 11, end: 16, call: true });
	assert.equal(fieldContext('<?= $page->children()->', 23), null);
	assert.equal(fieldContext('<?= $item->', 11), null);
});

test('detects field methods and variables', () => {
	assert.deepEqual(fieldMethodContext('<?= $page->cover()->to', 22), { variable: 'page', field: 'cover', prefix: 'to', start: 20, end: 22, call: false });
	assert.equal(fieldMethodContext('<?= $page->children()->first()->', 32), null);
	assert.deepEqual(variableContext('<?= $co', 7), { prefix: 'co', start: 4, end: 7 });
	assert.equal(variableContext('<?= $page->', 11), null);
	assert.equal(variableContext('<?= "\\$co', 9), null);
	assert.deepEqual(variableAt('<?= $cover ?>', 6), { name: 'cover', start: 4, end: 10 });
});

test('finds the method or field under the cursor', () => {
	const text = '<?= $page->cover()->toFile()->url() ?> <?= $site->logo() ?>';

	assert.deepEqual(memberAt(text, text.indexOf('cover') + 2), { variable: 'page', name: 'cover', start: 11, end: 16 });
	assert.deepEqual(memberAt(text, text.indexOf('toFile') + 2), { variable: 'page', field: 'cover', name: 'toFile', start: 20, end: 26 });
	assert.equal(memberAt(text, text.indexOf('url') + 1), null);
	assert.equal(memberAt(text, text.indexOf('logo'))?.variable, 'site');
	assert.equal(memberAt(text, 1), null);
});
