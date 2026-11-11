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



	/* SQL_FILTER
	----------------------------------------------------------------------- */

	public static function provider_filter_legit_unchanged() : array {
		// shapes built by internal callers or sent by frontends: must pass untouched
		return [
			'equal int'				=> ['section_id = 12'],
			'equal string'			=> ["term_id = 'ts1_10' AND lang = 'lg-spa'"],
			'in list'				=> ['section_id IN (1,2,3)'],
			'not in'				=> ['section_id NOT IN (1, 2)'],
			'or group'				=> ["(section_id=1 OR section_id=2) AND lang = 'lg-eng'"],
			'like json'				=> ["`indexation` LIKE '%\"type\":\"dd96\",\"tag_id\":\"3\",\"section_id\":\"5\"%' "],
			'like plain'			=> ["audiovisual LIKE '%\"5\"%' "],
			'publication suffix'	=> ["section_id = 1 AND publication = 'si'"],
			'leading and'			=> [" AND publication = 'yes'"],
			'match against'			=> ["MATCH (rsc36) AGAINST ('+roma*' IN BOOLEAN MODE)"],
			'match natural'			=> ["MATCH (`rsc36`) AGAINST ('roma' IN NATURAL LANGUAGE MODE)"],
			'match expansion'		=> ["MATCH (rsc36) AGAINST ('roma' WITH QUERY EXPANSION)"],
			'ranges'				=> ['date_in >= 100 AND date_out <= 200'],
			'not null'				=> ["material IS NOT NULL AND material != ''"],
			'diff'					=> ['a <> 1 OR a <=> NULL'],
			'negative decimal'		=> ['-1 < x AND y = 1.5'],
			'between cast'			=> ['CAST(number AS UNSIGNED) BETWEEN 1 AND 10'],
			'find in set'			=> ["FIND_IN_SET('3', ref_ids)"],
			'json contains'			=> ["JSON_CONTAINS(mint_data, '\"12\"')"],
			'lower like'			=> ["LOWER(name) LIKE '%ab%'"],
			'collate'				=> ["name LIKE '%ab%' COLLATE utf8mb4_general_ci"],
			'regexp'				=> ["`date` REGEXP '^1[0-9]{3}$'"],
			'year'					=> ['YEAR(date_in) = 1900'],
			'qualified'				=> ['t.section_id = 1'],
			'qualified reserved'	=> ['t.`order` = 1 AND t.select = 2'],
			'case'					=> ['CASE WHEN a = 1 THEN 1 ELSE 0 END = 1'],
			'double quoted'			=> ['name = "Roma"'],
			'national'				=> ["name = N'Roma'"],
			'hex value'				=> ['name = 0x526f6d61'],
			'unicode'				=> ["name LIKE '%Ñoño%' AND `año` = 1"],
			'multiline'				=> ["section_id = 1\nAND lang = 'lg-spa'"],
			'and or ops'			=> ['a = 1 && b = 2 || c = 3'],
			'if'					=> ['IF(a = 1, 1, 0) = 1'],
			'timestampdiff'			=> ['TIMESTAMPDIFF(YEAR, d, NOW()) > 1'],
			'current date'			=> ['CURRENT_DATE > d AND CURRENT_TIMESTAMP() > d'],
			'member of'				=> ["'1' MEMBER OF(j)"],
			'json arrow'			=> ["j->>'$.a' = 'x'"],
			'mariadb plain names'	=> ['rank = 1 AND system = 2 AND `row` = 3'],
			'extract'				=> ['EXTRACT(YEAR FROM date) = 1936'],
			'trim leading'			=> ["TRIM(LEADING '0' FROM code) = '12'"],
			'substring from for'	=> ["SUBSTRING(name FROM 1 FOR 2) = 'Jo'"],
			'interval unit'			=> ['DATE_ADD(d, INTERVAL 1 DAY_HOUR) > d'],
			'form feed'				=> ["a = 1\fAND b = 2"],
			'empty'					=> [''],
		];
	}//end provider_filter_legit_unchanged



	#[DataProvider('provider_filter_legit_unchanged')]
	public function test_sanitize_sql_filter_keeps_legit(string $filter) : void {

		$this->assertSame($filter, web_data::sanitize_sql_filter($filter));
	}//end test_sanitize_sql_filter_keeps_legit



	public static function provider_filter_rewritten() : array {
		// literals with escapes or control chars: same value, sql_mode independent form
		return [
			'backslash quote'		=> ["name LIKE '%l\\'Escala%'", "name LIKE '%l''Escala%'"],
			'doubled quote'			=> ["name = 'it''s'", "name = 'it''s'"],
			'double quoted escape'	=> ['name = "a\\"b"', "name = 'a\"b'"],
			'raw newline'			=> ["name = 'a\nb'", "name = 'a\\nb'"],
			'like escape kept'		=> ["name LIKE '%a\\_b%'", "name LIKE '%a\\\\_b%'"],
			// MySQL reads one literal: kept one literal under any sql_mode
			'quote smuggling'		=> ["x = 'a\\' OR SLEEP(1) #'", "x = 'a'' OR SLEEP(1) #'"],
			'quote smuggling name'	=> ["x = 'a\\' OR SLEEP(1) OR 'b", "x = 'a'' OR SLEEP(1) OR 'b"],
		];
	}//end provider_filter_rewritten



	#[DataProvider('provider_filter_rewritten')]
	public function test_sanitize_sql_filter_rewrites_escaped_literals(string $filter, string $expected) : void {

		$this->assertSame($expected, web_data::sanitize_sql_filter($filter));
	}//end test_sanitize_sql_filter_rewrites_escaped_literals



	public static function provider_filter_injections() : array {
		return [
			'sleep'					=> ['section_id = 1 OR SLEEP(5)'],
			'sleep spaced'			=> ['section_id = 1 OR SLEEP (5)'],
			'report subquery'		=> ['section_id=1 AND (SELECT 1 FROM (SELECT SLEEP(10))A)'],
			'select paren'			=> ['section_id IN (SELECT(1))'],
			'benchmark'				=> ['BENCHMARK(1000000,SHA1(1))'],
			'if sleep'				=> ['IF(1,SLEEP(1),3) = 2'],
			'table subquery'		=> ['section_id IN (TABLE t)'],
			'values row'			=> ['section_id IN (VALUES ROW(1))'],
			'union'					=> ['section_id = 1 UNION ALL SELECT 1'],
			'into outfile'			=> ["x = 1 INTO OUTFILE '/tmp/a'"],
			'limit'					=> ['x = 1 LIMIT 1'],
			'order'					=> ['x = 1 ORDER BY 1'],
			'for update'			=> ['x = 1 FOR UPDATE'],
			'for update parens'		=> ['(x = 1) FOR UPDATE OR (1)'],
			'from top level'		=> ['x = 1 FROM t'],
			'from as call'			=> ['x = (FROM(1))'],
			'exists'				=> ['EXISTS (x)'],
			'comment dash'			=> ['x = 1 -- '],
			'comment hash'			=> ['x = 1 # a'],
			'comment c'				=> ['x/**/= 1'],
			'comment exec'			=> ['x = 1 /*!50000 OR 1*/'],
			'semicolon'				=> ['x = 1; DROP TABLE t'],
			'global var'			=> ['x = @@version'],
			'user var'				=> ['x = @a'],
			'assign'				=> ['x := 1'],
			'backtick call'			=> ['`SLEEP`(1) = 0'],
			'qualified call'		=> ['sys.format_bytes(1) = 1'],
			'qualified spaced call'	=> ['mysql . sleep (1) = 0'],
			'odbc escape'			=> ['x = {fn sleep(1)}'],
			'unclosed quote'		=> ["x = 'unclosed"],
			'open paren'			=> ['(x = 1'],
			'close paren'			=> ['x = 1)'],
			'close reopen'			=> ['x = 1) OR (1'],
			'database'				=> ['x = DATABASE()'],
			'user'					=> ['x = USER()'],
			'version'				=> ['x = VERSION()'],
			'current user'			=> ['x = CURRENT_USER'],
			'extractvalue'			=> ["x = EXTRACTVALUE(1,'a')"],
			'repeat'				=> ["x = REPEAT('a', 999999999)"],
			'lpad'					=> ["x = LPAD('a', 999999999, 'b')"],
			'json table'			=> ['x = JSON_TABLE(1)'],
			'get lock'				=> ["GET_LOCK('a', 10)"],
			'load file'				=> ["LOAD_FILE('/etc/passwd') IS NULL"],
			'nbsp'					=> ["x\u{00A0}= 1"],
			'nul'					=> ["x = 1\x00"],
			'backslash outside'		=> ['x = 1 \\ 2'],
			'question'				=> ['x = ?'],
			'invalid utf8'			=> ["x = '\xff'"],
			'array'					=> [['x = 1']],
			'null'					=> [null],
		];
	}//end provider_filter_injections



	#[DataProvider('provider_filter_injections')]
	public function test_sanitize_sql_filter_rejects_injection(mixed $filter) : void {

		$this->assertNull(web_data::sanitize_sql_filter($filter));
	}//end test_sanitize_sql_filter_rejects_injection



	public function test_sanitize_sql_filter_number_as_before() : void {

		// JSON body numbers were accepted before
		$this->assertSame('1936', web_data::sanitize_sql_filter(1936));
		$this->assertTrue(web_data::check_safe_value('sql_filter', 1936));
	}//end test_sanitize_sql_filter_number_as_before



	public function test_check_safe_value_sql_filter_legacy_accepts_search_text() : void {

		// raw thesaurus search text 'q' (escaped later): only the legacy deny-list applies
		foreach (["O'Brien", 'Col·lecció', 'Real Madrid', 'carta(s)', '¿Dónde?', 'Vic; Osona', 'C:\\temp', '#memoria', 1936] as $q) {
			$this->assertTrue(web_data::check_safe_value('sql_filter_legacy', $q), json_encode($q));
		}
		$this->assertFalse(web_data::check_safe_value('sql_filter_legacy', 'a sleep(1)'));
		$this->assertFalse(web_data::check_safe_value('sql_filter_legacy', ['x']));
	}//end test_check_safe_value_sql_filter_legacy_accepts_search_text



	public function test_check_safe_value_sql_filter_layers() : void {

		// legit
		$this->assertTrue(web_data::check_safe_value('sql_filter', "section_id IN (1,2) AND lang = 'lg-spa'"));
		// legacy deny-list still applies (nothing rejected before is accepted now)
		$this->assertFalse(web_data::check_safe_value('sql_filter', "name = 'username'"));
		// new allow-list
		$this->assertFalse(web_data::check_safe_value('sql_filter', 'x = 1 OR BENCHMARK(1,1)'));
		$this->assertFalse(web_data::check_safe_value('sql_filter', 'x = 1 OR SELECT(1)'));
		// invalid type (JSON body) no longer raises a TypeError
		$this->assertFalse(web_data::check_safe_value('sql_filter', ['x = 1']));
	}//end test_check_safe_value_sql_filter_layers



	/* SQL_FULLSELECT
	----------------------------------------------------------------------- */

	public function test_sanitize_sql_fullselect_accepts_documented_shape() : void {

		$this->assertSame(
			'SELECT `id`,`section_id`,`titulo`,`mupreva830` FROM `publicaciones` UNION SELECT `id`,`section_id`,`titulo`,`mupreva830` FROM `publicaciones_externas`',
			web_data::sanitize_sql_fullselect('SELECT id,section_id,titulo,mupreva830 FROM publicaciones UNION SELECT id,section_id,titulo,mupreva830 FROM publicaciones_externas')
		);
		$this->assertSame(
			'SELECT * FROM `t1` UNION ALL SELECT * FROM `t2`',
			web_data::sanitize_sql_fullselect("select * from t1\nunion all\nselect * from `t2`")
		);
		$this->assertSame(
			'SELECT `a` FROM `t` AS `x`',
			web_data::sanitize_sql_fullselect('SELECT a FROM t AS x')
		);
		$this->assertSame(
			"SELECT `a`,CONCAT(`b`, ' ', `c`) AS `d` FROM `t`",
			web_data::sanitize_sql_fullselect("SELECT a, CONCAT(b,' ',c) AS d FROM t")
		);
		// check_safe_value keeps the legacy deny-list: ' union ' was already rejected before this fix
		$this->assertTrue(web_data::check_safe_value('sql_fullselect', 'SELECT id, section_id FROM t1'));
		$this->assertFalse(web_data::check_safe_value('sql_fullselect', 'SELECT id FROM t1 UNION SELECT id FROM t2'));
	}//end test_sanitize_sql_fullselect_accepts_documented_shape



	public static function provider_fullselect_injections() : array {
		return [
			'sleep field'			=> ['SELECT SLEEP(10) FROM t'],
			'where'					=> ['SELECT a FROM t WHERE 1'],
			'subquery table'		=> ['SELECT a FROM (SELECT 1) x'],
			'semicolon'				=> ['SELECT a FROM t; DROP TABLE t'],
			'schema table'			=> ['SELECT a FROM t UNION SELECT b FROM information_schema.tables'],
			'db table'				=> ['SELECT a FROM other_db.t'],
			'alias injection'		=> ['SELECT a FROM t x WHERE 1'],
			'comment'				=> ['SELECT a FROM t -- '],
			'join'					=> ['SELECT a FROM t JOIN u'],
			'no from'				=> ['SELECT 1'],
			'not select'			=> ['DELETE FROM t'],
			'field subquery'		=> ['SELECT (SELECT 1) FROM t'],
			'empty'					=> [''],
			'array'					=> [['SELECT a FROM t']],
		];
	}//end provider_fullselect_injections



	#[DataProvider('provider_fullselect_injections')]
	public function test_sanitize_sql_fullselect_rejects_injection(mixed $value) : void {

		$this->assertNull(web_data::sanitize_sql_fullselect($value));
	}//end test_sanitize_sql_fullselect_rejects_injection



	/* PROCESS_RESULT
	----------------------------------------------------------------------- */

	public function test_is_allowed_process_result_fn() : void {

		$this->assertTrue(web_data::is_allowed_process_result_fn('process_result::break_down_totals'));
		$this->assertTrue(web_data::is_allowed_process_result_fn('process_result::add_parents_and_children_recursive'));
		$this->assertTrue(web_data::is_allowed_process_result_fn('PROCESS_RESULT::sum_totals'));
		$this->assertTrue(web_data::is_allowed_process_result_fn('process_result::Break_Down_Totals'));

		$this->assertFalse(web_data::is_allowed_process_result_fn('web_data::get_rows_data'));
		$this->assertFalse(web_data::is_allowed_process_result_fn('process_result::__construct'));
		$this->assertFalse(web_data::is_allowed_process_result_fn('system'));
		$this->assertFalse(web_data::is_allowed_process_result_fn('process_result::sum_totals::x'));
		$this->assertFalse(web_data::is_allowed_process_result_fn(['process_result', 'sum_totals']));
		$this->assertFalse(web_data::is_allowed_process_result_fn(null));
	}//end test_is_allowed_process_result_fn



}//end class web_data_test
