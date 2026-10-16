/**
 * Reading positions in blueprints, and completion for `type:`.
 *
 * The server is built for Kirby 6, where sections became fields
 * (https://getkirby.com/releases/6/blueprints).
 */

// Kirby 6 field types (pages, files and users are deprecated aliases)
const FIELD_TYPES = [
	'blocks', 'buttons', 'checkboxes', 'color', 'date', 'email', 'entries', 'filelist', 'filepicker', 'gap',
	'group', 'headline', 'hidden', 'info', 'layout', 'line', 'link', 'list', 'multiselect', 'number',
	'object', 'pagelist', 'pagepicker', 'password', 'radio', 'range', 'select', 'slug', 'stats', 'structure',
	'tags', 'tel', 'text', 'textarea', 'time', 'toggle', 'toggles', 'url', 'userpicker', 'writer',
];

const ALIASES = { files: 'filepicker', pages: 'pagepicker', users: 'userpicker' };

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
			keys.push({ key: trimmed.startsWith('- ') || trimmed === '-' ? '-' : trimmed.split(':')[0].trim(), indent: lineIndent, line: i });
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
