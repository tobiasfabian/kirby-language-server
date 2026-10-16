/**
 * Finds `snippet()`, `collection()` and translation calls (`t()`, `tt()`, `tc()`)
 * in PHP code and blueprints.
 *
 * Only literal names count: `snippet('m-card')`, the fallback form
 * `snippet(['m-card-project', 'm-card'])`, `collection('projects')`
 * (also `$kirby->collection('…')` and `kirby.collection("…")` in queries)
 * and `t('project.completed')`.
 * Names built at runtime, like `snippet('blocks/' . $block->type())`, are left alone.
 */

/** @typedef {'snippet' | 'collection' | 'translation'} Kind */

const CALL = /\b(snippet|collection|t|tt|tc)\(\s*/g;
const NAME_CHARACTERS = /[\w./:-]/;
const KINDS = { snippet: 'snippet', collection: 'collection', t: 'translation', tt: 'translation', tc: 'translation' };

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
		const fn = match[1];
		const kind = /** @type {Kind} */ (KINDS[fn]);
		let index = match.index + match[0].length;
		const names = [];

		// Only snippet() takes a list of fallbacks
		if (kind === 'snippet' && text[index] === '[') {
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

			if (name === null) {
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
 * @returns {{ kind: Kind, prefix: string, start: number } | null}
 */
export function completionContext(text, offset) {
	const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
	const before = text.slice(lineStart, offset);
	const match = before.match(/\bsnippet\(\s*(?:\[\s*(?:(['"])[\w./-]*\1\s*,\s*)*)?(['"])([\w./-]*)$/)
		?? before.match(/\b(collection|t|tt|tc)\(\s*(['"])([\w./:-]*)$/);

	if (match === null) {
		return null;
	}

	const prefix = match[3];

	return { kind: KINDS[match[1]] ?? 'snippet', prefix, start: offset - prefix.length };
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
