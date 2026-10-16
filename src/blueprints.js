/**
 * Completion for `type:` in blueprints.
 *
 * The lists are fixed, taken from Kirby's Core.php. Kirby 6 turned sections
 * into fields (https://getkirby.com/releases/6/blueprints), so it has one list;
 * Kirby 4 and 5 tell fields and sections apart.
 */

const KIRBY_5_FIELDS = [
	'blocks', 'checkboxes', 'color', 'date', 'email', 'entries', 'files', 'gap', 'group', 'headline',
	'hidden', 'info', 'layout', 'line', 'link', 'list', 'multiselect', 'number', 'object', 'pages',
	'radio', 'range', 'select', 'slug', 'stats', 'structure', 'tags', 'tel', 'text', 'textarea',
	'time', 'toggle', 'toggles', 'url', 'users', 'writer',
];

const KIRBY_5_SECTIONS = ['fields', 'files', 'info', 'pages', 'stats'];

const KIRBY_6_FIELDS = [
	'blocks', 'buttons', 'checkboxes', 'color', 'date', 'email', 'entries', 'filelist', 'filepicker', 'gap',
	'group', 'headline', 'hidden', 'info', 'layout', 'line', 'link', 'list', 'multiselect', 'number',
	'object', 'pagelist', 'pagepicker', 'password', 'radio', 'range', 'select', 'slug', 'stats', 'structure',
	'tags', 'tel', 'text', 'textarea', 'time', 'toggle', 'toggles', 'url', 'userpicker', 'writer',
];

// Deprecated aliases in Kirby 6
const KIRBY_6_ALIASES = { files: 'filepicker', pages: 'pagepicker', users: 'userpicker' };

/**
 * The keys above a line, nearest first, found by indentation.
 * A list item (`- …`) counts as the key `-`.
 * @param {string[]} lines
 * @param {number} from index of the line to start at, going up
 * @param {number} indent only lines indented less than this are parents
 * @param {number} count how many parents to return
 */
function parents(lines, from, indent, count) {
	const keys = [];
	let level = indent;

	for (let i = from; i >= 0 && keys.length < count; i--) {
		const trimmed = lines[i].trimStart();

		if (trimmed === '' || trimmed.startsWith('#')) {
			continue;
		}

		const lineIndent = lines[i].length - trimmed.length;

		if (lineIndent < level) {
			keys.push(trimmed.startsWith('- ') || trimmed === '-' ? '-' : trimmed.split(':')[0].trim());
			level = lineIndent;
		}
	}

	return keys;
}

/**
 * If the cursor is in the value of a `type:` key, returns the part typed so far,
 * where it starts and the key the item sits in (`fields`, `sections`, … or null at the top)
 * @param {string} text
 * @param {number} offset
 * @returns {{ prefix: string, start: number, container: string | null } | null}
 */
export function typeContext(text, offset) {
	const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
	const match = text.slice(lineStart, offset).match(/^(\s*)(-\s+)?type:\s*(["']?)([\w-]*)$/);

	if (match === null) {
		return null;
	}

	const lines = text.slice(0, lineStart).split('\n').slice(0, -1);
	const prefix = match[4];
	let container;

	if (match[2] !== undefined) {
		// `- type: …`: the list item is the field, its parent the container
		container = parents(lines, lines.length - 1, match[1].length, 1)[0] ?? null;
	} else {
		// `type: …` inside a named item: its parent is the container
		const keys = parents(lines, lines.length - 1, match[1].length, 2);
		container = keys.length === 0 ? null : keys[1] ?? null;

		// At the top of a file, the file itself is the field (fields/*.yml) or section
		if (keys.length === 0) {
			container = null;
		} else if (keys.length === 1) {
			container = keys[0] === '-' ? null : '';
		}
	}

	return { prefix, start: offset - prefix.length, container };
}

/**
 * The types to offer for a container in a blueprint file
 * @param {number} major Kirby's major version
 * @param {string | null} container `fields`, `sections`, another key, or null at the top of the file
 * @param {string} file path of the blueprint
 * @returns {{ name: string, kind: 'field' | 'section', replacement?: string }[]}
 */
export function typesFor(major, container, file) {
	const isSectionFile = /[/\\]sections[/\\][^/\\]+\.ya?ml$/.test(file);
	const isSection = container === 'sections' || (container === null && isSectionFile);
	// Table columns take field types, too
	const isField = container === 'fields' || container === 'columns' || (container === null && isSectionFile === false);

	if (major >= 6) {
		if (isField === false && isSection === false) {
			return [];
		}

		return [
			...KIRBY_6_FIELDS.map((name) => ({ name, kind: 'field' })),
			...Object.entries(KIRBY_6_ALIASES).map(([name, replacement]) => ({ name, kind: 'field', replacement })),
		];
	}

	if (isSection === true) {
		return KIRBY_5_SECTIONS.map((name) => ({ name, kind: 'section' }));
	}

	return isField === true ? KIRBY_5_FIELDS.map((name) => ({ name, kind: 'field' })) : [];
}
