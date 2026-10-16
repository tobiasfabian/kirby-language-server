import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completionContext, findCalls, nameAt } from '../src/calls.js';

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
	assert.deepEqual(completionContext(text, text.length), { kind: 'snippet', prefix: 'm-ca', start: text.length - 4 });

	const empty = `<?php snippet('`;
	assert.deepEqual(completionContext(empty, empty.length), { kind: 'snippet', prefix: '', start: empty.length });

	const list = `<?php snippet(['m-card-project', 'blocks/`;
	assert.equal(completionContext(list, list.length)?.prefix, 'blocks/');

	const collection = `<?php collection('pro`;
	assert.deepEqual(completionContext(collection, collection.length), { kind: 'collection', prefix: 'pro', start: collection.length - 3 });

	const query = `query: kirby.collection("`;
	assert.equal(completionContext(query, query.length)?.kind, 'collection');

	const translation = `<?= t('project.`;
	assert.deepEqual(completionContext(translation, translation.length), { kind: 'translation', prefix: 'project.', start: translation.length - 8 });
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
