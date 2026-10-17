<?php

use Kirby\Cms\App;

App::plugin('site/contact', [
	'options' => ['cache' => true],
	'blueprints' => [
		'pages/contact' => __DIR__ . '/blueprints/pages/contact.yml',
		'fields/contact-form' => [
			'type' => 'structure',
		],
	],
	'snippets' => [
		'm-form-contact' => __DIR__ . '/snippets/m-form-contact.php',
	],
	'templates' => [
		'contact' => __DIR__ . '/templates/contact.php',
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
