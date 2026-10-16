import assert from 'node:assert/strict';
import { test } from 'node:test';
import { typeContext, typesFor } from '../src/blueprints.js';

/**
 * Puts the cursor at `▮`
 * @param {string} text
 */
function contextAt(text) {
	const offset = text.indexOf('▮');
	return typeContext(text.replace('▮', ''), offset);
}

test('finds the container of a type', () => {
	assert.deepEqual(contextAt('fields:\n  title:\n    type: te▮'), { prefix: 'te', start: 27, container: 'fields' });
	assert.equal(contextAt('sections:\n  content:\n    type: ▮')?.container, 'sections');
	assert.equal(contextAt('sections:\n  - type: ▮')?.container, 'sections');
	assert.equal(contextAt('type: ▮')?.container, null);
	assert.equal(contextAt('fields:\n  # comment\n\n  title:\n    label: Title\n    type: "▮')?.container, 'fields');
});

test('finds nested fields in tabs, columns and structures', () => {
	const blueprint = [
		'tabs:',
		'  content:',
		'    columns:',
		'      main:',
		'        sections:',
		'          content:',
		'            type: fields',
		'            fields:',
		'              people:',
		'                type: structure',
		'                fields:',
		'                  name:',
		'                    type: ▮',
	].join('\n');

	assert.equal(contextAt(blueprint)?.container, 'fields');
});

test('stays out of other type keys', () => {
	assert.equal(contextAt('fields:\n  category:\n    options:\n      type: ▮')?.container, 'category');
	assert.equal(contextAt('fields:\n  url:\n    when:\n      type: ▮')?.container, 'url');
	assert.equal(contextAt('fields:\n  title:\n    label: ▮'), null);
});

test('offers fields or sections depending on Kirby and the place', () => {
	const names = (...args) => typesFor(...args).map(({ name }) => name);

	assert.ok(names(5, 'fields', 'site/blueprints/pages/default.yml').includes('writer'));
	assert.deepEqual(names(5, 'sections', 'site/blueprints/pages/default.yml'), ['fields', 'files', 'info', 'pages', 'stats']);
	assert.deepEqual(names(5, null, 'site/blueprints/sections/files.yml'), ['fields', 'files', 'info', 'pages', 'stats']);
	assert.ok(names(5, null, 'site/blueprints/fields/writer.yml').includes('writer'));
	assert.ok(names(5, 'columns', 'site/blueprints/sections/list.yml').includes('tags'));
	assert.deepEqual(names(5, 'options', 'site/blueprints/pages/default.yml'), []);

	const six = typesFor(6, 'fields', 'site/blueprints/pages/default.yml');
	assert.ok(six.some(({ name }) => name === 'pagelist'));
	assert.equal(six.some(({ name }) => name === 'fields'), false);
	assert.equal(six.find(({ name }) => name === 'pages')?.replacement, 'pagepicker');
});
