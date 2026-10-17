/**
 * Finds the variables a template uses and those it defines itself, so the server
 * can tell which must come from the controller.
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
 * The PHP code of a template, with the same length: HTML, comments and the
 * text of strings become spaces; variables in double-quoted strings stay
 * @param {string} text
 */
export function phpCode(text) {
	const out = text.split('');
	const blank = (from, to) => {
		for (let i = from; i < to; i++) {
			if (out[i] !== '\n') {
				out[i] = ' ';
			}
		}
	};

	let i = 0;

	while (i < text.length) {
		const open = text.indexOf('<?', i);
		blank(i, open === -1 ? text.length : open);

		if (open === -1) {
			break;
		}

		i = open + (text.startsWith('<?php', open) ? 5 : text.startsWith('<?=', open) ? 3 : 2);
		blank(open, i);

		while (i < text.length && text.startsWith('?>', i) === false) {
			const char = text[i];

			if (char === '/' && text[i + 1] === '/' || char === '#' && text[i + 1] !== '[') {
				const end = text.slice(i).search(/\n|\?>/);
				const stop = end === -1 ? text.length : i + end;
				blank(i, stop);
				i = stop;
			} else if (char === '/' && text[i + 1] === '*') {
				const end = text.indexOf('*/', i + 2);
				const stop = end === -1 ? text.length : end + 2;
				blank(i, stop);
				i = stop;
			} else if (char === '\'' || char === '"') {
				let end = i + 1;

				while (end < text.length && text[end] !== char) {
					end += text[end] === '\\' ? 2 : 1;
				}

				// Keep `$name` in double-quoted strings, but not an escaped `\$`
				for (let j = i; j <= end && j < text.length; j++) {
					const keep = char === '"' && (text[j] === '$' && text[j - 1] !== '\\' || /\w/.test(text[j]) && /\$\w*$/.test(text.slice(i, j)) && /\\\$\w*$/.test(text.slice(i, j)) === false);

					if (keep === false && out[j] !== '\n') {
						out[j] = ' ';
					}
				}

				i = end + 1;
			} else {
				i++;
			}
		}

		blank(i, Math.min(i + 2, text.length));
		i += 2;
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
