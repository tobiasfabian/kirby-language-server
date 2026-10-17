<?php

use Kirby\Cms\Page;

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
