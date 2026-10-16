<?php

use Kirby\Cms\App;

App::plugin('site/contact', [
	'options' => ['cache' => true],
	'snippets' => [
		'm-form-contact' => __DIR__ . '/snippets/m-form-contact.php',
	],
	'collections' => [
		'contact-forms' => function () {
			return []; // 'not-a-collection' => 'x'
		},
	],
	'api' => [
		'collections' => [
			'api-results' => ['model' => 'result'],
		],
	],
	'translations' => [
		'de' => [
			'contact.send' => 'Senden',
		],
	],
]);
