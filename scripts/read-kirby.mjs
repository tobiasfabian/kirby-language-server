/**
 * Reads from Kirby 6's source what the server offers:
 *
 * - src/field-properties.json: the options of each field type. The options of a
 *   field are the parameters of its class's constructor and those of its parents;
 *   their descriptions and defaults come from the properties of the same name
 *   (in the classes or their mixins).
 * - src/field-methods.json: the field methods (`toFile()`, `kirbytext()` …)
 *   from the `FieldMethods` trait.
 *
 *   node scripts/read-kirby.mjs path/to/kirby
 */

import fs from 'node:fs';
import path from 'node:path';

const kirby = process.argv[2];

if (kirby === undefined || fs.existsSync(path.join(kirby, 'src', 'Form', 'Field')) === false) {
	console.error('Usage: node scripts/read-kirby.mjs path/to/kirby (Kirby 6)');
	process.exit(1);
}

const src = path.join(kirby, 'src');
const read = (file) => fs.readFileSync(file, 'utf8');

/**
 * Splits code at commas that aren't inside brackets or strings
 * @param {string} code
 */
function splitTopLevel(code) {
	const parts = [];
	let depth = 0;
	let quote = null;
	let start = 0;

	for (let i = 0; i < code.length; i++) {
		const char = code[i];

		if (quote !== null) {
			if (char === '\\') {
				i++;
			} else if (char === quote) {
				quote = null;
			}
		} else if (char === '\'' || char === '"') {
			quote = char;
		} else if ('([{'.includes(char)) {
			depth++;
		} else if (')]}'.includes(char)) {
			depth--;
		} else if (char === ',' && depth === 0) {
			parts.push(code.slice(start, i));
			start = i + 1;
		}
	}

	parts.push(code.slice(start));

	return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/**
 * The text of a docblock without stars and tags
 * @param {string} docblock
 */
function description(docblock) {
	return docblock
		.split('\n')
		.map((line) => line.replace(/^\s*\*\s?/, '').trim())
		.filter((line) => line !== '' && line.startsWith('@') === false)
		.join(' ');
}

/**
 * The file of a class or trait of Kirby\Form
 * @param {string} name
 */
function fileOf(name) {
	return [
		path.join(src, 'Form', 'Field', name + '.php'),
		path.join(src, 'Form', name + '.php'),
		path.join(src, 'Form', 'Mixin', name + '.php'),
	].find((file) => fs.existsSync(file)) ?? null;
}

/**
 * Reads a class or trait: its parent, traits, constructor parameters and properties
 * @param {string} name
 */
function parse(name) {
	const file = fileOf(name);

	if (file === null) {
		return { parent: null, traits: [], params: [], properties: new Map() };
	}

	const code = read(file);
	const constructor = code.match(/function __construct\(([\s\S]*?)\)\s*\{/)?.[1] ?? '';
	const params = splitTopLevel(constructor)
		.filter((param) => param.includes('...') === false)
		.map((param) => param.match(/^(?:#\[[^\]]*\]\s*)*(?:(?:public|protected|private)\s+)?([^\s$]+)\s+\$(\w+)(?:\s*=\s*(.+))?$/s))
		.filter((match) => match !== null)
		.map(([, type, param, value]) => ({ name: param, type, default: value?.trim() }));

	const properties = new Map();
	const declaration = /(?:\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*)?(?:#\[[^\]]*\]\s*)*(?:protected|public)\s+(?:static\s+)?[^\s$(]+\s+\$(\w+)(?:\s*=\s*([^;]+))?;/g;

	for (const [, docblock, property, value] of code.matchAll(declaration)) {
		properties.set(property, { description: docblock === undefined ? '' : description(docblock), default: value?.trim() });
	}

	return {
		parent: code.match(/\bclass\s+\w+\s+extends\s+(\w+)/)?.[1] ?? null,
		traits: [...code.matchAll(/^\s*use\s+(?:Mixin\\)?(\w+);/gm)].map(([, trait]) => trait),
		params,
		properties,
	};
}

/**
 * The properties of a class and its traits (and theirs)
 * @param {ReturnType<typeof parse>} parsed
 * @param {Map<string, { description: string, default?: string }>} into
 */
function collectProperties(parsed, into) {
	for (const [name, property] of parsed.properties) {
		const known = into.get(name);

		// A subclass may only set the default; the description is in the parent or a mixin
		into.set(name, {
			description: known?.description || property.description,
			default: known?.default ?? property.default,
		});
	}

	for (const trait of parsed.traits) {
		collectProperties(parse(trait), into);
	}
}

/**
 * The options of a field class: its constructor parameters, then those of its parents
 * @param {string} name
 */
function optionsOf(name) {
	const options = [];
	const properties = new Map();

	for (let current = name; current !== null;) {
		const parsed = parse(current);
		collectProperties(parsed, properties);

		for (const param of parsed.params) {
			if (param.name !== 'name' && options.some((option) => option.name === param.name) === false) {
				options.push(param);
			}
		}

		current = parsed.parent;
	}

	return options.map((option) => {
		const property = properties.get(option.name);
		const value = (option.default === undefined || option.default === 'null' ? property?.default : option.default)?.replace(/^'(.*)'$/s, '$1');

		return {
			name: option.name,
			type: option.type,
			...(value === undefined || value === 'null' ? {} : { default: value }),
			...(property?.description ? { description: property.description } : {}),
		};
	});
}

// Field types and their classes, from Core::fields()
const core = read(path.join(src, 'Cms', 'Core.php'));
const body = core.slice(core.indexOf('function fields()'));
const types = [...body.slice(0, body.indexOf('];')).matchAll(/'([\w-]+)'\s*=>\s*(\w+)::class/g)];

const version = JSON.parse(read(path.join(kirby, 'composer.json'))).version;

/**
 * Writes a JSON file to src/
 * @param {string} name
 * @param {any} data
 */
function write(name, data) {
	fs.writeFileSync(new URL(`../src/${name}`, import.meta.url), JSON.stringify(data, null, '\t') + '\n');
}

const fields = Object.fromEntries(types.map(([, type, name]) => [type, optionsOf(name)]));
write('field-properties.json', { kirby: version, fields });
console.log(`Wrote ${Object.keys(fields).length} field types of Kirby ${version} to src/field-properties.json`);

// Field methods: the public methods of the FieldMethods trait
const trait = read(path.join(src, 'Content', 'FieldMethods.php'));
const methods = [];

for (const match of trait.matchAll(/(?:\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*)?public\s+function\s+(\w+)\s*\(/g)) {
	const open = match.index + match[0].length - 1;
	let depth = 0;
	let close = open;

	for (let i = open, quote = null; i < trait.length; i++) {
		const char = trait[i];

		if (quote !== null) {
			quote = char === '\\' ? (i++, quote) : char === quote ? null : quote;
		} else if (char === '\'' || char === '"') {
			quote = char;
		} else if (char === '(' && ++depth) {
			continue;
		} else if (char === ')' && --depth === 0) {
			close = i;
			break;
		}
	}

	const returns = trait.slice(close + 1).match(/^\s*:\s*([\w\\|?]+)/)?.[1];

	// Aliases only say `@see self::toBool()`
	const alias = match[1]?.match(/@see\s+self::(\w+)\(\)/)?.[1];
	const text = alias === undefined ? (match[1] === undefined ? '' : description(match[1])) : `Alias of ${alias}()`;

	if (match[2].startsWith('__') === false) {
		methods.push({
			name: match[2],
			params: splitTopLevel(trait.slice(open + 1, close)).join(', '),
			...(returns === undefined ? {} : { returns }),
			...(text === '' ? {} : { description: text }),
		});
	}
}

write('field-methods.json', { kirby: version, methods });
console.log(`Wrote ${methods.length} field methods of Kirby ${version} to src/field-methods.json`);
