<?php
/** @var \Kirby\Cms\Page|null $page */
$page ??= null;
$size ??= 'medium';
if ($page === null) {
	return;
}
?>
<article class="m-card"><?= $page->title()->esc() ?></article>
