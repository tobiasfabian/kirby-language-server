<?php snippet('head') ?>
<body>
	<?php snippet('o-header') ?>
	<?php snippet('m-card', ['page' => $page, 'size' => 'large']) ?>
	<?php snippet(['m-card-project', 'm-card']) ?>
	<?php snippet('m-nav-footer') ?>
	<?php snippet('blocks/' . $block->type()) ?>
	<?php snippet('m-form-contact') ?>
	<?= snippet('blocks/image', return: true) ?>
	<?php $projects = collection('projects') ?>
	<?php $recent = $kirby->collection('blog/recent') ?>
	<?php $forms = collection('contact-forms') ?>
	<?php $team = collection('team') ?>
	<?php $missing = collection('missing') ?>
	<?= t('project.completed') ?>
	<?= tc('project', 2) ?>
	<?= tt('greeting', ['name' => 'Ada']) ?>
	<?= t('contact.send') ?> <?= t('footer.copyright') ?> <?= t('save') ?>
	<?= t('missing.key') ?>
	<?= t('missing.with.fallback', 'Fallback') ?>
	<?= tc('missing.plural', 2) ?>
	<link rel="stylesheet" href="<?= hashedUrl('assets/css/index.css') ?>">
	<?= svg('/assets/images/logo.svg') ?>
	<img src="<?= url('assets/images/monkey@2x.webp') ?>" alt="">
	<?= css('media/plugins/index.css') ?>
	<?= js('@auto') ?>
	<a href="<?= url('search') ?>"></a>
	<?= svg('assets/images/missing.svg') ?>
</body>
