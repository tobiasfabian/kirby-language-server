<?php

namespace Kirby\Content;

trait FieldMethods
{
	/**
	 * Converts a yaml field to a File object
	 */
	public function toFile(): File|null
	{
		return $this->toFiles()->first();
	}
}
