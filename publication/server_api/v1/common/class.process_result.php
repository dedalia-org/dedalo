<?php
// include_once(DEDALO_LIB_BASE_PATH.'/config/core_functions.php');

/**
* PROCESS_RESULT
* Util abstract class to manage data process_result
* Only static function are defined here
*/
abstract class process_result {



	/**
	* ADD_PARENTS_AND_CHILDREN_RECURSIVE
	* Resolves the parents and children of the search result and merges them with the result data
	* (used in MIB Catalog list)
	* @return object $ar_data
	*/
	public static function add_parents_and_children_recursive($ar_data, $options, $sql_options) {

		// options
			$columns = $options->columns;

		// $ar_section_id = array_map(function($el){
		// 	return $el['section_id'];
		// }, $ar_data);

		// ar_section_id
			$ar_section_id = [];
			$ar_parent_sentences = [];
			foreach ($ar_data as $key => $row) {

				// row
				foreach ($columns as $column_obj) {

					$column_name = $column_obj->name ?? null;
					// column names come from the request: plain names only
					if (!is_string($column_name) || preg_match('/^[A-Za-z0-9_]+$/D', $column_name)!==1) {
						continue;
					}

					if (isset($row[$column_name])) {
						$value = json_decode($row[$column_name]);
						if (!empty($value)) {
							foreach ((array)$value as $section_id) {
								$section_id = (int)$section_id;
								if (!in_array($section_id, $ar_section_id)) {
									$ar_section_id[] = $section_id;
								}
							}
						}
					}

					$ar_parent_sentences[] = '`'.$column_name.'` LIKE \'%"'. (int)$row['section_id'] .'"%\'';
				}
			}//foreach ($ar_data as $key => $row)


		// search 2
			// $children_sentences = array_map(function($item){
			// 	return 'section_id = ' . (int)$item;
			// }, $ar_section_id);
			$children_sentences[] = 'section_id IN (' . implode(',', $ar_section_id). ')';

			$all_sentences = array_merge($children_sentences, $ar_parent_sentences);
			$sql_filter = implode(' OR ', $all_sentences);

			$sql_options = clone $sql_options;
				$sql_options->process_result	= false; // avoid recursion
				$sql_options->sql_filter		= $sql_filter;
				$sql_options->count 			= false;

			$rows_data = web_data::get_rows_data($sql_options);

		// final merged result (avoiding duplicates)
			// $new_ar_data = array_merge($ar_data, $rows_data->result);
			$new_ar_data = $ar_data;
			foreach ($rows_data->result as $key => $value) {
				if (!in_array($value, $new_ar_data)) {
					$new_ar_data[] = $value;
				}
			}

			// check duplicates debug
				// $a = array_map(function($el){
				// 	return $el['section_id'];
				// }, $new_ar_data);
				// dump($a, ' a ++ '.to_string("1022"));

		// response
			$response = new stdClass();
				$response->ar_data = $new_ar_data;


		return $response;
	}//end add_parents_and_children_recursive



	/**
	* ADD_PARENTS_OR_CHILDREN
	* 	Aux private method
	* 	(!) requires a previous search
	* 	Search all parents/children of given rows
	*	Iterate all records data getting parents/children section_id. When are collected, search cloning previous search but
	* 	replacing filter with a list of collected section_id
	*
	* @param array $ar_data
	* 	Array of result (rows_data->result) from first search
	* @param object options
	* 	Default 'parents'
	* 	Expected as format: {columns_name : ['parents']}
	* @param object $sql_options
	* 	Previous search options to use as base for the new search (columns, etc.)
	*
	* @return object $rows_data
	*/
	public static function add_parents_or_children($ar_data, $options, $sql_options) {

		// options
			$columns_name = $options->columns_name;

		// ar_section_id
			$ar_section_id = [];
			foreach ($ar_data as $key => $row) {

				foreach ((array)$columns_name as $column_name) {

					if (isset($row[$column_name]) && !empty($row[$column_name])) {
						$value = json_decode($row[$column_name]);
						if (!empty($value)) {
							foreach ((array)$value as $section_id) {
								$section_id = (int)$section_id; // goes into 'section_id IN (...)'
								if (!in_array($section_id, $ar_section_id)) {
									$ar_section_id[] = $section_id;
								}
							}
						}
					}
				}
			}//foreach ($ar_data as $key => $row)

		// search
			$sql_filter = 'section_id IN (' . implode(',', $ar_section_id). ')';

			// clone source sql_options and overwrite specific params (preserves columns, etc.)
			$sql_options = clone $sql_options;
				$sql_options->process_result	= false; // avoid recursion
				$sql_options->sql_filter		= $sql_filter;
				$sql_options->count				= false;

			$rows_data = web_data::get_rows_data($sql_options);

		// final merged result (avoiding duplicates)
			$new_ar_data = $ar_data;
			foreach ($rows_data->result as $key => $value) {
				if (!in_array($value, $new_ar_data)) {
					$new_ar_data[] = $value;
				}
			}

		// response
			$response = new stdClass();
				$response->ar_data = $new_ar_data;


		return $response;
	}//end add_parents_or_children



	/**
	* BREAK_DOWN_TOTALS
	* Split and recalculate totals in a list of rows
	* Used for example to split mdcat interview informants place of birth when more than one informant or place exists
	* Like this case:
	* ref_lloc_naixement							ref_lloc_naixement_geojson
	* ["es1_3117"] | ["es1_3117"] | ["es1_3117"]	[{"layer_id":1,"text":"","layer_data":{"type":"FeatureCollection","features":[{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[2.821287,41.979888]}}]}}] | [{"layer_id":1,"text":"","layer_data":{"type":"FeatureCollection","features":[{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[2.821287,41.979888]}}]}}] | [{"layer_id":1,"text":"","layer_data":{"type":"FeatureCollection","features":[{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[2.821287,41.979888]}}]}}]
	* ex. {"fn":"process_result::break_down_totals","base_column":"term_id","total_column":"total","split_columns":["geojson"]}
	* @return object $ar_data
	*/
	public static function break_down_totals($ar_data, $options, $sql_options) {

		// options
			$base_column	= $options->base_column; // name of the source column like 'ref_lloc_naixement'
			$total_column	= $options->total_column ?? 'total'; // name of the totals column like 'total'
			$split_columns	= $options->split_columns ?? null; // array of columns to split synchronized with the base column
			$separator		= $options->separator ?? ' | ';

		// rows
			// dump($ar_data, ' ar_data ++================================================================ '.to_string());


		// fn create_new_rows
			function create_new_rows($base_value_raw, $ar_split_column_value_raw, $row, $base_column, $total_column, $split_columns, $k=0) {
					// dump($ar_split_column_value_raw, ' ar_split_column_value_raw ++ '.to_string());
					// dump($base_value_raw, ' base_value_raw +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++ '.to_string());
				$new_rows = [];
				foreach ($base_value_raw as $c_key => $c_value) {

					$c_value = is_array($c_value) ? $c_value : [$c_value];
					// dump($c_value, ' c_value ============================//////////////////////////// ++ c_key: '.to_string($c_key));

					// multiple case. Make a recursion here
					if (count($c_value)>1) {

						$ar_split_column_value_raw_partial = [];
						foreach ($ar_split_column_value_raw as $el_name => $el_value) {
							// dump($el_value, ' el_value +/////////////////////////////////////////////////////////////////////////////////////////////////////+ '.to_string());
							$to_set_value = is_array($el_value[$c_key]) ? $el_value[$c_key] : [$el_value[$c_key]];
							$ar_split_column_value_raw_partial[$el_name] = $to_set_value;
						}

						$result		= create_new_rows($c_value, $ar_split_column_value_raw_partial, $row, $base_column, $total_column, $split_columns, 0);
						$new_rows	= array_merge($new_rows, $result);

						continue;
					}

					// row
					$new_row = $row;
					$new_row[$base_column]	= json_encode($c_value, JSON_UNESCAPED_UNICODE);
					$new_row[$total_column]	= (int)$row[$total_column];


					// add split_columns if exists key coincidence
					foreach ($split_columns as $s_column) {
						// dump($ar_split_column_value_raw[$s_column], ' $ar_split_column_value_raw[$s_column] +///////////////////////////////////////////////////////////////////////////+ $c_key '.to_string($c_key));
						if (isset($ar_split_column_value_raw[$s_column][$c_key])) {

							$items		= $ar_split_column_value_raw[$s_column];
							$n_items	= count($items);
							// dump($ar_split_column_value_raw[$s_column], ' $ar_split_column_value_raw[$s_column][$c_key] ++////////////////////////// '.to_string("n_items: $n_items - c_key: $c_key"));

							$cr_value = $items[$c_key]; // ?? $items[0];
							$new_row[$s_column] = is_string($cr_value)
								? $cr_value
								: json_encode($cr_value, JSON_UNESCAPED_UNICODE);

							// debug
								// $new_row['c_key']		= $c_key;
								// $new_row['k']			= $k;
								// $new_row['n_items']		= $n_items;
								// $new_row['items']		= $items;
						}
					}

					// add created row
					$new_rows[] = $new_row;
				}

				return $new_rows;
			}//end create_new_rows


		// break down multiple values cases in ar_data
			$break_down_ar_data	= [];
			$ar_data_length		= count($ar_data);
			for ($i=0; $i < $ar_data_length; $i++) {

				$row = $ar_data[$i];

				$base_value		= $row[$base_column]; 	// ex. '["es1_3117","es1_1967"] | ["es1_3117"]'
				$total_value	= $row[$total_column]; 	// ex. 9

				// base_value_raw
					$base_value_raw = (strpos($base_value, $separator)!==false)
						? array_map(function($el) {
							return json_decode($el);
						  }, explode($separator, $base_value))
						: json_decode($base_value);
						// dump($base_value_raw, ' base_value_raw +--------------------------------+ '.count($base_value_raw));

					$n_base_value_raw = count($base_value_raw);
					if ($n_base_value_raw===1) {
						// add untouched
						$break_down_ar_data[] = $row;
					}else{
						// split_column_value_raw
							$ar_split_column_value_raw = [];
							foreach ($split_columns as $s_column) {
								$s_base_value = $row[$s_column];
								// dump($s_base_value, ' s_base_value +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++ '.to_string());
								$split_column_value_raw = (strpos($s_base_value, $separator)!==false)
									? array_map(function($el) {
										// dump($el, ' el ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++ '.to_string());
										$pr_value = (strpos($el, '[')===0 || strpos($el, '{')===0)
											? json_decode($el)
											: $el;
										// dump($pr_value, ' pr_value ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++ '.to_string());
										return $pr_value;
									  }, explode($separator, $s_base_value))
									: json_decode($s_base_value);
								// dump($split_column_value_raw, ' split_column_value_raw ++++++++++++++++++++++++++++++++++++++++++++++ '.to_string());
								$ar_split_column_value_raw[$s_column] = $split_column_value_raw;
							}
							// dump($ar_split_column_value_raw, ' ar_split_column_value_raw --------------------------------------------++ '.to_string());

						// iterate recursively
							$new_rows = create_new_rows($base_value_raw, $ar_split_column_value_raw, $row, $base_column, $total_column, $split_columns);
							foreach ($new_rows as $new_row) {
								$break_down_ar_data[] = $new_row;
							}
					}//end if ($n_base_value_raw===1)
			}//end ar_data for ($i=0; $i < $ar_data_length; $i++)
			// dump($break_down_ar_data, ' break_down_ar_data +************************************************+ '.to_string());


		// break_down_ar_data iterate already split rows
			$new_ar_data				= [];
			$break_down_ar_data_length	= count($break_down_ar_data);
			for ($i=0; $i < $break_down_ar_data_length; $i++) {

				$row			= $break_down_ar_data[$i];
				$base_value		= $row[$base_column]; 	// ex. '["es1_3117"] | ["es1_3117"]'
				$total_value	= $row[$total_column]; 	// ex. 9

				$found_key = array_search($base_value, array_column($new_ar_data, $base_column));
				if ($found_key!==false) {
					// sum totals
					$new_ar_data[$found_key][$total_column] = (int)$new_ar_data[$found_key][$total_column] + (int)$total_value;
				}else{
					// add untouched
					$new_ar_data[] = $row;
				}
			}//end break_down_ar_data for ($i=0; $i < $length; $i++)
			// dump($new_ar_data, ' new_ar_data ++////////////////////////////////////////////////////////////// '.to_string());


		// response
			$response = new stdClass();
				$response->ar_data = $new_ar_data;

		return $response;
	}//end break_down_totals



	/**
	* SUM_TOTALS
	* @return object $response
	*/
	public static function sum_totals($ar_data, $options, $sql_options) {

		// options
			$base_column	= $options->base_column; // name of the source column like 'ref_lloc_naixement'
			$total_column	= $options->total_column ?? 'total'; // name of the totals column like 'total'
			$split_columns	= $options->split_columns ?? null; // array of columns to split synchronized with the base column
			$separator		= $options->separator ?? ' | ';

		// break down multiple values cases in ar_data
			$break_down_ar_data	= [];

			$ar_data_length = count($ar_data);
			for ($i=0; $i < $ar_data_length; $i++) {

				$row = $ar_data[$i];

				// ar_term_id
					$ar_term_id = isset($row['term_id'])
						? json_decode($row['term_id'])
						: null;
						if (empty($ar_term_id)) continue; // empty case

				// ar_term
					$ar_term = isset($row['term'])
						? explode(' | ', $row['term'])
						: [];

				// ar_geojson
					$ar_geojson = isset($row['geojson'])
						? json_decode($row['geojson'])
						: [];

				foreach ($ar_term_id as $key => $term_id) {

					if (!isset($break_down_ar_data[$term_id])) {

						// new item
						$break_down_ar_data[$term_id] = new stdClass();
						$break_down_ar_data[$term_id]->term_id		= $term_id;
						$break_down_ar_data[$term_id]->term			= $ar_term[$key] ?? '';
						$break_down_ar_data[$term_id]->geojson		= $ar_geojson[$key] ?? null;
						$break_down_ar_data[$term_id]->total		= 1;
						$break_down_ar_data[$term_id]->section_id	= [$row['section_id']];

					}else{

						// update item
						$break_down_ar_data[$term_id]->section_id[] = $row['section_id'];
						$break_down_ar_data[$term_id]->total++;
					}
				}
			}//end for ($i=0; $i < $ar_data_length; $i++)

		// remove keys
			$new_ar_data = array_values($break_down_ar_data);

		// json encode again
			$new_ar_data_final = array_map(function($el){
				if ($el->geojson!==null) {
					$el->geojson = json_encode($el->geojson);
				}
				$el->section_id = json_encode($el->section_id);
				return $el;
			}, $new_ar_data);

		// response
			$response = new stdClass();
				$response->ar_data = $new_ar_data_final;

		return $response;
	}//end sum_totals



	/**
	* RESOLVE_INDEXATION_FRAGMENTS
	* 	Resolve each indexation tag locator (normally in the column 'indexation') using 'get_fragment_from_index_locator' method
	* @return object $response
	* 	array ar_data (parsed rows)
	*/
	public static function resolve_indexation_fragments($ar_data, $options, $sql_options) {

		// options
			$column			= $options->column;
			$fragment_terms	= $options->fragment_terms ?? false;

		// lang
			$lang = $sql_options->lang ?? WEB_CURRENT_LANG_CODE;

		// rows
			$new_ar_data = [];
			foreach ($ar_data as $key => $row) {

				// locators are JSON encoded as string
				$locators = !empty($row[$column])
					? json_decode($row[$column])
					: null;

				if (!empty($locators)) {
					$fragments = array_map(function($index_locator) use($lang, $fragment_terms){

						$current_options = (object)[
							'index_locator'		=> $index_locator,
							'lang'				=> $lang,
							'fragment_terms'	=> $fragment_terms
						];

						$response = web_data::get_fragment_from_index_locator($current_options);

						if (empty($response->result)) {
							error_log('empty get_fragment_from_index_locator response: '.json_encode($response, JSON_PRETTY_PRINT));
						}

						return $response->result;
					}, $locators);

					// overwrite column value
					$row[$column] = $fragments;
				}

				$new_ar_data[] = $row;
			}


		// response
			$response = new stdClass();
				$response->ar_data = $new_ar_data;


		return $response;
	}//end resolve_indexation_fragments



}//end class process_result