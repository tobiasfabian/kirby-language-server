import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blueprintFields, blueprintReferences, extend, extendsContext, fieldDefinitions, fieldProperties, fieldTypeAt, fieldReferences, fieldsetReferences, fieldTypes, listItemContext, literalValues, propertyContext, referenceAt, templateSlots, typeContext, valueContext } from '../src/blueprints.js';

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

test('extends like Kirby: maps are merged, lists replaced', () => {
	const blueprints = {
		'fields/base': { type: 'text', label: 'Base', options: ['a', 'b'], props: { a: 1, b: 2 } },
		'fields/more': { extends: 'fields/base', help: 'More' },
		'fields/loop': { extends: 'fields/loop', label: 'Loop' },
	};
	const find = (name) => blueprints[name] ?? null;

	assert.deepEqual(extend({ extends: 'fields/more', label: 'Own', options: ['c'], props: { b: 3 } }, find), { type: 'text', label: 'Own', options: ['c'], props: { a: 1, b: 3 }, help: 'More' });
	assert.deepEqual(extend('fields/base', find), blueprints['fields/base']);
	assert.deepEqual(extend({ extends: ['fields/base', 'fields/missing'], width: '1/2' }, find), { ...blueprints['fields/base'], width: '1/2' });
	assert.deepEqual(extend('fields/loop', find), { label: 'Loop' });
	assert.equal(extend(true, find), true);
});

test('finds keys in list items above the cursor', () => {
	const text = 'columns:\n  - fields:\n      text:\n        type: te';
	assert.deepEqual(typeContext(text, text.length), { prefix: 'te', start: text.length - 2 });

	const sibling = 'columns:\n  - fields:\n      text: true\n    width: 1/2\n    type: ';
	assert.equal(typeContext(sibling, sibling.length), null);
});

test('detects where a blueprint name goes', () => {
	const at = (text) => extendsContext(text.replace('▮', ''), text.indexOf('▮'));

	assert.deepEqual(at('title: Project\nextends: pages/▮'), { prefix: 'pages/', start: 24, folder: null });
	assert.equal(at('fields:\n  cover:\n    extends: ▮')?.folder, 'fields');
	assert.equal(at('fields:\n  - extends: fi▮')?.folder, 'fields');
	assert.equal(at('tabs:\n  seo:\n    extends:\n      - ▮')?.folder, 'tabs');
	assert.equal(at('fields:\n  seo: fields/▮')?.folder, 'fields');
	assert.equal(at('tabs:\n  seo: ▮')?.folder, 'tabs');
	assert.equal(at('fields:\n  seo:\n    label: ▮'), null);
	assert.equal(at('title: ▮'), null);
	assert.equal(at('fields:\n  tags:\n    options:\n      - ▮'), null);
	assert.equal(at('columns:\n  - fields:\n      seo: ▮')?.folder, 'fields');
	assert.equal(at('sections:\n  fields:\n    type: ▮'), null);
});

test('finds the blueprints a blueprint refers to', () => {
	const text = [
		'extends: pages/default',
		'tabs:',
		'  seo: tabs/seo',
		'  content:',
		'    fields:',
		'      cover:',
		'        extends: fields/cover',
		'      gallery: "fields/gallery"',
		'      text: true',
		'      more:',
		'        extends: [fields/a, fields/b]',
		'      tags:',
		'        options:',
		'          a: A',
		'sections:',
		'  fields:',
		'    type: fields',
		'  files: sections/files',
	].join('\n');
	const references = blueprintReferences(text);

	assert.deepEqual(references.map(({ name, shorthand }) => [name, shorthand]), [
		['pages/default', false],
		['tabs/seo', true],
		['fields/cover', false],
		['fields/gallery', true],
		['fields/a', false],
		['fields/b', false],
		['sections/files', true],
	]);
	assert.equal(text.slice(references[3].start, references[3].end), 'fields/gallery');
	assert.equal(referenceAt(text, text.indexOf('tabs/seo') + 2)?.name, 'tabs/seo');
	assert.equal(referenceAt(text, 2), null);
});

test('finds where a blueprint names templates', () => {
	const find = (name) => ({ 'sections/drafts': { type: 'pages' }, 'fields/cover': { type: 'files' } })[name] ?? null;
	const slots = (text) => templateSlots(text, find).map(({ name, folder }) => [name, folder]);

	assert.deepEqual(slots([
		'options:',
		'  changeTemplate: [a, b]',
		'fields:',
		'  list:',
		'    type: pagelist',
		'    templates:',
		'      - project',
		'      - "note"',
		'    templatesIgnore: error',
		'    create: false',
		'  images:',
		'    type: filelist',
		'    template: image',
		'  cover:',
		'    extends: fields/cover',
		'    uploads: cover',
		'  text:',
		'    type: textarea',
		'    uploads:',
		'      template: inline',
		'  picker:',
		'    type: pagepicker',
		'    template: nope',
		'  files:',
		'    template: nope',
	].join('\n')), [['a', 'pages'], ['b', 'pages'], ['project', 'pages'], ['note', 'pages'], ['error', 'pages'], ['image', 'files'], ['cover', 'files'], ['inline', 'files']]);

	// A file blueprint changes to other file templates
	assert.deepEqual(templateSlots('options:\n  changeTemplate:\n    - download', find, 'files').map(({ folder }) => folder), ['files']);

	// Legacy sections: pages and files are the list fields
	assert.deepEqual(slots('sections:\n  drafts:\n    extends: sections/drafts\n    template: product\n  files:\n    template: image'), [['product', 'pages'], ['image', 'files']]);

	// Nothing typed yet, also in the middle of a blueprint
	const text = 'fields:\n  list:\n    type: pagelist\n    template: \n    label: List';
	assert.deepEqual(templateSlots(text, find), [{ name: null, start: text.indexOf('template: ') + 10, end: text.indexOf('template: ') + 10, folder: 'pages' }]);
});

test('knows the options of Kirby 6 field types', () => {
	const pagelist = fieldProperties('pagelist');

	assert.ok(pagelist.some(({ name }) => name === 'templatesIgnore'));
	assert.equal(pagelist.some(({ name }) => name === 'headline' || name === 'name'), false);
	assert.deepEqual(fieldProperties('text').find(({ name }) => name === 'counter'), { name: 'counter', type: 'bool|null', default: 'true', description: 'Shows or hides the character counter in the top right corner' });
	assert.equal(fieldProperties('pages'), fieldProperties('pagepicker'));
	assert.equal(fieldProperties('unknown'), null);

	for (const { name } of fieldTypes().filter(({ replacement }) => replacement === undefined)) {
		assert.notEqual(fieldProperties(name), null, name);
	}
});

test('detects where a key of a field goes', () => {
	const at = (text) => propertyContext(text.replace('▮', ''), text.indexOf('▮'));

	assert.deepEqual(at('fields:\n  title:\n    type: text\n    la▮\n    required: true\n  other:\n    type: textarea'), { prefix: 'la', start: 36, name: 'title', type: 'text', extends: undefined, present: ['type', 'required'] });
	assert.deepEqual(at('columns:\n  - width: 1/2\n    fields:\n      cover:\n        extends: fields/cover\n        ▮')?.extends, 'fields/cover');
	assert.equal(at('fields:\n  blocks:\n    ▮')?.name, 'blocks');
	assert.equal(at('tabs:\n  seo:\n    ▮'), null);
	assert.equal(at('sections:\n  fields:\n    type: fields\n    ▮'), null);
	assert.equal(at('fields:\n  title:\n    label: ▮'), null);
});

test('collects the fields of a blueprint that store content', () => {
	const parts = {
		'fields/cover': { type: 'filepicker', label: { en: 'Cover', de: 'Titelbild' } },
		'tabs/seo': { fields: { metaTitle: { type: 'text' } } },
		'fields/address': { type: 'group', fields: { street: { type: 'text' } } },
	};
	const fields = blueprintFields({
		fields: { intro: { type: 'textarea' }, list: { type: 'pagelist' } },
		tabs: {
			content: { columns: [{ fields: ['intro', { name: 'note', type: 'text' }] }, { fields: { cover: { extends: 'fields/cover' }, address: 'fields/address', hint: { type: 'info' } } }] },
			seo: 'tabs/seo',
		},
		sections: { legacy: { type: 'fields', fields: { old: { type: 'text' } } }, drafts: { type: 'pages' } },
	}, (name) => parts[name] ?? null);

	assert.deepEqual(fields, [
		{ name: 'intro', type: 'textarea', label: undefined },
		{ name: 'note', type: 'text', label: undefined },
		{ name: 'cover', type: 'filepicker', label: 'Cover' },
		{ name: 'street', type: 'text', label: undefined },
		{ name: 'metaTitle', type: 'text', label: undefined },
		{ name: 'old', type: 'text', label: undefined },
	]);
});

test('detects the value of a field’s option', () => {
	const at = (text) => valueContext(text.replace('▮', ''), text.indexOf('▮'));

	assert.deepEqual(at('fields:\n  title:\n    type: text\n    translate: ▮\n    required: true'), { key: 'translate', prefix: '', start: 47, name: 'title', type: 'text', extends: undefined, present: ['type', 'required'] });
	assert.equal(at('fields:\n  title:\n    counter: fa▮')?.prefix, 'fa');
	assert.equal(at('fields:\n  title:\n    label: "Ti▮'), null);
	assert.equal(at('tabs:\n  seo:\n    icon: ▮'), null);
	assert.equal(at('fields:\n  title:\n    translate:▮'), null);
});

test('knows the literal values of a PHP type', () => {
	assert.deepEqual(literalValues('bool|null'), ['true', 'false', 'null']);
	assert.deepEqual(literalValues('bool'), ['true', 'false']);
	assert.deepEqual(literalValues('array|string|false|null'), ['false', 'null']);
	assert.deepEqual(literalValues('string'), []);
	assert.deepEqual(literalValues('array|string|null'), []);
});

test('finds references to fields defined at the top', () => {
	const text = 'fields:\n  intro: true\n  text:\n    type: textarea\ntabs:\n  content:\n    columns:\n      - fields:\n          - intro\n          - "nope"\n      - fields: [text]';

	assert.deepEqual(fieldReferences(text).map(({ name }) => name), ['intro', 'nope', 'text']);
	assert.deepEqual(fieldReferences('create:\n  fields:\n    - price'), []);
	assert.deepEqual([...fieldDefinitions(text, () => null)], [['intro', 10], ['text', 24]]);

	// Without tabs, columns or sections, fields at the top are the blueprint's own
	assert.deepEqual([...fieldDefinitions('fields:\n  intro: true', () => null)], []);

	// Fields from a blueprint it extends, or unknown if that can't be read
	assert.deepEqual([...fieldDefinitions('extends: pages/base\ntabs: {}', () => ({ fields: { seo: true } }))], [['seo', -1]]);
	assert.equal(fieldDefinitions('extends: pages/missing\ntabs: {}', () => null), null);
});

test('finds the block types of fieldsets', () => {
	const text = 'fieldsets:\n  - heading\nlayout:\n  fieldsets:\n    text: true\n    quote: blocks/quote\n    hidden: false\n    main:\n      type: group\n      fieldsets: [image]\n    custom:\n      fields: {}';

	// custom is defined right there: no blueprint needed
	assert.deepEqual(fieldsetReferences(text).map(({ name, blueprint, inline }) => [name, blueprint, inline === true]), [['heading', 'blocks/heading', false], ['text', 'blocks/text', false], ['blocks/quote', 'blocks/quote', false], ['custom', 'blocks/custom', true], ['image', 'blocks/image', false]]);
});

test('detects list items of fields and fieldsets', () => {
	const at = (text) => listItemContext(text.replace('▮', ''), text.indexOf('▮'));

	assert.deepEqual(at('tabs:\n  a:\n    fields:\n      - in▮'), { list: 'fields', prefix: 'in', start: 31 });
	assert.equal(at('text:\n  fieldsets:\n    - ▮')?.list, 'fieldsets');
	assert.equal(at('text:\n  fieldsets:\n    he▮')?.list, 'fieldsets');
	assert.equal(at('tags:\n  options:\n    - ▮'), null);
	assert.equal(at('fields:\n  intro:\n    ty▮'), null);
});

test('finds the field type under the cursor', () => {
	assert.equal(fieldTypeAt('fields:\n  a:\n    type: textarea', 28)?.docs, 'https://getkirby.com/docs/reference/panel/fields/textarea');
	assert.equal(fieldTypeAt('fields:\n  a:\n    type: files', 25)?.replacement, 'filepicker');
	assert.equal(fieldTypeAt('fields:\n  a:\n    label: textarea', 25), null);
});
