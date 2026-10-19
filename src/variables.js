/**
 * Finds the PHP code in a file (not its HTML), and the variables a template uses
 * and those it defines itself, so the server can tell which must come from the controller.
 *
 * It reads just enough PHP: the code between `<?php`/`<?=` and `?>`, assignments,
 * `foreach … as`, parameters of closures, `catch`, `global`/`static` and the
 * variables functions like `preg_match()` fill. Where variables can't be known
 * (`extract()`, `$$name`, `include`), it gives up.
 */

// Variables PHP itself provides
const BUILT_IN = new Set(['this', 'GLOBALS', '_GET', '_POST', '_COOKIE', '_FILES', '_SERVER', '_ENV', '_REQUEST', '_SESSION', 'argc', 'argv', 'http_response_header']);

// Functions that fill the variables passed to them after the first argument
const FILLING = /\b(?:preg_match|preg_match_all|preg_replace|preg_replace_callback|parse_str|str_replace|str_ireplace|exec|similar_text|sscanf)\s*\(/g;

const VARIABLE = /\$([a-zA-Z_]\w*)/g;

/**
 * @typedef {object} PhpRegion
 * @property {number} start after `<?php` or `<?=`
 * @property {number} end at `?>`, or the end of the file
 * @property {{ start: number, end: number, quote?: string }[]} skipped its comments and strings
 */

/**
 * The PHP parts of a file: from `<?php` or `<?=` to `?>` or the end of the file.
 * A `?>` in a string or block comment doesn't end PHP; in a line comment it does, as in PHP.
 * `<?xml` isn't PHP.
 * @param {string} text
 * @returns {PhpRegion[]}
 */
export function phpRegions(text) {
	const regions = [];
	const opening = /<\?(?:php\b|=)/g;
	let match;

	while ((match = opening.exec(text)) !== null) {
		const start = match.index + match[0].length;
		const skipped = [];
		let i = start;

		while (i < text.length && text.startsWith('?>', i) === false) {
			const char = text[i];
			let stop = i + 1;

			if (char === '/' && text[i + 1] === '/' || char === '#' && text[i + 1] !== '[') {
				const end = text.slice(i).search(/\n|\?>/);
				stop = end === -1 ? text.length : i + end;
				skipped.push({ start: i, end: stop });
			} else if (char === '/' && text[i + 1] === '*') {
				const end = text.indexOf('*/', i + 2);
				stop = end === -1 ? text.length : end + 2;
				skipped.push({ start: i, end: stop });
			} else if (char === '\'' || char === '"') {
				let end = i + 1;

				while (end < text.length && text[end] !== char) {
					end += text[end] === '\\' ? 2 : 1;
				}

				stop = Math.min(end + 1, text.length);
				skipped.push({ start: i, end: stop, quote: char });
			}

			i = stop;
		}

		regions.push({ start, end: i, skipped });
		opening.lastIndex = i + 2;
	}

	return regions;
}

/**
 * Whether an offset is in the PHP code of a file (not in its HTML)
 * @param {string} text
 * @param {number} offset
 */
export function isInPhp(text, offset) {
	return phpRegions(text).some(({ start, end }) => offset >= start && offset <= end);
}

/**
 * A file with everything but its PHP code turned into spaces, with the same length and lines,
 * so that offsets stay the same. Strings and comments are kept.
 * @param {string} text
 */
export function phpOnly(text) {
	const out = text.replace(/[^\n]/g, ' ').split('');

	for (const { start, end } of phpRegions(text)) {
		for (let i = start; i < end; i++) {
			out[i] = text[i];
		}
	}

	return out.join('');
}

/**
 * The PHP code of a template, with the same length: HTML, comments and the
 * text of strings become spaces; variables in double-quoted strings stay
 * @param {string} text
 */
export function phpCode(text) {
	const out = phpOnly(text).split('');

	for (const { skipped } of phpRegions(text)) {
		for (const part of skipped) {
			for (let j = part.start; j < part.end; j++) {
				// Keep `$name` in double-quoted strings, but not an escaped `\$`
				const before = text.slice(part.start, j);
				const keep = part.quote === '"' && (text[j] === '$' && text[j - 1] !== '\\' || /\w/.test(text[j]) && /\$\w*$/.test(before) && /\\\$\w*$/.test(before) === false);

				if (keep === false && out[j] !== '\n') {
					out[j] = ' ';
				}
			}
		}
	}

	return out.join('');
}

/**
 * Lists the variables a template uses that it doesn't define itself, each
 * occurrence with its offsets. Null if that can't be known (`extract()`, `$$name`, `include` …).
 * @param {string} text
 * @returns {{ name: string, start: number, end: number }[] | null}
 */
export function undefinedVariables(text) {
	const code = phpCode(text);

	if (/\bextract\s*\(|\$\$|\$\{|\b(?:include|require)(?:_once)?\b|\beval\s*\(|\bget_defined_vars\s*\(/.test(code) === true) {
		return null;
	}

	const defined = new Set();
	const define = (part) => [...part.matchAll(VARIABLE)].forEach(([, name]) => defined.add(name));

	// $a = …, $a .= …, $a[] = …, $a['b'] = …
	for (const match of code.matchAll(/\$([a-zA-Z_]\w*)\s*(?:\[[^\]]*\]\s*)*(?:=(?![=>])|\.=|\+=|-=|\*=|\/=|%=|\?\?=|&=|\|=|\^=)/g)) {
		defined.add(match[1]);
	}

	// [$a, $b] = … and list($a, $b) = …
	for (const match of code.matchAll(/(?:\[|\blist\s*\()([^=;]*?)(?:\]|\))\s*=(?![=>])/g)) {
		define(match[1]);
	}

	// foreach (… as $key => $value), also as [$a, $b]
	for (const match of code.matchAll(/\bas\s+([^)]*)\)/g)) {
		define(match[1]);
	}

	// Parameters of closures and functions, catch (Exception $e), global and static
	for (const match of code.matchAll(/\b(?:function|fn)\s*&?\s*\w*\s*\(([^)]*)\)|\bcatch\s*\(([^)]*)\)|\b(?:global|static)\s+([^;]*);/g)) {
		define(match[1] ?? match[2] ?? match[3]);
	}

	// Variables filled by preg_match() & co.
	for (const match of code.matchAll(FILLING)) {
		const open = match.index + match[0].length - 1;
		let depth = 0;
		let end = open;

		while (end < code.length && (depth > 0 || end === open)) {
			depth += code[end] === '(' ? 1 : code[end] === ')' ? -1 : 0;
			end++;
		}

		define(code.slice(code.indexOf(',', open) + 1 || end, end));
	}

	return [...code.matchAll(VARIABLE)]
		.filter(([, name]) => defined.has(name) === false && BUILT_IN.has(name) === false)
		.map((match) => ({ name: match[1], start: match.index, end: match.index + match[0].length }));
}
