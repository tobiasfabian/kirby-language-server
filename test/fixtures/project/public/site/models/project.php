<?php

use Kirby\Cms\Page;

/**
 * @method \Kirby\Content\Field cover()
 * @method ProjectsPage parent() The projects page
 * @method \Kirby\Content\Field title()
 * @method \Kirby\Content\Field metaTitle()
 * @method \Kirby\Content\Field oldField()
 */
class ProjectPage extends Page
{
	/**
	 * The year the project ended
	 */
	public function year(): int
	{
		return 2026;
	}

	protected function secret(): void
	{
	}
}
