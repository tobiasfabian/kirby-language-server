import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chainAt, classOf, hasFields, queryContext, queryMethods, queryNameAt } from '../src/query.js';

const at = (text) => {
	const context = queryContext(text.replace('▮', ''), text.indexOf('▮'));
	return context === null ? null : { ...context, chain: chainAt(context.expression) };
};

test('finds queries in blueprints', () => {
	assert.deepEqual(at('    query: site.children.li▮'), { expression: 'site.children.li', template: false, chain: { names: ['site', 'children'], args: [null, null], prefix: 'li' } });
	assert.equal(at('  parent: site.find("blog").▮')?.chain.names.at(-1), 'find');
	assert.equal(at('  - fetch: kirby.▮')?.template, false);
	assert.equal(at('  info: "Year: {{ page.ye▮')?.template, true);
	assert.deepEqual(at('  info: "{{ page.title }} {{ pa▮')?.chain, { names: [], args: [], prefix: 'pa' });
	assert.equal(at('  text: "{< page.html▮')?.template, true);
	assert.equal(at('  text: "{{ page.title }} ▮'), null);
	assert.equal(at('  label: page.▮'), null);
});

test('follows the chain to the cursor', () => {
	assert.deepEqual(chainAt('site.find("notes").children.fil'), { names: ['site', 'find', 'children'], args: [null, '"notes"', null], prefix: 'fil' });
	assert.deepEqual(chainAt('kirby.collection("a").not(kirby.collection("b").fi')?.names, ['kirby', 'collection']);
	assert.deepEqual(chainAt('page.cover.toFile?.ur')?.names, ['page', 'cover', 'toFile']);
	assert.deepEqual(chainAt('page.title.isNotEmpty ? page.ti'), { names: ['page'], args: [null], prefix: 'ti' });
	assert.deepEqual(chainAt('page.title.isNotEmpty ? ti'), { names: [], args: [], prefix: 'ti' });
	assert.equal(chainAt('kirby.collection("pro'), null);
	assert.equal(chainAt('1.5'), null);
});

test('knows Kirby 6’s query classes', () => {
	assert.equal(classOf('?\\Kirby\\Cms\\Pages'), 'Pages');
	assert.equal(classOf('File|null'), 'File');
	assert.equal(classOf('string'), null);
	assert.equal(queryMethods('Page').find(({ name }) => name === 'children')?.type, 'Pages');
	assert.equal(queryMethods('Pages').find(({ name }) => name === 'first')?.type, 'Page');
	assert.equal(queryMethods('Field').find(({ name }) => name === 'toFile')?.type, 'File');
	assert.equal(queryMethods('Page').some(({ name }) => ['update', 'delete', 'changeStatus'].includes(name)), false);
	assert.equal(hasFields('Page') && hasFields('Pages') === false, true);
});

test('finds the name under the cursor in a query', () => {
	const text = 'query: page.chil|dren.listed'.replace('|', '');
	assert.deepEqual(queryNameAt(text, 16), { names: ['page'], args: [null], name: 'children', start: 12, end: 20, template: false });
	assert.equal(queryNameAt('label: page.children', 14), null);
});
