import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isInPhp, phpCode, phpOnly, phpRegions, undefinedVariables } from '../src/variables.js';

const names = (text) => undefinedVariables(text)?.map(({ name }) => name) ?? null;

test('keeps only the PHP code of a template', () => {
	assert.equal(phpCode('<p>$a</p><?= $b ?>'), ' '.repeat(13) + '$b   ');
	assert.equal(phpCode(`<?php $a = 'x $y'; // $z\n?>`), '      $a =       ;      \n  ');
	assert.equal(phpCode('<?= "Hi $name, \\$no" ?>').includes('$name'), true);
	assert.equal(phpCode('<?= "Hi $name, \\$no" ?>').includes('$no'), false);
});

test('finds variables a template uses but doesn’t define', () => {
	assert.deepEqual(names('<?= $page->title() ?> <?= $missing ?>'), ['page', 'missing']);
	assert.deepEqual(names('<?php $a = 1; $b[] = 2; $c .= 3; [$d, $e] = [4, 5]; list($f) = [6]; ?><?= $a . $b . $c . $d . $e . $f ?>'), []);
	assert.deepEqual(names('<?php foreach ($items as $key => $item): ?><?= $key . $item ?><?php endforeach ?>'), ['items']);
	assert.deepEqual(names('<?php $list->map(function ($x) use ($y) { return $x; }); $fn = fn ($z) => $z; ?>'), ['list', 'y']);
	assert.deepEqual(names('<?php try { } catch (Exception $e) { echo $e; } if (preg_match("/a/", $text, $m)) { echo $m[0]; } ?>'), []);
	assert.deepEqual(names('<?php static $cache; global $config; ?><?= $cache . $config . $_GET["x"] ?>'), []);
	assert.deepEqual(names('<script>let $x = `${y}`;</script><?php /* $hidden */ ?>'), []);
});

test('gives up where variables can’t be known', () => {
	assert.equal(names('<?php extract($data) ?><?= $a ?>'), null);
	assert.equal(names('<?php $$name = 1 ?>'), null);
	assert.equal(names('<?php include "x.php" ?>'), null);
});

test('finds the PHP parts of a file', () => {
	const text = '<p>a</p><?php $a = \'?>\'; /* ?> */ // ?>\n<b>c</b><?= $b ?><?xml version="1.0" ?>';

	assert.deepEqual(phpRegions(text).map(({ start, end }) => text.slice(start, end)), [" $a = '?>'; /* ?> */ // ", ' $b ']);
	assert.equal(isInPhp(text, text.indexOf('$a')), true);
	assert.equal(isInPhp(text, text.indexOf('<b>')), false);
	assert.equal(isInPhp(text, text.indexOf('version')), false);
	assert.equal(isInPhp('<?php\nreturn [];', 12), true);
	assert.equal(phpOnly('<p>t(\'x\')</p><?= t(\'y\') ?>'), ' '.repeat(17) + "t('y')   ");
});
