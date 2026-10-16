/**
 * Just enough PHP reading to find what plugins and the config register,
 * e.g. `'collections' => ['projects' => require __DIR__ . '/collections/projects.php']`.
 * It understands nesting, strings and comments, so `'collections'` inside
 * `'api' => [...]` (API collections, something else) isn't mistaken for Kirby collections.
 */

const OPEN = { '[': ']', '(': ')', '{': '}' };

/**
 * Returns the index after a string, comment or other token starting at `index`,
 * or `index + 1` for anything else
 * @param {string} code
 * @param {number} index
 */
function skipToken(code, index) {
	const char = code[index];

	if (char === '\'' || char === '"') {
		let end = index + 1;

		while (end < code.length && code[end] !== char) {
			end += code[end] === '\\' ? 2 : 1;
		}

		return end + 1;
	}

	if (char === '/' && code[index + 1] === '/' || char === '#' && code[index + 1] !== '[') {
		const end = code.indexOf('\n', index);
		return end === -1 ? code.length : end;
	}

	if (char === '/' && code[index + 1] === '*') {
		const end = code.indexOf('*/', index + 2);
		return end === -1 ? code.length : end + 2;
	}

	return index + 1;
}

/**
 * Removes PHP comments (line comments with `//` or `#`, and block comments) from a piece of code
 * @param {string} code
 */
function withoutComments(code) {
	return code.replace(/\/\/[^\n]*|#(?!\[)[^\n]*|\/\*[\s\S]*?\*\//g, '');
}

/**
 * Returns the index of the bracket closing the one at `index`
 * @param {string} code
 * @param {number} index
 */
export function closingBracket(code, index) {
	const stack = [];

	for (let i = index; i < code.length;) {
		const char = code[i];

		if (OPEN[char] !== undefined) {
			stack.push(OPEN[char]);
		} else if (char === stack.at(-1)) {
			stack.pop();

			if (stack.length === 0) {
				return i;
			}
		}

		i = skipToken(code, i);
	}

	return code.length;
}

/**
 * Lists the string keys of the array that opens at `index` (only its own level)
 * @param {string} code
 * @param {number} index position of `[`
 * @returns {{ key: string, keyStart: number, valueStart: number, valueEnd: number }[]}
 */
export function arrayEntries(code, index) {
	const end = closingBracket(code, index);
	const entries = [];
	let i = index + 1;
	let entryStart = i;

	while (i < end) {
		const char = code[i];

		if (OPEN[char] !== undefined) {
			i = closingBracket(code, i) + 1;
			continue;
		}

		if (char === ',') {
			entryStart = i + 1;
		}

		const next = skipToken(code, i);

		// A quoted key followed by =>
		if ((char === '\'' || char === '"') && withoutComments(code.slice(entryStart, i)).trim() === '') {
			const arrow = code.slice(next).match(/^\s*=>\s*/);

			if (arrow !== null) {
				const valueStart = next + arrow[0].length;
				let valueEnd = valueStart;

				while (valueEnd < end && code[valueEnd] !== ',') {
					valueEnd = OPEN[code[valueEnd]] !== undefined ? closingBracket(code, valueEnd) + 1 : skipToken(code, valueEnd);
				}

				entries.push({ key: code.slice(i + 1, next - 1), keyStart: i, valueStart, valueEnd });
				i = valueEnd;
				continue;
			}
		}

		i = next;
	}

	return entries;
}

/**
 * Finds the array a plugin registers: `App::plugin('site/x', [...])`,
 * or the `extends: [...]` argument when named arguments are used.
 * Returns the index of its `[`, or -1.
 * @param {string} code
 */
export function pluginArray(code) {
	const call = code.search(/::plugin\s*\(/);

	if (call === -1) {
		return -1;
	}

	const open = code.indexOf('(', call);
	const close = closingBracket(code, open);
	const args = code.slice(open, close);
	const named = args.search(/\bextends\s*:\s*\[/);

	if (named !== -1) {
		return open + args.indexOf('[', named);
	}

	// Positional: the first array after the name
	for (let i = open + 1; i < close; i = skipToken(code, i)) {
		if (code[i] === '[') {
			return i;
		}
	}

	return -1;
}

/**
 * Finds the array a config file returns (`return [...]`). Returns the index of its `[`, or -1.
 * @param {string} code
 */
export function returnedArray(code) {
	const match = code.match(/\breturn\s*\[/);
	return match === null ? -1 : match.index + match[0].length - 1;
}

/**
 * Turns an offset into a 0-based line number
 * @param {string} code
 * @param {number} offset
 */
export function lineAt(code, offset) {
	return code.slice(0, offset).split('\n').length - 1;
}

/**
 * Returns the contents of the string literals between `start` and `end`,
 * e.g. `'Projekt'` or a plural list `['', 'Projekt', 'Projekte']`
 * @param {string} code
 * @param {number} start
 * @param {number} end
 * @returns {string[]}
 */
export function stringsIn(code, start, end) {
	const strings = [];

	for (const match of code.slice(start, end).matchAll(/'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"/g)) {
		strings.push((match[1] ?? match[2]).replace(/\\(['"\\])/g, '$1'));
	}

	return strings;
}
