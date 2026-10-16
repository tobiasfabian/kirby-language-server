import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fieldTypes, typeContext } from '../src/blueprints.js';

/**
 * Puts the cursor at `▮`
 * @param {string} text
 */
function contextAt(text) {
	const offset = text.indexOf('▮');
	return typeContext(text.replace('▮', ''), offset);
}

test('finds type: in fields', () => {
	assert.deepEqual(contextAt('fields:\n  title:\n    type: te▮'), { prefix: 'te', start: 27 });
	assert.ok(contextAt('fields:\n  - type: ▮'));
	assert.ok(contextAt('type: ▮'));
	assert.ok(contextAt('fields:\n  # comment\n\n  title:\n    label: Title\n    type: "▮'));
	assert.ok(contextAt('columns:\n  title:\n    type: ▮'));
});

test('finds fields in Kirby 6 layouts and structures', () => {
	const blueprint = [
		'fields:',
		'  intro:',
		'    type: textarea',
		'tabs:',
		'  content:',
		'    columns:',
		'      - width: 2/3',
		'        fields:',
		'          people:',
		'            type: structure',
		'            fields:',
		'              name:',
		'                type: ▮',
	].join('\n');

	assert.ok(contextAt(blueprint));
});

test('stays out of other type keys', () => {
	assert.equal(contextAt('fields:\n  category:\n    options:\n      type: ▮'), null);
	assert.equal(contextAt('fields:\n  url:\n    when:\n      type: ▮'), null);
	assert.equal(contextAt('fields:\n  title:\n    label: ▮'), null);
});

test('offers Kirby 6 field types with deprecated aliases', () => {
	const types = fieldTypes();

	assert.ok(types.some(({ name }) => name === 'pagelist'));
	assert.equal(types.some(({ name }) => name === 'fields'), false);
	assert.equal(types.find(({ name }) => name === 'pages')?.replacement, 'pagepicker');
	assert.equal(types.find(({ name }) => name === 'text')?.docs, 'https://getkirby.com/docs/reference/panel/fields/text');
});
