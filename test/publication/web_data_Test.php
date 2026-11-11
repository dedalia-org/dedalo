<?php declare(strict_types=1);
// PHPUnit classes
use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\DataProvider;

// Standalone load (no DB, no config): only the SQL string builders are tested
$web_data_test_root = dirname(__FILE__, 3);
if (!defined('SHOW_DEBUG')) {
	define('SHOW_DEBUG', false);
}
if (!function_exists('debug_log')) {
	require_once $web_data_test_root . '/publication/server_api/v1/common/utils.php';
}
if (!defined('PUBLICATION_FILTER_SQL')) {
	define('PUBLICATION_FILTER_SQL', ' ');
}
require_once $web_data_test_root . '/publication/server_api/v1/common/class.web_data.php';



/**
* WEB_DATA_TEST
* Locks the publication API SQL allow-lists against injection
* (AppCheck time-based blind SQLi via 'order' and related sinks:
* order, table, ar_fields, group).
*/
final class web_data_test extends TestCase {



	/**
	* INVOKE
	* Calls a private/protected static web_data method
	* @return mixed
	*/
	private static function invoke(string $method, ...$args) : mixed {

		return (new ReflectionMethod('web_data', $method))->invoke(null, ...$args);
	}//end invoke



	/* ORDER
	----------------------------------------------------------------------- */

	public static function provider_order_injections() : array {
		return [
			'report payload'		=> ['((SELECT 1 FROM (SELECT SLEEP(10))A))'],
			'comma sleep'			=> ['1,SLEEP(1)'],
			'if sleep'				=> ['IF(1,SLEEP(1),1)'],
			'subquery'				=> ['(SELECT 1)'],
			'select in item'		=> ['number ASC, (SELECT 1)'],
			'backtick breakout'		=> ['`a``), SLEEP(1)'],
			'backtick open'			=> ['`a` ASC`'],
			'comment dash'			=> ['number ASC -- x'],
			'comment hash'			=> ['number ASC #x'],
			'comment c'				=> ['number/**/ASC'],
			'newline payload'		=> ["number ASC\n, SLEEP(1)"],
			'tab payload'			=> ["number\tASC,\tSLEEP(1)"],
			'fullwidth parens'		=> ['RAND（）'],
			'fullwidth letters'		=> ['ｎｕｍｂｅｒ ASC'],
			'benchmark'				=> ['BENCHMARK(1000000,MD5(1))'],
			'length subquery'		=> ['LENGTH((SELECT 1))'],
			'rand arg'				=> ['RAND(SLEEP(1))'],
			'trailing comma'		=> ['number ASC,'],
			'semicolon'				=> ['number ASC;'],
			'bad direction'			=> ['number UP'],
			'empty'					=> [''],
			'array'					=> [['number ASC']],
			'object'				=> [(object)['a' => 1]],
			'null'					=> [null],
			// relaxed shapes (FIELD, CAST, COLLATE, IS NULL, NULL, integer) stay closed
			'field sleep'			=> ['FIELD(section_id,SLEEP(1))'],
			'field string'			=> ["FIELD(section_id,'a')"],
			'field no args'			=> ['FIELD(section_id)'],
			'field then sleep'		=> ['FIELD(section_id,1,2),SLEEP(1)'],
			'field subquery'		=> ['FIELD((SELECT 1),1)'],
			'cast char'				=> ['CAST(norder AS CHAR)'],
			'cast sleep'			=> ['CAST(SLEEP(1) AS UNSIGNED)'],
			'collate paren'			=> ['name COLLATE utf8)'],
			'collate backtick'		=> ['name COLLATE `x`'],
			'is null or'			=> ['name IS NULL OR SLEEP(1)'],
			'integer or'			=> ['1 OR SLEEP(1)'],
			'null sleep'			=> ['NULL,SLEEP(1)'],
			'negative int'			=> ['-1'],
			'unbalanced quote'		=> ["a','b"]
		];
	}



	#[DataProvider('provider_order_injections')]
	public function test_sanitize_sql_order_rejects_injection(mixed $order) : void {

		$this->assertNull(web_data::sanitize_sql_order($order));
		$this->assertFalse(web_data::check_safe_value('order', $order));
	}//end test_sanitize_sql_order_rejects_injection



	public static function provider_order_legit() : array {
		return [
			'frontend'				=> ['number ASC',							'`number` ASC'],
			'default'				=> ['`id` ASC',								'`id` ASC'],
			'norder'				=> ['`norder` ASC',							'`norder` ASC'],
			'relevance'				=> ['relevance DESC',						'`relevance` DESC'],
			'rand'					=> ['RAND()',								'RAND()'],
			'list'					=> ['name ASC, surname ASC',				'`name` ASC, `surname` ASC'],
			'no direction'			=> ['term',									'`term`'],
			'lower case dir'		=> ['term asc',								'`term` ASC'],
			'prefix'				=> ['ORDER BY number ASC',					'`number` ASC'],
			'length'				=> ['LENGTH(sort_id), sort_id ASC',			'LENGTH(`sort_id`), `sort_id` ASC'],
			'global search json'	=> ['start_date ASC, LENGTH(sort_id), sort_id ASC', '`start_date` ASC, LENGTH(`sort_id`), `sort_id` ASC'],
			'qualified'				=> ['interview.name DESC',					'`interview`.`name` DESC'],
			// regressions: shapes accepted before the allow-list
			'null (no sort)'		=> ['null',									'NULL'],
			'null upper'			=> ['NULL',									'NULL'],
			'order by null'			=> ['ORDER BY NULL',						'NULL'],
			'position'				=> ['1 DESC',								'1 DESC'],
			'field'					=> ['FIELD(section_id,3,1,2)',				'FIELD(`section_id`, 3, 1, 2)'],
			'field dir'				=> ['FIELD(section_id, 3, 1) DESC, name',	'FIELD(`section_id`, 3, 1) DESC, `name`'],
			'cast'					=> ['CAST(norder AS UNSIGNED) ASC',			'CAST(`norder` AS UNSIGNED) ASC'],
			'collate'				=> ['name COLLATE utf8mb4_unicode_ci ASC',	'`name` COLLATE utf8mb4_unicode_ci ASC'],
			'is null'				=> ['section_id IS NULL, section_id',		'`section_id` IS NULL, `section_id`'],
			'is not null'			=> ['name is not null desc',				'`name` IS NOT NULL DESC']
		];
	}



	#[DataProvider('provider_order_legit')]
	public function test_sanitize_sql_order_accepts_legit(string $order, string $expected) : void {

		$this->assertSame($expected, web_data::sanitize_sql_order($order));
		$this->assertTrue(web_data::check_safe_value('order', $order));
	}//end test_sanitize_sql_order_accepts_legit



	public function test_build_sql_order_emits_sanitized() : void {

		$this->assertSame('ORDER BY `number` ASC', self::invoke('build_sql_order', 'number ASC'));
		$this->assertSame('ORDER BY `number` ASC', self::invoke('build_sql_order', 'ORDER BY number ASC'));
	}//end test_build_sql_order_emits_sanitized



	public function test_build_sql_order_throws_on_injection() : void {

		$this->expectException(InvalidArgumentException::class);
		self::invoke('build_sql_order', '((SELECT 1 FROM (SELECT SLEEP(10))A))');
	}//end test_build_sql_order_throws_on_injection



	/* TABLE
	----------------------------------------------------------------------- */

	public static function provider_table_injections() : array {
		return [
			'where sleep'		=> ['base_type WHERE SLEEP(10)'],
			'semicolon'			=> ['a;b'],
			'backtick'			=> ['a` x'],
			'subquery'			=> ['(SELECT 1)'],
			'comment'			=> ['interview -- x'],
			'dot'				=> ['db.table'],
			'empty item'		=> ['a,,b'],
			'empty'				=> [''],
			'newline'			=> ["interview\nWHERE 1"],
			'array bad item'	=> [['interview', 'a b']],
			'array non string'	=> [['interview', ['x']]],
			'null'				=> [null]
		];
	}



	#[DataProvider('provider_table_injections')]
	public function test_check_safe_value_table_rejects_injection(mixed $table) : void {

		$this->assertNull(web_data::sanitize_sql_table($table));
		$this->assertFalse(web_data::check_safe_value('table', $table));
	}//end test_check_safe_value_table_rejects_injection



	public function test_check_safe_value_table_accepts_legit() : void {

		$this->assertTrue(web_data::check_safe_value('table', 'interview'));
		$this->assertTrue(web_data::check_safe_value('table', 'ts_chronological,ts_onomastic,ts_themes'));
		$this->assertTrue(web_data::check_safe_value('table', 'ts_chronological, ts_themes'));
		$this->assertTrue(web_data::check_safe_value('table', ['ts_themes', 'ts_onomastic']));
		$this->assertSame(['ts_chronological', 'ts_themes'], web_data::sanitize_sql_table(' ts_chronological , ts_themes '));
	}//end test_check_safe_value_table_accepts_legit



	public function test_build_sql_from_backticks() : void {

		$this->assertSame('FROM `interview`', self::invoke('build_sql_from', ' interview '));

		$this->expectException(InvalidArgumentException::class);
		self::invoke('build_sql_from', 'base_type WHERE SLEEP(10)');
	}//end test_build_sql_from_backticks



	/* AR_FIELDS
	----------------------------------------------------------------------- */

	public static function provider_fields_injections() : array {
		return [
			'concat sleep'			=> ['CONCAT(SLEEP(10))'],
			'concat subquery'		=> ['CONCAT(a,(SELECT 1))'],
			'benchmark'				=> ['BENCHMARK(1000000,MD5(1))'],
			'if'					=> ['IF(1,SLEEP(1),1) AS x'],
			'spaced call'			=> ['SLEEP (1)'],
			'backticked call'		=> ['`SLEEP`(1)'],
			'literal call'			=> ['\'SLEEP\'(1)'],
			'select lower'			=> ['CONCAT(a) AS x, (select 1)'],
			'comment dash'			=> ['name -- x'],
			'comment c'				=> ['CONCAT(a/**/)'],
			'hash'					=> ['name #'],
			'semicolon'				=> ['name;'],
			'variable'				=> ['@@version'],
			'backslash outside'		=> ['CONCAT(a, \\\' )'],
			'unterminated literal'	=> ['CONCAT(\'a)'],
			'equality'				=> ['CONCAT(a) AS x =x'],
			'unbalanced'			=> ['CONCAT(a'],
			'closing first'			=> [')CONCAT(a'],
			'dot'					=> ['interview.name'],
			'backtick breakout'		=> ['`a``), SLEEP(1)'],
			'backtick spaces'		=> ['`a AS b`'],
			'fullwidth parens'		=> ['CONCAT（a）'],
			'raw newline literal'	=> ["CONCAT('a\nLIMIT', b)"],
			'in list'				=> ['a IN (1,2)'],
			'non string'			=> [['name']]
		];
	}



	#[DataProvider('provider_fields_injections')]
	public function test_sanitize_sql_field_rejects_injection(mixed $field) : void {

		$this->assertNull(web_data::sanitize_sql_field($field));
		$this->assertFalse(web_data::check_safe_value('ar_fields', [$field]));
		// is_literal no longer widens the allow-list
		$this->assertFalse(web_data::check_safe_value('ar_fields', [$field], true));
	}//end test_sanitize_sql_field_rejects_injection



	public static function provider_fields_legit() : array {
		return [
			'star'				=> ['*',								'*'],
			'plain'				=> ['name',								'`name`'],
			'unicode'			=> ['año',								'`año`'],
			'backticked'		=> ['`name`',							'`name`'],
			'distinct'			=> ['DISTINCT tld AS tld',				'DISTINCT `tld` AS `tld`'],
			'match'				=> [
				"MATCH (rsc36) AGAINST ('hola mundo') AS relevance ",
				"MATCH(`rsc36`) AGAINST('hola mundo') AS `relevance`"
			],
			'match escaped q'	=> [
				"MATCH (full_data) AGAINST ('l\\'Alcora') AS relevance ",
				"MATCH(`full_data`) AGAINST('l''Alcora') AS `relevance`"
			],
			'match literal q'	=> [
				"MATCH (full_data) AGAINST ('\"Cementiri de Sant Hilari\"') AS relevance ",
				"MATCH(`full_data`) AGAINST('\"Cementiri de Sant Hilari\"') AS `relevance`"
			],
			'match select word'	=> [
				"MATCH (full_data) AGAINST ('select sleep') AS relevance",
				"MATCH(`full_data`) AGAINST('select sleep') AS `relevance`"
			],
			'match escaped nl'	=> [
				"MATCH (full_data) AGAINST ('a\\nb') AS relevance",
				"MATCH(`full_data`) AGAINST('a\\nb') AS `relevance`"
			],
			'concat json'		=> [
				"CONCAT('[', name, ' ', surname, ']') AS full_name",
				"CONCAT('[', `name`, ' ', `surname`, ']') AS `full_name`"
			],
			'concat double q'	=> [
				'CONCAT("{", name, "}")',
				"CONCAT('{', `name`, '}')"
			],
			'concat ws'			=> ['CONCAT_WS(\' \', name, surname)',	"CONCAT_WS(' ', `name`, `surname`)"],
			'group concat'		=> ['GROUP_CONCAT(term SEPARATOR \'|\') AS terms', "GROUP_CONCAT(`term` SEPARATOR '|') AS `terms`"],
			'count'				=> ['COUNT(*) AS total',				'COUNT(*) AS `total`'],
			'lower as'			=> ['name as n',						'`name` AS `n`'],
			'backslash literal'	=> ["CONCAT('a\\\\b')",					"CONCAT('a\\\\b')"]
		];
	}



	#[DataProvider('provider_fields_legit')]
	public function test_sanitize_sql_field_accepts_legit(string $field, string $expected) : void {

		$this->assertSame($expected, web_data::sanitize_sql_field($field));
		$this->assertTrue(web_data::check_safe_value('ar_fields', [$field]));
	}//end test_sanitize_sql_field_accepts_legit



	public function test_sanitize_sql_field_escaped_quote_stays_literal() : void {

		// MySQL reads 'a\', SLEEP(1), ' as one literal: it is re-emitted with doubled quotes
		// so it can not be broken out of even with NO_BACKSLASH_ESCAPES
		$this->assertSame(
			"CONCAT('a'', SLEEP(1), ' `b`)",
			web_data::sanitize_sql_field("CONCAT('a\\', SLEEP(1), 'b)")
		);
	}//end test_sanitize_sql_field_escaped_quote_stays_literal



	public function test_check_safe_value_ar_fields_string_list() : void {

		$this->assertTrue(web_data::check_safe_value('ar_fields', 'name,surname'));
		$this->assertTrue(web_data::check_safe_value('ar_fields', '*'));
		$this->assertFalse(web_data::check_safe_value('ar_fields', 'name,SLEEP(1)'));
		$this->assertFalse(web_data::check_safe_value('ar_fields', 'CONCAT(SLEEP(10))'));
	}//end test_check_safe_value_ar_fields_string_list



	public function test_check_safe_value_ar_fields_string_list_functions() : void {

		// regression: comma string is split outside parentheses/quotes, not on every ','
		$this->assertSame(
			['section_id', 'CONCAT(name,surname) AS full'],
			web_data::split_sql_list('section_id,CONCAT(name,surname) AS full')
		);
		$this->assertSame(
			["CONCAT(a,')')", '`b,c`', "'x,y'"],
			web_data::split_sql_list("CONCAT(a,')'), `b,c`, 'x,y'")
		);
		$this->assertTrue(web_data::check_safe_value('ar_fields', 'section_id,CONCAT(name,surname) AS full'));
		$this->assertTrue(web_data::check_safe_value('ar_fields', "MATCH (a,b) AGAINST ('x') AS relevance"));
		// unbalanced input is one item and rejected
		$this->assertSame(['a,b)'], web_data::split_sql_list('a,b)'));
		$this->assertFalse(web_data::check_safe_value('ar_fields', 'a,b)'));
		$this->assertFalse(web_data::check_safe_value('ar_fields', 'section_id,CONCAT(SLEEP(1),a)'));
		$this->assertFalse(web_data::check_safe_value('ar_fields', "a,CONCAT(b,')'),SLEEP(1)"));
	}//end test_check_safe_value_ar_fields_string_list_functions



	public function test_safe_field_name_keeps_client_name_for_unaliased_expression() : void {

		// regression: exec_query reads $row[<client field text>], so an un-aliased
		// rebuilt expression is aliased with the client text
		$this->assertSame(
			"CONCAT(`name`, ' ', `surname`) AS `CONCAT(name,' ',surname)`",
			self::invoke('safe_field_name', "CONCAT(name,' ',surname)")
		);
		$this->assertSame(
			"MATCH(`rsc36`) AGAINST('foo') AS `MATCH (rsc36) AGAINST ('foo')`",
			self::invoke('safe_field_name', "MATCH (rsc36) AGAINST ('foo')")
		);
		$this->assertSame('COUNT(*) AS `COUNT(*)`', self::invoke('safe_field_name', 'COUNT(*)'));
		// backticks in the alias are doubled (no identifier breakout)
		$this->assertSame(
			"CONCAT('`), SLEEP(1) #') AS `CONCAT('``), SLEEP(1) #')`",
			self::invoke('safe_field_name', "CONCAT('`), SLEEP(1) #')")
		);
		// named or bare column: no alias added
		$this->assertSame('CONCAT(`a`) AS `b`', self::invoke('safe_field_name', 'CONCAT(a) AS b'));
		$this->assertSame('`name` `n`', self::invoke('safe_field_name', 'name n'));
		$this->assertSame('DISTINCT `tld`', self::invoke('safe_field_name', 'DISTINCT tld'));
		$this->assertSame('`name`', self::invoke('safe_field_name', 'name'));
	}//end test_safe_field_name_keeps_client_name_for_unaliased_expression



	public function test_safe_field_name_quoting_by_parse() : void {

		// old substring test skipped quoting for anything containing CONCAT/MATCH/DISTINCT/' AS '
		$this->assertSame('`name`', self::invoke('safe_field_name', 'name'));
		$this->assertSame('CONCAT(`a`) AS `b`', self::invoke('safe_field_name', 'CONCAT(a) AS b'));

		$this->expectException(InvalidArgumentException::class);
		self::invoke('safe_field_name', 'CONCAT(SLEEP(1))');
	}//end test_safe_field_name_quoting_by_parse



	public function test_build_sql_select_emits_sanitized() : void {

		$this->assertSame(
			"SELECT MATCH(`rsc36`) AGAINST('x') AS `relevance`,`section_id`,*",
			self::invoke('build_sql_select', ["MATCH (rsc36) AGAINST ('x') AS relevance ", 'section_id', '*'])
		);
	}//end test_build_sql_select_emits_sanitized



	/* GROUP
	----------------------------------------------------------------------- */

	public static function provider_group_injections() : array {
		return [
			'concat sleep'		=> ['CONCAT(SLEEP(10))'],
			'concat subquery'	=> ['CONCAT(a,(SELECT 1))'],
			'benchmark'			=> ['BENCHMARK(1,1)'],
			'lang sleep'		=> ['lang, SLEEP(1)'],
			'having'			=> ['lang HAVING 1=1'],
			'comment'			=> ['lang -- x'],
			'semicolon'			=> ['lang;'],
			'as in literal'		=> ["CONCAT('a AS b', lang)"],
			'array'				=> [['lang']],
			'empty'				=> ['GROUP BY ']
		];
	}



	#[DataProvider('provider_group_injections')]
	public function test_sanitize_sql_group_rejects_injection(mixed $group) : void {

		$this->assertNull(web_data::sanitize_sql_group($group));
		$this->assertFalse(web_data::check_safe_value('group', $group));
	}//end test_sanitize_sql_group_rejects_injection



	public static function provider_group_legit() : array {
		return [
			'lang'			=> ['lang',							'`lang`'],
			'list'			=> ['term_id, lang',				'`term_id`, `lang`'],
			'prefix'		=> ['GROUP BY section_id',			'`section_id`'],
			'concat'		=> ["CONCAT('[', term_id, ']')",	"CONCAT('[', `term_id`, ']')"]
		];
	}



	#[DataProvider('provider_group_legit')]
	public function test_sanitize_sql_group_accepts_legit(string $group, string $expected) : void {

		$this->assertSame($expected, web_data::sanitize_sql_group($group));
		$this->assertTrue(web_data::check_safe_value('group', $group));
		$this->assertSame('GROUP BY '.$expected, self::invoke('build_sql_group', $group));
	}//end test_sanitize_sql_group_accepts_legit



	/* CALLER
	----------------------------------------------------------------------- */

	public function test_sanitize_sql_comment_strips_newline() : void {

		$this->assertSame('default', web_data::sanitize_sql_comment('default'));
		$this->assertSame('x_SELECT_SLEEP_10_', web_data::sanitize_sql_comment("x\nSELECT SLEEP(10)"));
		$this->assertSame('', web_data::sanitize_sql_comment(['x']));
	}//end test_sanitize_sql_comment_strips_newline



}//end class web_data_test
