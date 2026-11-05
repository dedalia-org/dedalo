<?php declare(strict_types=1);
// PHPUnit classes
use PHPUnit\Framework\TestCase;
// bootstrap
require_once dirname(dirname(__FILE__)) . '/bootstrap.php';



final class tool_common_test extends TestCase {



	public $tool;



	/**
	* TEST_USER_LOGIN
	* @return void
	*/
	public function test_user_login() {

		$user_id = TEST_USER_ID; // Defined in bootstrap

		if (login::is_logged()===false) {
			login_test::force_login($user_id);
		}

		$this->assertTrue(
			login::is_logged()===true ,
			'expected login true'
		);
	}//end test_user_login



	/**
	* TEST___CONSTRUCT
	* @return void
	*/
	public function test___construct() {

		$tool = new tool_lang(1, 'dd1324');

		$this->assertTrue(
			get_class($tool)==='tool_lang',
			'expected get_called_class is tool_lang'
				.' and is : '.get_class($tool)
		);

		$this->tool = $tool;
	}//end test___construct



	/**
	* TEST_GET_JSON
	* @return void
	*/
	public function test_get_json() {

		$this->tool = new tool_lang(1, 'dd1324');
		$json = $this->tool->get_json((object)[
			'get_context'	=> true,
			'get_data'		=> true
		]);

		$this->assertTrue(
			gettype($json)==='object',
			'expected type is object'
				.' and is : '.gettype($json)
		);

		$this->assertTrue(
			gettype($json->context)==='array',
			'expected type is array'
				.' and is : '.gettype($json->context)
		);

		$this->assertTrue(
			!isset($json->data),
			'expected was not set json->data'
		);
	}//end test_get_json



	/**
	* TEST_GET_STRUCTURE_CONTEXT
	* @return void
	*/
	public function test_get_structure_context() {

		$this->tool	= new tool_lang(1, 'dd1324');
		$context	= $this->tool->get_structure_context();

		$this->assertTrue(
			gettype($context)==='object',
			'expected type is object'
				.' and is : '.gettype($context)
		);

		$this->assertTrue(
			$context->typo==='ddo',
			'expected typo is ddo'
				.' and is : '.$context->typo
		);

		$this->assertTrue(
			$context->model==='tool_lang',
			'expected model is tool_lang'
				.' and is : '.$context->model
		);
	}//end test_get_structure_context



	/**
	* TEST_create_tool_simple_context
	* @return void
	*/
	public function test_create_tool_simple_context() {

		$section_id		= 1;
		$section_tipo	= 'dd1324';

		$component_tipo			= tools_register::$simple_tool_obj_component_tipo;
		$model					= RecordObj_dd::get_modelo_name_by_tipo($component_tipo,true);
		$simple_tool_component	= component_common::get_instance(
			$model,
			$component_tipo,
			$section_id,
			'list',
			DEDALO_DATA_NOLAN,
			$section_tipo
		);
		$simple_tool_obj_dato	= $simple_tool_component->get_dato();
		$tool_object			= reset($simple_tool_obj_dato);
		$tool_simple_context = tool_common::create_tool_simple_context(
			$tool_object
		);

		$this->assertTrue(
			gettype($tool_simple_context)==='object',
			'expected type is object'
				.' and is : '.gettype($tool_simple_context)
		);

		$this->assertTrue(
			$tool_simple_context->typo==='ddo',
			'expected typo is ddo'
				.' and is : '.$tool_simple_context->typo
		);

	}//end test_create_tool_simple_context



	/**
	* TEST_GET_ALL_REGISTERED_TOOLS
	* @return void
	*/
	public function test_get_all_registered_tools() {

		$all_registered_tools = tool_common::get_all_registered_tools();

		$this->assertTrue(
			gettype($all_registered_tools)==='array',
			'expected type is array'
				.' and is : '.gettype($all_registered_tools)
		);

		$this->assertTrue(
			gettype($all_registered_tools[0]->name)==='string',
			'expected type is string'
				.' and is : '.gettype($all_registered_tools[0]->name)
		);

		$this->assertTrue(
			!empty($all_registered_tools[0]->name),
			'expected name value is not empty'
		);
	}//end test_get_all_registered_tools



	/**
	* TEST_GET_CONFIG
	* @return void
	*/
	public function test_get_config() {

		$tool_config = tool_common::get_config(
			'tool_lang'
		);

		$this->assertTrue(
			gettype($tool_config)==='object',
			'expected type is object'
				.' and is : '.gettype($tool_config)
		);

		$this->assertTrue(
			!empty($tool_config->name),
			'expected name value was not empty'
		);
	}//end test_get_config



	/**
	* TEST_READ_FILES
	* @return void
	*/
	public function test_read_files() {

		$files = tool_common::read_files(
			DEDALO_MEDIA_PATH . DEDALO_IMAGE_FOLDER .'/'. DEDALO_IMAGE_QUALITY_DEFAULT,
			['jpg']
		);

		$this->assertTrue(
			gettype($files)==='array',
			'expected type is array'
				.' and is : '.gettype($files)
		);

		if (isset($files[0])) {
			$this->assertTrue(
				strpos($files[0], '.jpg')!==false,
				'expected true for jpg name in first file'
					.' file: : '. to_string($files[0])
			);
		}
	}//end test_read_files



	/**
	* TEST_READ_CSV_FILE_AS_ARRAY
	* @return void
	*/
	public function test_read_csv_file_as_array() {

		$csv_string = '"section_id";"dd200";"dd199";"dd197";"dd201";"dd271";"dd1223";"dd1224";"dd1225";"dd591";"dd593";"dd594";"dd595";"dd596";"dd599"
		"1";"[{""type"":""dd151"",""section_id"":""-1"",""section_tipo"":""dd128"",""from_component_tipo"":""dd200""}]";"{""lg-nolan"":[{""start"":{""day"":24,""hour"":19,""time"":64905044917,""year"":2019,""month"":5,""minute"":8,""second"":37}}]}";"[{""type"":""dd151"",""section_id"":""-1"",""section_tipo"":""dd128"",""from_component_tipo"":""dd197""}]";"{""lg-nolan"":[{""start"":{""day"":6,""hour"":14,""time"":64914186253,""year"":2019,""month"":9,""minute"":24,""second"":13}}]}";"{""lg-nolan"":[{""start"":{""day"":24,""hour"":19,""time"":64905045160,""year"":2019,""month"":5,""minute"":12,""second"":40}}]}";"{""lg-nolan"":[{""start"":{""day"":6,""hour"":22,""time"":65026709603,""year"":2023,""month"":3,""minute"":53,""second"":23}}]}";"[{""type"":""dd151"",""section_id"":""-1"",""section_tipo"":""dd128"",""from_component_tipo"":""dd1224""}]";"[{""type"":""dd151"",""section_id"":""1"",""section_tipo"":""dd128"",""from_component_tipo"":""dd1225""}]";"";"[{""type"":""dd151"",""section_id"":""1"",""section_tipo"":""dd64"",""from_component_tipo"":""dd593""}]";"{""lg-nolan"":[""page""]}";"";"{""lg-nolan"":""{\""id\"":\""page\"",\""template\"":\""page\"",\""table\"":\""ts_web\"",\""detail\"":[{\""type\"":\""title\"",\""colname\"":\""titulo\""},{\""type\"":\""abstract\"",\""colname\"":\""entradilla\""},{\""type\"":\""body\"",\""colname\"":\""cuerpo\""},{\""type\"":\""image\"",\""colname\"":\""imagen\"",\""target\"":{\""table\"":\""imagen\"",\""colname\"":\""image\""}},{\""type\"":\""address\"",\""colname\"":\""direccion\""},{\""type\"":\""telf\"",\""colname\"":\""telf\""},{\""type\"":\""email\"",\""colname\"":\""email\""}]}""}";"[{""type"":""dd675"",""section_id"":""1"",""section_tipo"":""dd153"",""from_component_tipo"":""dd599""}]"
		"2";"[{""type"":""dd151"",""section_id"":""-1"",""section_tipo"":""dd128"",""from_component_tipo"":""dd200""}]";"{""lg-nolan"":[{""start"":{""day"":24,""hour"":19,""time"":64905044999,""year"":2019,""month"":5,""minute"":9,""second"":59}}]}";"[{""type"":""dd151"",""section_id"":""-1"",""section_tipo"":""dd128"",""from_component_tipo"":""dd197""}]";"{""lg-nolan"":[{""start"":{""day"":24,""hour"":19,""time"":64905047417,""year"":2019,""month"":5,""minute"":50,""second"":17}}]}";"{""lg-nolan"":[{""start"":{""day"":24,""hour"":19,""time"":64905045192,""year"":2019,""month"":5,""minute"":13,""second"":12}}]}";"{""lg-nolan"":[{""start"":{""day"":6,""hour"":22,""time"":65026709603,""year"":2023,""month"":3,""minute"":53,""second"":23}}]}";"[{""type"":""dd151"",""section_id"":""-1"",""section_tipo"":""dd128"",""from_component_tipo"":""dd1224""}]";"[{""type"":""dd151"",""section_id"":""1"",""section_tipo"":""dd128"",""from_component_tipo"":""dd1225""}]";"";"[{""type"":""dd151"",""section_id"":""1"",""section_tipo"":""dd64"",""from_component_tipo"":""dd593""}]";"{""lg-nolan"":[""main_home""]}";"";"{""lg-nolan"":""{\""id\"":\""main_home\"",\""template\"":\""main_home\"",\""table\"":\""ts_web\"",\""detail\"":[{\""type\"":\""title\"",\""colname\"":\""titulo\""},{\""type\"":\""abstract\"",\""colname\"":\""entradilla\""},{\""type\"":\""body\"",\""colname\"":\""cuerpo\""},{\""type\"":\""image\"",\""colname\"":\""imagen\"",\""target\"":{\""table\"":\""imagen\"",\""colname\"":\""image\""}}]}""}";"[{""type"":""dd675"",""section_id"":""1"",""section_tipo"":""dd153"",""from_component_tipo"":""dd599""}]"
		';

		$directory = DEDALO_UPLOAD_TMP_DIR . '/test';
		if (!is_dir($directory)) {
			mkdir($directory, 0750, true);
		}
		$file_test_csv = $directory . '/exported_templates-web_-1-dd477.csv';

		$put = file_put_contents($file_test_csv, $csv_string);

		$csv_file_as_array = tool_common::read_csv_file_as_array($file_test_csv);

		$this->assertTrue(
			gettype($csv_file_as_array)==='array',
			'expected type is array'
				.' and is : '.gettype($csv_file_as_array)
		);

		if (isset($csv_file_as_array[0])) {
			$this->assertTrue(
				gettype($csv_file_as_array[0])==='array',
				'expected type is array'
					.' and is : '.gettype($csv_file_as_array[0])
			);
			if (isset($csv_file_as_array[0][1])) {
				$this->assertTrue(
					$csv_file_as_array[0][1]==='dd200',
					'expected dd200'
						.' value for csv_file_as_array[0][1] : '. to_string($csv_file_as_array[0][1])
				);
			}
		}
	}//end test_read_csv_file_as_array



	/**
	* TEST_READ_CSV_FILE_AS_ARRAY_BLANK_LINES
	* Blank lines (fgetcsv returns [null]) must be skipped, not crash trim()
	* @return void
	*/
	public function test_read_csv_file_as_array_blank_lines() {

		$directory = DEDALO_UPLOAD_TMP_DIR . '/test';
		if (!is_dir($directory)) {
			mkdir($directory, 0750, true);
		}
		$file_test_csv = $directory . '/blank_lines.csv';

		// BOM + blank first line + blank middle line + trailing blank lines
		file_put_contents($file_test_csv, pack('H*','EFBBBF') . "\n\"section_id\";\"dd200\"\r\n\r\n\"1\";\" a \"\n;\n\n\n");

		$this->assertSame(
			[['section_id','dd200'], ['1','a'], ['','']],
			tool_common::read_csv_file_as_array($file_test_csv)
		);

		// skip_header keeps original keys (starts at 1)
		$this->assertSame(
			[1 => ['1','a'], 2 => ['','']],
			tool_common::read_csv_file_as_array($file_test_csv, true)
		);

		// BOM before quoted first cell must not leave literal quotes
		file_put_contents($file_test_csv, pack('H*','EFBBBF') . "\"section_id\";\"dd200\"\n");

		$this->assertSame(
			[['section_id','dd200']],
			tool_common::read_csv_file_as_array($file_test_csv)
		);

		// non UTF-8 line followed by blank line (mb_convert_encoding path)
		file_put_contents($file_test_csv, "\"1\";\"caf\xE9\"\n\n\"2\";\"b\"\n");

		$this->assertSame(
			[['1','café'], ['2','b']],
			tool_common::read_csv_file_as_array($file_test_csv)
		);
	}//end test_read_csv_file_as_array_blank_lines



	/**
	* TEST_GET_USER_TOOLS
	* @return void
	*/
	public function test_get_user_tools() {

		$user_tools = tool_common::get_user_tools(1);

		$this->assertTrue(
			gettype($user_tools)==='array',
			'expected type is array'
				.' and is : '.gettype($user_tools)
		);

		if (isset($user_tools[0])) {
			$this->assertTrue(
				!empty($user_tools[0]),
				'expected not empty'
					.' file: : '. to_string($user_tools[0])
			);
		}
	}//end test_get_user_tools



}//end class tool_common_test
