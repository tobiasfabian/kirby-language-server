/**
 * Finds `snippet()`, `collection()`, translation calls (`t()`, `tt()`, `tc()`),
 * file paths (`hashedUrl()`, `url()`, `asset()`, `svg()`, `css()`, `js()`)
 * and template names (`->template()`, `->notTemplate()`, `->changeTemplate()`,
 * `filterBy('template', …)`) in PHP code and blueprints.
 *
 * Only literal names count: `snippet('m-card')`, the fallback form
 * `snippet(['m-card-project', 'm-card'])`, `collection('projects')`
 * (also `$kirby->collection('…')` and `kirby.collection("…")` in queries),
 * `t('project.completed')` and `svg('assets/images/logo.svg')`.
 * Names built at runtime, like `snippet('blocks/' . $block->type())`, are left alone.
 */

/** @typedef {'snippet' | 'collection' | 'translation' | 'asset' | 'template'} Kind */

// `filterBy('template', 'in', [...])` has no group for the function
const CALL = /\b(snippet|collection|t|tt|tc|hashedUrl|url|asset|svg|css|js|template|notTemplate|changeTemplate)\(\s*|\b(?:filterBy|filter)\(\s*(['"])(?:template|intendedTemplate)\2\s*,\s*(?:(['"])(?:==|!=|in|not in)\3\s*,\s*)?/g;

// The part of a line before the cursor, when the cursor is in a name; `list` allows `['a', 'b', '`
const LIST = String.raw`(?:\[\s*(?:['"][\w./-]*['"]\s*,\s*)*)?`;
const CONTEXTS = [
	new RegExp(String.raw`\b(?<fn>snippet)\(\s*${LIST}['"](?<prefix>[\w./-]*)$`),
	/\b(?<fn>collection|t|tt|tc)\(\s*['"](?<prefix>[\w./:-]*)$/,
	/\b(?<fn>hashedUrl|url|asset|svg|css|js)\(\s*['"](?<prefix>[\w./@-]*)$/,
	new RegExp(String.raw`(?:->|\.)(?<fn>template|notTemplate|changeTemplate)\(\s*${LIST}['"](?<prefix>[\w./-]*)$`),
	new RegExp(String.raw`\b(?<fn>filterBy|filter)\(\s*(['"])(?:template|intendedTemplate)\2\s*,\s*(?:(['"])(?:==|!=|in|not in)\3\s*,\s*)?${LIST}['"](?<prefix>[\w./-]*)$`),
];
const NAME_CHARACTERS = /[\w./:@-]/;
const KINDS = {
	snippet: 'snippet',
	collection: 'collection',
	t: 'translation',
	tt: 'translation',
	tc: 'translation',
	// Paths to files in the docroot
	hashedUrl: 'asset',
	url: 'asset',
	asset: 'asset',
	svg: 'asset',
	css: 'asset',
	js: 'asset',
	// Page or file templates
	template: 'template',
	notTemplate: 'template',
	changeTemplate: 'template',
	filterBy: 'template',
	filter: 'template',
};

/**
 * Whether the path of a file call can be checked: not a URL or `@auto`,
 * not in `media/` (Kirby creates those files on demand), and for `url()` only in `assets/`
 * @param {string} fn
 * @param {string} name
 */
function isFilePath(fn, name) {
	const file = name.replace(/^\//, '');

	if (/^[\w-]+:|^\/\/|^@/.test(name) === true || file.startsWith('media/') === true) {
		return false;
	}

	return fn !== 'url' || file.startsWith('assets/');
}

/**
 * Reads a quoted name starting at `index`. Returns null if there is none.
 * @param {string} text
 * @param {number} index
 */
function readName(text, index) {
	const quote = text[index];

	if (quote !== '\'' && quote !== '"') {
		return null;
	}

	let end = index + 1;

	while (end < text.length && NAME_CHARACTERS.test(text[end])) {
		end++;
	}

	if (text[end] !== quote || end === index + 1) {
		return null;
	}

	return { name: text.slice(index + 1, end), start: index + 1, end, next: end + 1 };
}

/**
 * Skips spaces and line breaks
 * @param {string} text
 * @param {number} index
 */
function skipSpace(text, index) {
	while (index < text.length && /\s/.test(text[index])) {
		index++;
	}

	return index;
}

/**
 * Returns every call with literal names, with the offsets of each name.
 * `fn` is the function called, `more` whether more arguments follow the name
 * (for `t()` and `tt()` a fallback text).
 * @param {string} text
 * @returns {{ kind: Kind, fn: string, more: boolean, names: { name: string, start: number, end: number }[] }[]}
 */
export function findCalls(text) {
	const calls = [];

	for (const match of text.matchAll(CALL)) {
		const fn = match[1] ?? 'filterBy';
		const kind = /** @type {Kind} */ (KINDS[fn]);
		let index = match.index + match[0].length;
		const names = [];

		// Template methods are called on pages or files (`->template(`, `.template(` in queries), not `I18n::template(`
		if (kind === 'template' && fn !== 'filterBy' && /(?:->|\.)$/.test(text.slice(0, match.index)) === false) {
			continue;
		}

		// snippet() takes a list of fallbacks, template() a list of templates
		if ((kind === 'snippet' || kind === 'template') && text[index] === '[') {
			index = skipSpace(text, index + 1);

			while (index < text.length) {
				const name = readName(text, index);

				if (name === null) {
					break;
				}

				names.push(name);
				index = skipSpace(text, name.next);

				if (text[index] === ',') {
					index = skipSpace(text, index + 1);
				}

				if (text[index] === ']') {
					index++;
					break;
				}
			}

			if (text[index - 1] !== ']') {
				continue;
			}
		} else {
			const name = readName(text, index);

			if (name === null || (kind === 'asset' && isFilePath(fn, name.name) === false)) {
				continue;
			}

			names.push(name);
			index = name.next;
		}

		// A name followed by `.` is built at runtime
		const after = text[skipSpace(text, index)];

		if (names.length > 0 && (after === ',' || after === ')')) {
			calls.push({ kind, fn, more: after === ',', names: names.map(({ name, start, end }) => ({ name, start, end })) });
		}
	}

	return calls;
}

/**
 * If the cursor is inside a name, returns what kind of name it is,
 * the part before the cursor and where it starts
 * @param {string} text
 * @param {number} offset
 * @returns {{ kind: Kind, fn: string, prefix: string, start: number } | null}
 */
export function completionContext(text, offset) {
	const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
	const before = text.slice(lineStart, offset);
	const match = CONTEXTS.map((pattern) => before.match(pattern)).find((found) => found !== null);

	if (match === undefined) {
		return null;
	}

	const { fn, prefix } = match.groups;

	return { kind: KINDS[fn], fn, prefix, start: offset - prefix.length };
}

/**
 * Returns the name at the cursor, if there is one
 * @param {string} text
 * @param {number} offset
 * @returns {{ kind: Kind, name: string, start: number, end: number } | null}
 */
export function nameAt(text, offset) {
	for (const call of findCalls(text)) {
		for (const name of call.names) {
			if (offset >= name.start && offset <= name.end) {
				return { kind: call.kind, ...name };
			}
		}
	}

	return null;
}

/**
 * If the cursor is in a key of the data array of a snippet call,
 * `snippet('m-card', ['si▮` or `snippet('m-card', data: ['si▮`,
 * returns the snippet names, the part of the key typed so far and where it starts
 * @param {string} text
 * @param {number} offset
 * @returns {{ names: string[], prefix: string, start: number } | null}
 */
export function propsContext(text, offset) {
	let result = null;

	for (const match of text.slice(0, offset).matchAll(/\bsnippet\(\s*/g)) {
		const call = findCalls(text.slice(match.index)).at(0);

		if (call === undefined || call.kind !== 'snippet' || call.more === false) {
			continue;
		}

		// After the names: `, [` or `, data: [`
		const afterNames = match.index + call.names.at(-1).end + 1 + (text[match.index + call.names.at(-1).end + 1] === ']' ? 1 : 0);
		const array = text.slice(afterNames, offset).match(/^\s*,\s*(?:data\s*:\s*)?\[/);

		if (array === null) {
			continue;
		}

		const open = afterNames + array[0].length - 1;
		let depth = 0;
		let separator = open + 1;
		let quote = null;
		let stringStart = -1;
		let closed = false;

		for (let i = open + 1; i < offset; i++) {
			const char = text[i];

			if (quote !== null) {
				if (char === '\\') {
					i++;
				} else if (char === quote) {
					quote = null;
				}

				continue;
			}

			if (char === '\'' || char === '"') {
				quote = char;
				stringStart = i;
			} else if ('[({'.includes(char)) {
				depth++;
			} else if (')]}'.includes(char)) {
				if (depth === 0) {
					closed = true;
					break;
				}

				depth--;
			} else if (char === ',' && depth === 0) {
				separator = i + 1;
			}
		}

		// Inside an open string at the array's own level, right at the start of an entry
		if (closed === false && quote !== null && depth === 0 && text.slice(separator, stringStart).trim() === '') {
			const prefix = text.slice(stringStart + 1, offset);

			if (/^[\w-]*$/.test(prefix) === true) {
				result = { names: call.names.map(({ name }) => name), prefix, start: stringStart + 1 };
			}
		}
	}

	return result;
}

/**
 * If the cursor is after `$page->`, `$site->`, `$block->` or `$this->`, returns
 * the variable, the part of the name typed so far, where the name starts and ends
 * (the rest of a name after the cursor included), and whether `(` follows it
 * @param {string} text
 * @param {number} offset
 * @returns {{ variable: 'page' | 'site' | 'block' | 'this', prefix: string, start: number, end: number, call: boolean } | null}
 */
export function fieldContext(text, offset) {
	const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
	const match = text.slice(lineStart, offset).match(/\$(page|site|block|this)\s*->\s*(\w*)$/);

	if (match === null) {
		return null;
	}

	const end = offset + text.slice(offset).match(/^\w*/)[0].length;

	return { variable: /** @type {any} */ (match[1]), prefix: match[2], start: offset - match[2].length, end, call: text[end] === '(' };
}
