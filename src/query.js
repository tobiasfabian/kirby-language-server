/**
 * Kirby's query language in blueprints: where a query is (`query: page.children`,
 * `{{ page.title }}`), which chain of names leads to the cursor, and what each name
 * in it returns. The methods and their types are read from Kirby 6's source by
 * scripts/read-kirby.mjs into src/query-classes.json.
 */

import data from './query-classes.json' with { type: 'json' };

// Keys whose value is a query (also `query:` of `image:` and of `options:`)
const QUERY_KEYS = ['query', 'parent', 'fetch'];

// Methods that change content, which don't belong in a query
const MUTATING = /^(?:create|update|delete|change|save|publish|unpublish|duplicate|increment|decrement|purge|lock|unlock|regenerate|set[A-Z])|^(?:copy|move|clone)$/;

/**
 * @typedef {object} QueryType
 * @property {string} cls a query class, e.g. `Pages`
 * @property {string[] | null} [blueprints] for pages, files, users and the site: whose fields they have
 */

/**
 * If the cursor is in a query, returns the query up to the cursor and whether it's
 * in a string template (`{{ … }}` or `{< … >}`) rather than the value of `query:`, `parent:` or `fetch:`
 * @param {string} text
 * @param {number} offset
 * @returns {{ expression: string, template: boolean } | null}
 */
export function queryContext(text, offset) {
	const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
	const before = text.slice(lineStart, offset);
	const open = Math.max(before.lastIndexOf('{{'), before.lastIndexOf('{<'));

	if (open !== -1 && /\}\}|>\}/.test(before.slice(open)) === false) {
		return { expression: before.slice(open + 2), template: true };
	}

	const value = before.match(new RegExp(`^\\s*(?:-\\s+)?(?:${QUERY_KEYS.join('|')}):\\s*["']?(.*)$`));
	return value === null ? null : { expression: value[1], template: false };
}

/**
 * The chain of names that ends at the cursor: `site.find("notes").children.fil` gives
 * `site`, `find`, `children` and the prefix `fil`. Arguments in brackets are skipped,
 * and `?.` counts like `.`. Null in a string, where nothing is completed.
 * @param {string} expression the query up to the cursor
 * @returns {{ names: string[], args: (string | null)[], prefix: string } | null} no names: the cursor is
 *   at the start of a chain; `args` holds the arguments of each name (null without brackets)
 */
export function chainAt(expression) {
	// In an open string (e.g. kirby.collection("…), other completion applies
	let quote = null;

	for (let i = 0; i < expression.length; i++) {
		if (quote !== null && expression[i] === '\\') {
			i++;
		} else if (quote !== null && expression[i] === quote) {
			quote = null;
		} else if (quote === null && (expression[i] === '"' || expression[i] === '\'')) {
			quote = expression[i];
		}
	}

	if (quote !== null) {
		return null;
	}

	const prefix = expression.match(/\w*$/)[0];
	const names = [];
	const args = [];
	let i = expression.length - prefix.length;

	while (expression[i - 1] === '.') {
		i -= expression[i - 2] === '?' ? 2 : 1;

		// Skip the arguments of a call: find the bracket that opens them
		let call = null;

		if (expression[i - 1] === ')') {
			const close = i - 1;
			let depth = 0;

			for (i -= 1; i >= 0; i--) {
				depth += expression[i] === ')' ? 1 : expression[i] === '(' ? -1 : 0;

				if (depth === 0) {
					break;
				}
			}

			call = expression.slice(i + 1, close);
		}

		const name = expression.slice(0, i).match(/(?<![\w])[A-Za-z_]\w*$/)?.[0];

		if (name === undefined) {
			return null;
		}

		names.unshift(name);
		args.unshift(call);
		i -= name.length;
	}

	// A name right before the chain (e.g. `1.5`) isn't a chain start
	return /[\w.]$/.test(expression.slice(0, i)) === true ? null : { names, args, prefix };
}

/**
 * The query class a type name is, e.g. `Pages` for `?\Kirby\Cms\Pages`
 * @param {string | undefined} type
 * @returns {string | null}
 */
export function classOf(type) {
	const name = (type ?? '').split('|').map((part) => part.replace(/^\?/, '').split('\\').pop()).find((part) => part !== '' && part !== 'null');
	return name !== undefined && data.classes[name] !== undefined ? name : null;
}

/**
 * The methods of a query class that make sense in a query (no `update`, `delete` …)
 * @param {string} cls
 * @returns {{ name: string, params: string, returns?: string, type: string | null, description?: string }[]}
 */
export function queryMethods(cls) {
	return (data.classes[cls] ?? []).filter(({ name }) => MUTATING.test(name) === false);
}

/**
 * Whether a query class has content fields (`page.title`, `block.text`): unknown names are fields
 * @param {string} cls
 */
export function hasFields(cls) {
	return ['Page', 'Site', 'File', 'User', 'Block', 'StructureObject'].includes(cls);
}

/**
 * The name under the cursor in a query (`page.chil▮dren`), with the chain before it
 * @param {string} text
 * @param {number} offset
 * @returns {{ names: string[], args: (string | null)[], name: string, start: number, end: number, template: boolean } | null}
 */
export function queryNameAt(text, offset) {
	const end = offset + text.slice(offset).match(/^\w*/)[0].length;
	const context = queryContext(text, end);
	const chain = context === null ? null : chainAt(context.expression);

	if (chain === null || chain.prefix === '') {
		return null;
	}

	return { names: chain.names, args: chain.args, name: chain.prefix, start: end - chain.prefix.length, end, template: context.template };
}
