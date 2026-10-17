/**
 * Reading positions in blueprints, completion for `type:`, and `extends`.
 *
 * The server is built for Kirby 6, where sections became fields
 * (https://getkirby.com/releases/6/blueprints).
 */

import { isMap, isPair, isScalar, isSeq, parseDocument, visit } from 'yaml';
import properties from './field-properties.json' with { type: 'json' };

// Kirby 6 field types (pages, files and users are deprecated aliases)
const FIELD_TYPES = [
	'blocks', 'buttons', 'checkboxes', 'color', 'date', 'email', 'entries', 'filelist', 'filepicker', 'gap',
	'group', 'headline', 'hidden', 'info', 'layout', 'line', 'link', 'list', 'multiselect', 'number',
	'object', 'pagelist', 'pagepicker', 'password', 'radio', 'range', 'select', 'slug', 'stats', 'structure',
	'tags', 'tel', 'text', 'textarea', 'time', 'toggle', 'toggles', 'url', 'userpicker', 'writer',
];

const ALIASES = { files: 'filepicker', pages: 'pagepicker', users: 'userpicker' };

// In these maps a string value extends a blueprint: `seo: fields/seo`
const SHORTHAND_CONTAINERS = ['fields', 'tabs', 'sections'];

// Types with a page in the field reference (https://getkirby.com/docs/reference/panel/fields)
const DOCUMENTED = new Set([
	'blocks', 'checkboxes', 'color', 'date', 'email', 'entries', 'files', 'gap', 'headline', 'hidden',
	'info', 'layout', 'line', 'link', 'list', 'multiselect', 'number', 'object', 'pages', 'radio', 'range',
	'select', 'slug', 'stats', 'structure', 'tags', 'tel', 'text', 'textarea', 'time', 'toggle', 'toggles',
	'url', 'users', 'writer',
]);

/**
 * @typedef {object} Ancestor
 * @property {string} key the key, or `-` for a list item
 * @property {number} indent
 * @property {number} line 0-based line index
 */

/**
 * The keys above a position, nearest first, found by indentation:
 * each is the next line above that is indented less than the one before.
 * A list item counts as `-`; `- fields:` as `fields` and then `-`.
 * @param {string[]} lines
 * @param {number} from index of the line to start at, going up
 * @param {number} indent only lines indented less than this are parents
 * @returns {Ancestor[]}
 */
export function ancestors(lines, from, indent) {
	const keys = [];
	let level = indent;

	for (let i = from; i >= 0 && level > 0; i--) {
		const trimmed = lines[i].trimStart();

		if (trimmed === '' || trimmed.startsWith('#')) {
			continue;
		}

		const lineIndent = lines[i].length - trimmed.length;

		if (lineIndent < level) {
			const isItem = trimmed.startsWith('- ') || trimmed === '-';

			// `- fields:` is a list item and, two columns further in, a key
			const itemKey = isItem ? trimmed.slice(1).match(/^(\s+)([\w.-]+)\s*:(?:\s|$)/) : null;

			if (itemKey !== null && lineIndent + 1 + itemKey[1].length < level) {
				keys.push({ key: itemKey[2], indent: lineIndent + 1 + itemKey[1].length, line: i });
			}

			keys.push({ key: isItem ? '-' : trimmed.split(':')[0].trim(), indent: lineIndent, line: i });
			level = lineIndent;
		}
	}

	return keys;
}

/**
 * Where the cursor is: the text of its line before it, the lines above and their keys
 * @param {string} text
 * @param {number} offset
 */
export function positionInfo(text, offset) {
	const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
	const lines = text.slice(0, lineStart).split('\n').slice(0, -1);

	return { before: text.slice(lineStart, offset), lines, lineStart };
}

/**
 * If the cursor is in the value of a `type:` key of a field, returns the part
 * typed so far and where it starts
 * @param {string} text
 * @param {number} offset
 * @returns {{ prefix: string, start: number } | null}
 */
export function typeContext(text, offset) {
	const { before, lines } = positionInfo(text, offset);
	const match = before.match(/^(\s*)(-\s+)?type:\s*(["']?)([\w-]*)$/);

	if (match === null) {
		return null;
	}

	// The container is the key above the field: `fields`, or `columns` of a table.
	// For `- type: …` the list item itself is the field.
	const keys = ancestors(lines, lines.length - 1, match[1].length);
	const container = match[2] === undefined ? keys[1] : keys[0];
	const isTopOfFile = keys.length === 0;

	if (isTopOfFile === false && container?.key !== 'fields' && container?.key !== 'columns') {
		return null;
	}

	// A column of the layout (`columns: - width: 1/2`), not a field
	if (container?.key === 'columns' && match[2] === undefined && keys[0]?.key === '-') {
		return null;
	}

	return { prefix: match[4], start: offset - match[4].length };
}

/**
 * The field types to offer, with the replacement of deprecated aliases and a link to the docs
 * @returns {{ name: string, replacement?: string, docs: string }[]}
 */
export function fieldTypes() {
	const docs = (name) => DOCUMENTED.has(name)
		? `https://getkirby.com/docs/reference/panel/fields/${name}`
		: 'https://getkirby.com/releases/6/blueprints';

	return [
		...FIELD_TYPES.map((name) => ({ name, docs: docs(name) })),
		...Object.entries(ALIASES).map(([name, replacement]) => ({ name, replacement, docs: docs(replacement) })),
	];
}

/**
 * Whether a parsed value is a map (not a list)
 * @param {any} value
 * @returns {value is Record<string, any>}
 */
function isObject(value) {
	return value !== null && typeof value === 'object' && Array.isArray(value) === false;
}

/**
 * Merges two maps like Kirby's `A::merge($base, $props, A::MERGE_REPLACE)`:
 * maps are merged key by key, lists are replaced
 * @param {Record<string, any>} base
 * @param {Record<string, any>} props
 */
function merge(base, props) {
	const merged = { ...base };

	for (const [key, value] of Object.entries(props)) {
		merged[key] = isObject(value) && isObject(base[key]) ? merge(base[key], value) : value;
	}

	return merged;
}

/**
 * Merges what a blueprint, tab or field extends into it, like Kirby's
 * `Blueprint::extend()`. A string is a shorthand for `extends: …`.
 * Blueprints that can't be found or read are skipped.
 * @param {any} props
 * @param {(name: string) => Record<string, any> | null} find the content of a blueprint by name
 * @param {Set<string>} [seen] names already followed, against loops
 * @returns {any}
 */
export function extend(props, find, seen = new Set()) {
	if (typeof props === 'string') {
		props = { extends: props };
	}

	if (isObject(props) === false || props.extends === undefined) {
		return props;
	}

	let extended = props;

	for (const name of [props.extends].flat()) {
		const mixin = typeof name === 'string' && seen.has(name) === false ? find(name) : null;

		if (mixin !== null) {
			extended = merge(extend(mixin, find, new Set([...seen, name])), extended);
		}
	}

	const result = { ...extended };
	delete result.extends;

	return result;
}

/**
 * Whether the key at `index` holds fields, tabs or sections. Names and props alternate:
 * in `sections: { fields: { type: fields } }` the inner `fields` is the name of a section.
 * @param {Ancestor[]} keys nearest first
 * @param {number} index
 * @returns {boolean}
 */
function isContainer(keys, index) {
	return SHORTHAND_CONTAINERS.includes(keys[index]?.key) === true && isContainer(keys, index + 1) === false;
}

/**
 * The folder of blueprints that fits what extends: `fields` for a field, `tabs` for a tab …,
 * null at the top of a blueprint
 * @param {Ancestor[]} keys nearest first
 * @param {number} index of the key above the field, tab or section
 */
function folderOf(keys, index) {
	return isContainer(keys, index) === true ? keys[index].key : null;
}

/**
 * If the cursor is where a blueprint name goes, returns the part typed so far,
 * where it starts and the folder of blueprints that fits (see `folderOf`):
 * `extends: ▮`, a list item below `extends:`, or the shorthand `seo: ▮` in `fields`, `tabs` and `sections`
 * @param {string} text
 * @param {number} offset
 * @returns {{ prefix: string, start: number, folder: string | null } | null}
 */
export function extendsContext(text, offset) {
	const { before, lines } = positionInfo(text, offset);
	const result = (match, folder) => ({ prefix: match.at(-1), start: offset - match.at(-1).length, folder });
	const last = lines.length - 1;

	const extendsKey = before.match(/^(\s*)(-\s+)?extends:\s*(["']?)([\w./-]*)$/);

	if (extendsKey !== null) {
		const keys = ancestors(lines, last, extendsKey[1].length);
		return result(extendsKey, folderOf(keys, extendsKey[2] === undefined ? 1 : 0));
	}

	const item = before.match(/^(\s*)-\s+(["']?)([\w./-]*)$/);

	if (item !== null) {
		const keys = ancestors(lines, last, item[1].length);
		// keys: extends, the field (or tab …), its container
		return keys[0]?.key === 'extends' ? result(item, folderOf(keys, 2)) : null;
	}

	const shorthand = before.match(/^(\s*)[\w-]+:\s+(["']?)([\w./-]*)$/);

	if (shorthand !== null) {
		const folder = folderOf(ancestors(lines, last, shorthand[1].length), 0);
		return folder === null ? null : result(shorthand, folder);
	}

	return null;
}

/**
 * Whether the map at the end of a path (from yaml's `visit`) holds fields, tabs or sections,
 * with names and props alternating as in `isContainer`
 * @param {readonly any[]} path
 */
function isContainerMap(path) {
	let container = false;

	for (let i = 1; i < path.length; i++) {
		if (isMap(path[i]) === true) {
			const pair = path[i - 1];
			const parentIsContainer = container && isMap(path[i - 2]) === true;
			container = isPair(pair) === true && isScalar(pair.key) === true && SHORTHAND_CONTAINERS.includes(pair.key.value) === true && parentIsContainer === false;
		}
	}

	return container;
}

/**
 * @typedef {object} Reference
 * @property {string} name the blueprint
 * @property {number} start
 * @property {number} end
 * @property {boolean} shorthand whether it's a string value in `fields`, `tabs` or `sections`
 */

/**
 * Finds the blueprint names a blueprint extends: values of `extends`
 * (also lists) and the shorthand `seo: fields/seo` in `fields`, `tabs` and `sections`
 * @param {string} text
 * @returns {Reference[]}
 */
export function blueprintReferences(text) {
	const document = parseDocument(text, { uniqueKeys: false, logLevel: 'silent' });
	const references = [];

	const add = (node, shorthand) => {
		if (isScalar(node) === true && typeof node.value === 'string' && node.value !== '' && node.range !== undefined) {
			const start = node.range[0] + (node.type === 'QUOTE_DOUBLE' || node.type === 'QUOTE_SINGLE' ? 1 : 0);
			references.push({ name: node.value, start, end: start + node.value.length, shorthand });
		}
	};

	visit(document, {
		Pair(_, pair, path) {
			if (isScalar(pair.key) === true && pair.key.value === 'extends') {
				(isSeq(pair.value) === true ? pair.value.items : [pair.value]).forEach((node) => add(node, false));
			} else if (isContainerMap(path) === true) {
				add(pair.value, true);
			}
		},
	});

	return references;
}

/**
 * The blueprint name at the cursor, if there is one
 * @param {string} text
 * @param {number} offset
 */
export function referenceAt(text, offset) {
	return blueprintReferences(text).find(({ start, end }) => offset >= start && offset <= end) ?? null;
}

/**
 * Whether a name is a Kirby 6 field type (or a deprecated alias)
 * @param {string} name
 */
export function isFieldType(name) {
	return FIELD_TYPES.includes(name) === true || ALIASES[name] !== undefined;
}

// Where a field takes template names: field type → key → folder of the blueprints
const TEMPLATE_KEYS = {
	pagelist: { create: 'pages', template: 'pages', templates: 'pages', templatesIgnore: 'pages' },
	filelist: { template: 'files' },
	filepicker: { uploads: 'files' },
	textarea: { uploads: 'files' },
};

// Sections are a legacy shortcut for these fields (Kirby 6's Normalizer::$sectionFields)
const SECTION_TYPES = { pages: 'pagelist', files: 'filelist' };

/**
 * @typedef {object} TemplateSlot
 * @property {string | null} name null where nothing is typed yet
 * @property {number} start
 * @property {number} end
 * @property {'pages' | 'files'} folder whose blueprints the names refer to
 */

/**
 * The Kirby 6 field type of a map in a blueprint: its `type`, the type of what it
 * extends, or its name. In `sections`, `pages` and `files` are the list fields.
 * @param {any} map
 * @param {readonly any[]} path from yaml's `visit`, ending with the map
 * @param {(name: string) => Record<string, any> | null} find
 */
function fieldTypeOf(map, path, find) {
	const item = path.at(-2);
	const name = isPair(item) === true && isScalar(item.key) === true ? item.key.value : null;
	const props = extend(map.toJSON(), find);
	const type = isObject(props) === true && typeof props.type === 'string' ? props.type : name;
	const container = path.at(-4);

	if (isPair(container) === true && isScalar(container.key) === true && container.key.value === 'sections' && SECTION_TYPES[type] !== undefined) {
		return SECTION_TYPES[type];
	}

	return ALIASES[type] ?? type;
}

/**
 * Finds where a blueprint names templates: `template`, `templates`, `templatesIgnore`
 * and `create` of a `pagelist`, `template` of a `filelist`, `uploads` of a `filepicker`
 * or `textarea`, and `options: changeTemplate` (templates of the blueprint's own kind)
 * @param {string} text
 * @param {(name: string) => Record<string, any> | null} find the content of a blueprint by name, for `extends`
 * @param {'pages' | 'files'} [own] whether the blueprint is for pages or files
 * @returns {TemplateSlot[]}
 */
export function templateSlots(text, find, own = 'pages') {
	const document = parseDocument(text, { uniqueKeys: false, logLevel: 'silent' });
	const slots = [];
	const types = new Map();

	const add = (node, folder) => {
		if (isScalar(node) === true && node.range !== undefined && (node.value === null || typeof node.value === 'string')) {
			const start = node.range[0] + (node.type === 'QUOTE_DOUBLE' || node.type === 'QUOTE_SINGLE' ? 1 : 0);
			slots.push({ name: node.value, start, end: start + (node.value ?? '').length, folder });
		}
	};

	const addAll = (node, folder) => (isSeq(node) === true ? node.items : [node]).forEach((item) => add(item, folder));

	visit(document, {
		Pair(_, pair, path) {
			const key = isScalar(pair.key) === true ? pair.key.value : null;
			const map = path.at(-1);
			const options = path.at(-2);

			// options: changeTemplate (or its alias template) at the top of the blueprint
			if (path.length === 4 && isPair(options) === true && isScalar(options.key) === true && options.key.value === 'options') {
				if (key === 'changeTemplate' || key === 'template') {
					addAll(pair.value, own);
				}

				return;
			}

			if (types.has(map) === false) {
				types.set(map, fieldTypeOf(map, path, find));
			}

			const folder = TEMPLATE_KEYS[types.get(map)]?.[key];

			if (folder === undefined) {
				return;
			}

			if (key === 'uploads' && isMap(pair.value) === true) {
				add(pair.value.get('template', true), folder);
			} else {
				addAll(pair.value, folder);
			}
		},
	});

	return slots;
}

// A group isn't a field class: Kirby's Normalizer puts its fields in its place and passes `when` on to them
const GROUP = [
	{ name: 'fields', type: 'array', description: 'The fields of the group, shown as if they were its siblings' },
	{ name: 'when', type: 'array|null', description: 'Shows the fields of the group only when the conditions are met' },
];

/**
 * @typedef {object} FieldProperty
 * @property {string} name
 * @property {string} type PHP type, e.g. `string|null`
 * @property {string} [default]
 * @property {string} [description]
 */

/**
 * The options of a Kirby 6 field type (read from Kirby's source by scripts/field-properties.mjs)
 * @param {string} type
 * @returns {FieldProperty[] | null}
 */
export function fieldProperties(type) {
	return type === 'group' ? GROUP : properties.fields[ALIASES[type] ?? type] ?? null;
}

/**
 * If the cursor is where a key of a field goes (a line with nothing but the start
 * of a key), returns the part typed so far, where it starts, the field's name,
 * its `type` and `extends` if set, and the keys it already has
 * @param {string} text
 * @param {number} offset
 * @returns {{ prefix: string, start: number, name: string, type?: string, extends?: string, present: string[] } | null}
 */
export function propertyContext(text, offset) {
	const { before, lines } = positionInfo(text, offset);
	const match = before.match(/^( +)([\w-]*)$/);

	if (match === null) {
		return null;
	}

	// keys: the field, then `fields`
	const indent = match[1].length;
	const keys = ancestors(lines, lines.length - 1, indent);

	if (keys[0] === undefined || keys[0].key === '-' || keys[1]?.key !== 'fields' || isContainer(keys, 1) === false) {
		return null;
	}

	// The field's other keys, above and below the cursor
	const all = text.split('\n');
	const own = [];

	for (let i = keys[0].line + 1; i < all.length; i++) {
		const trimmed = all[i].trimStart();
		const lineIndent = all[i].length - trimmed.length;

		if (i === lines.length || trimmed === '' || trimmed.startsWith('#')) {
			continue;
		}

		if (lineIndent <= keys[0].indent) {
			break;
		}

		if (lineIndent === indent) {
			own.push(trimmed);
		}
	}

	const value = (key) => own.map((line) => line.match(new RegExp(`^${key}:\\s*["']?([\\w./-]+)`))?.[1]).find((found) => found !== undefined);

	return {
		prefix: match[2],
		start: offset - match[2].length,
		name: keys[0].key,
		type: value('type'),
		extends: value('extends'),
		present: own.map((line) => line.match(/^([\w-]+)\s*:/)?.[1]).filter((key) => key !== undefined),
	};
}

// Fields that show something but store no content, so `$page->name()` has nothing to return
const DISPLAY_TYPES = new Set(['buttons', 'filelist', 'gap', 'headline', 'info', 'line', 'pagelist', 'stats']);

/**
 * @typedef {object} BlueprintField
 * @property {string} name
 * @property {string} type
 * @property {string} [label]
 */

/**
 * The fields of a blueprint that store content: those defined at the top, in tabs,
 * columns and `fields` sections, with `extends` followed and groups unwrapped.
 * Lists, info and other fields that store nothing are left out.
 * @param {Record<string, any>} blueprint
 * @param {(name: string) => Record<string, any> | null} find the content of a blueprint by name, for `extends`
 * @returns {BlueprintField[]}
 */
export function blueprintFields(blueprint, find) {
	const fields = new Map();

	const label = (value) => typeof value === 'string' ? value : isObject(value) ? Object.values(value).find((text) => typeof text === 'string') : undefined;

	const add = (name, props) => {
		const type = typeof props.type === 'string' ? props.type : name;

		if (type === 'group') {
			walkFields(props.fields);
		} else if (DISPLAY_TYPES.has(ALIASES[type] ?? type) === false && fields.has(name) === false) {
			fields.set(name, { name, type, label: label(props.label) });
		}
	};

	// A map of fields, or a list (names of fields defined at the top, or props with a name)
	function walkFields(list) {
		if (Array.isArray(list) === true) {
			list.filter((item) => isObject(item) && typeof item.name === 'string').forEach((item) => add(item.name, extend(item, find)));
			return;
		}

		for (const [name, props] of Object.entries(isObject(list) ? list : {})) {
			const field = props === true || props === null ? {} : extend(props, find);

			if (isObject(field) === true) {
				add(name, field);
			}
		}
	}

	// Tabs, columns and sections, which hold fields
	function walkLayout(node) {
		if (isObject(node) === false) {
			return;
		}

		walkFields(node.fields);
		Object.values(isObject(node.tabs) ? node.tabs : {}).forEach((tab) => walkLayout(extend(tab, find)));
		Object.values(node.columns ?? {}).forEach((column) => walkLayout(column));

		for (const [name, section] of Object.entries(isObject(node.sections) ? node.sections : {})) {
			const props = extend(section === true ? {} : section, find);

			if (isObject(props) === true && (props.type ?? name) === 'fields') {
				walkFields(props.fields);
			}
		}
	}

	walkLayout(extend(blueprint, find));

	return [...fields.values()];
}
