<?php
// declare(strict_types=1);
/**
* TR
* Da servicio a las transcripciones (component_text_area) pero también a las partes públicas.
* Esta clase es genérica y debe servir también para las partes públicas.
* Cuando se use fuera de Dédalo, copiar este fichero.
* Para poder aprovechar las mejoras y corrección de errores del desarrollo de Dédalo, llevar control de versión de esta clase
*/
abstract class TR {



	// Version. Important!
	static $version = "2.0.0"; // 07-07-2022

	// html_tags_allowed (note that now is not used to save data)
	static $html_tags_allowed = '<strong><em><p><img><p>'; // <strong><em><br><img><p><h5><h6><ul><ol><li>



	/**
	* GET_MARK_PATTERN
	* Get unified patterns for marks
	* @param string $mark
	* @param bool $standalone=true
	* @param string|int|false $id = false
	* @param string|false $data=false
	* @param string|false $state=false
	* @return string $string
	*/
	public static function get_mark_pattern(string $mark, bool $standalone=true, $id=false, $data=false, $state=false) : string {

		switch($mark) {

			# TC . Select timecode from tag like '00:01:25.627'
			case 'tc' :
				$string = "(\[TC_([0-9]{1,2}:[0-9]{1,2}:[0-9]{1,2}(\.[0-9]{1,3})?)_TC\])";
				break;

			# TC_FULL . Select complete tag like '[TC_00:01:25.627_TC]'
			case 'tc_full' :
				$string = "(\[TC_[0-9]{1,2}:[0-9]{1,2}:[0-9]{1,2}\.[0-9]{1,3}_TC\])";
				break;

			# TC_VALUE . Select elements from value tc like '00:01:25.627'. Used by OptimizeTC
			case 'tc_value' :
				$string = "([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2})(\.([0-9]{1,3}))?";
				break;

			# INDEX
			case 'index' :
				if ($id!==false) {
					$string = "\[\/{0,1}index-[a-z]-{$id}(-[^-]{0,22}-data:.*?:data)?\]";
				}elseif ($state!==false) {
					$string = "\[\/{0,1}(index)-{$state}-([0-9]{1,6})(-([^-]{0,22})-data:(.*?):data)?\]";
				}else{
					$string = "\[\/{0,1}(index)-([a-z])-([0-9]{1,6})(-([^-]{0,22})-data:(.*?):data)?\]";
				}
				break;

			case 'indexIn' :
				if ($id) {
					$string = "(\[index-[a-z]-{$id}(-[^-]{0,22}-data:.*?:data)?\])";
					// $string = "(\[index\-[a-z]\-{$id}(\-[^-]{0,22}\-data:.*?:data)?\])";
				}else{
					$string = "(\[(index)-([a-z])-([0-9]{1,6})(-([^-]{0,22})-data:(.*?):data)?\])";
					// $string = "(\[(index)\-([a-z])\-([0-9]{1,6})(\-([^-]{0,22})\-data:(.*?):data)?\])";
				}
				break;

			case 'indexOut':
				if ($id) {
					$string = "(\[\/index-[a-z]-{$id}(-[^-]{0,22}-data:.*?:data)?\])";
					// $string = "(\[\/index\-[a-z]\-{$id}(\-[^-]{0,22}\-data:.*?:data)?\])";
				}else{
					$string = "(\[\/(index)-([a-z])-([0-9]{1,6})(-([^-]{0,22})-data:(.*?):data)?\])";
					// $string = "(\[\/(index)\-([a-z])\-([0-9]{1,6})(\-([^-]{0,22})\-data:(.*?):data)?\])";
				}
				break;

			# REFERENCE
			case 'reference' :
				if ($id) {
					$string = "\[\/{0,1}reference-[a-z]-{$id}(-[^-]{0,22}-data:.*?:data)?\]";
				}else{
					$string = "\[\/{0,1}(reference)-([a-z])-([0-9]{1,6})(-([^-]{0,22})-data:(.*?):data)?\]";
				}
				break;

			case 'referenceIn' :
				if ($id) {
					$string = "(\[reference-[a-z]-{$id}(-[^-]{0,22}-data:.*?:data)?\])";
				}else{
					$string = "(\[(reference)-([a-z])-([0-9]{1,6})(-([^-]{0,22})-data:(.*?):data)?\])";
				}
				break;

			case 'referenceOut' :
				if ($id) {
					$string = "(\[\/reference-[a-z]-{$id}(-[^-]{0,22}-data:.*?:data)?\])";
				}else{
					$string = "(\[\/(reference)-([a-z])-([0-9]{1,6})(-([^-]{0,22})-data:(.*?):data)?\])";
				}
				break;

			# SVG (From now 18-05-2018 v4.9.0, will be used to manage tags from the component component_svg)
			case 'svg' :
				if ($id) {
					$string = "(\[svg-[a-z]-{$id}(-[^-]{0,22}-data:.*?:data)?\])";
				}else{
					$string = "(\[(svg)-([a-z])-([0-9]{1,6})(-([^-]{0,22}))?-data:(.*?):data\])";
				}
				break;
			case 'svg_full_text' :
				$string = "\[svg-[a-z]-[0-9]{1,6}-[^-]{0,22}?-data:.*?:data\]";
				break;

			# DRAW (Old svg renamed 18-05-2018. Pre 4.9.0 . Now manage images over draws js paper data)
			case 'draw' :
				if ($id) {
					$string = "(\[draw-[a-z]-{$id}(-[^-]{0,22}-data:.*?:data)?\])";
				}else{
					$string = "(\[(draw)-([a-z])-([0-9]{1,6})(-([^-]{0,22}))?-data:(.*?):data\])";
				}
				break;

			# GEO
			case 'geo' :
				if ($id) {
					$string = "(\[geo-[a-z]-{$id}(-[^-]{0,22}-data:.*?:data)?\])";
				}else{
					$string = "(\[(geo)-([a-z])-([0-9]{1,6})(-([^-]{0,22}))?-data:(.*?):data\])";
				}
				break;
			# GEO_FULL . Select complete tag
			case 'geo_full' :
				$string = "(\[geo-[a-z]-[0-9]{1,6}(-[^-]{0,22})?-data:(.*?):data\])";
				break;

			# PAGE (pdf) [page-n-3]
			case 'page' :
				if ($id) {
					$string = "\[page-[a-z]-{$id}(-[^-]{0,22}-data:.*?:data)?\]";
				}else{
					$string = "(\[(page)-([a-z])-([0-9]{1,6})(-([^-]{0,22})-data:(.*?):data)?\])";
				}
				break;

			# PERSON (transcription spoken person) like [person-a-number-data:{"section_tipo":"dd15","section_id":"5"}:data]
			case 'person' :
				if ($id) { // id is pseudo locator as dd35_oh1_52 (section_tipo section_id)
					$string = "(\[person-[a-z]-{$id}(-[^-]{0,22}-data:.*?:data)?\])";
				}else{
					$string = "(\[(person)-([a-z])-([0-9]{0,6})-([^-]{0,22})-data:(.*?):data\])";
				}
				break;

			# NOTE (transcription annotations) like [note-n-number-data:{"section_tipo":"dd15","section_id":"5"}:data]
			case 'note' :
				if ($id) { // id is pseudo locator as dd35_oh1_52 (section_tipo section_id)
					$string = "(\[note-[a-z]-{$id}(-[^-]{0,22}-data:.*?:data)?\])";
				}else if($state!==false){
					$string = "(\[(note)-($state)-([0-9]{1,6})(-([^-]{0,22}))?-data:(.*?):data\])";
					}else{
						$string = "(\[(note)-([a-z])-([0-9]{1,6})(-([^-]{0,22}))?-data:(.*?):data\])";
					}
				break;

			# LANG (transcription annotations) like [lang-n-number-data:"lg-spa":data]
			case 'lang' :
				if ($id) { // id is pseudo locator as dd35_oh1_52 (section_tipo section_id)
					$string = "(\[lang-[a-z]-{$id}(-[^-]{0,22}-data:.*?:data)?\])";
				}else if($state!==false){
					$string = "(\[(lang)-($state)-([0-9]{1,6})(-([^-]{0,22}))?-data:(.*?):data\])";
					}else{
						$string = "(\[(lang)-([a-z])-([0-9]{1,6})(-([^-]{0,22}))?-data:(.*?):data\])";
					}
				break;

			# OTHERS
			case 'br' :
					$string = '\<br>';
					break;

			case 'p' :
				$string = '(\<\/?p\>)';
				break;

			case 'strong' :
				#$string = '(\<strong\>|\<\/strong\>)';
				$string = '(\<\/?strong\>)';
				break;

			case 'em' :
				#$string = '(\<em\>|\<\/em\>)';
				$string = '(\<\/?em\>)';
				break;

			case 'apertium-notrans' :
				$string = '(\<apertium-notrans\>|\<\/apertium-notrans\>)';
				break;

			default :
				trigger_error("Error Processing Request. Error: mark: '$mark' is not valid !");
				throw new Exception("Error Processing Request. Error: mark: '$mark' is not valid !", 1);
		}

		# default mark have in and out slash (pattern standalone)
		if($standalone) $string = '/'.$string.'/';


		return $string;
	}//end get_mark_pattern



	/**
	* ADD_TAG_IMG_ON_THE_FLY
	* Convert Dédalo tags like index, tc, etc. to images
	* @param mixed $text (non-string values are normalized)
	* @param object|null $request_options = null
	* @return string $text
	*/
	public static function add_tag_img_on_the_fly( mixed $text, ?object $request_options=null ) : string {

		// text. Normalize unexpected stored values (int, array, null..) to string
			if (!is_string($text)) {
				$text = is_null($text)
					? ''
					: (is_scalar($text) ? (string)$text : (string)json_encode($text));
			}

		// $hilite=false, $indexEditable=false, $tcEditable=true, $svgEditable=true, $geoEditable=true, $pageEditable=true,  $personEditable=true

		// Temporal (for catch old calls only)
			if (is_bool($request_options)) {
				throw new Exception("Error. Only a object is valid for add_tag_img_on_the_fly options. Update your call to new format please", 1);
			}

		// options
			$options = new stdClass();
				$options->hilite			= false;
				$options->indexEditable		= false;
				$options->tcEditable		= false;
				$options->svgEditable		= false;
				$options->geoEditable		= false;
				$options->pageEditable		= false;
				$options->personEditable	= false;
				$options->noteEditable		= false;
				$options->tag_url			= '../component_text_area/tag';
				$options->force_tr_tags_cdn	= false;
				if(!empty($request_options)) {
					foreach ($request_options as $key => $value) {if (property_exists($options, $key)) $options->$key = $value;}
			}

		// hilite
			// $codeHiliteIn = ($options->hilite===true)
			// 	? '<span class="hilite">'
			// 	: '';
			// $codeHiliteOut = ($options->hilite===true)
			// 	? '</span>'
			// 	: '';

		// tag_URL. url path to php script that render image
			$tag_url = (defined('TR_TAGS_CDN') && $options->force_tr_tags_cdn!==false)
				? TR_TAGS_CDN . '/?id='
				: $options->tag_url . '/?id='; //'?'

		# INDEX IN
		$pattern 	= TR::get_mark_pattern('indexIn'); // id,state,label,data
		$text		= preg_replace($pattern, "<img id=\"[$2-$3-$4-$6]\" src=\"{$tag_url}[$2-$3-$4-$6]\" class=\"index\" data-type=\"indexIn\" data-tag_id=\"$4\" data-state=\"$3\" data-label=\"$6\" data-data=\"$7\">" , $text) ?? $text;
		#$text		= preg_replace($pattern, "<img id=\"[$2-$3-$4-$6]\" src=\"\" class=\"index\" data-type=\"indexIn\" data-tag_id=\"$4\" data-state=\"$3\" data-label=\"$6\" data-data=\"$7\">" , $text);

		# INDEX OUT
		$pattern 	= TR::get_mark_pattern('indexOut');
		$text		= preg_replace($pattern, "<img id=\"[/\$2-$3-$4-$6]\" src=\"{$tag_url}[/\$2-$3-$4-$6]\" class=\"index\" data-type=\"indexOut\" data-tag_id=\"$4\" data-state=\"$3\" data-label=\"$6\" data-data=\"$7\">", $text) ?? $text;
		#$text		= preg_replace($pattern, "<img id=\"[$2-$3-$4-$6]\" src=\"\" class=\"index\" data-type=\"indexIn\" data-tag_id=\"$4\" data-state=\"$3\" data-label=\"$6\" data-data=\"$7\">" , $text);

		# REFERENCE IN
		$pattern 	= TR::get_mark_pattern('referenceIn');
		// <reference class="reference" id="reference_2" data-state="n" data-label="" data-data="{'section_tipo':'rsc370','section_id':'3'}">
		$text		= preg_replace($pattern, "<reference id=\"reference_$4\" class=\"reference\" data-type=\"reference\" data-tag_id=\"$4\" data-state=\"$3\" data-label=\"$6\" data-data=\"$7\">" , $text) ?? $text;

		# REFERENCE OUT
		$pattern 	= TR::get_mark_pattern('referenceOut');
		$text		= preg_replace($pattern, "</reference>", $text) ?? $text;

		# TC
		$pattern 	= TR::get_mark_pattern('tc'); //[TC_00:00:25.091_TC]
		$text		= preg_replace($pattern, "<img id=\"$1\" src=\"{$tag_url}$1\" class=\"tc\" data-type=\"tc\" data-tag_id=\"$1\" data-state=\"n\" data-label=\"$2\" data-data=\"$2\">", $text) ?? $text;
		/*$text		= preg_replace_callback(
			$pattern,
			function($matches) {
				#dump($matches, ' matches ++ '.to_string());
				$_1 = $matches[1];
				$_2 = $matches[2];
				$id = 'tc_'.str_replace(array(':','.'),'_', $_2);
				$a = "<img id=\"$id\" src=\"\" class=\"tc\" data-type=\"tc\" data-tag_id=\"$_1\" data-state=\"n\" data-label=\"$_2\" data-data=\"$_2\">";
				return $a;
			},
			$text);*/

		# SVG
		$pattern 	= TR::get_mark_pattern('svg');
		preg_match($pattern, $text, $matches);
		if (!empty($matches)) {
			#$text		= preg_replace($pattern, "<img id=\"[$2-$3-$4-$6]\" src=\"{$tag_url}/[$2-$3-$4-$6]\" class=\"svg\" data-type=\"svg\" data-tag_id=\"$4\" data-state=\"$3\" data-label=\"$6\" data-data=\"$7\">", $text);
			#$text		= preg_replace($pattern, '<img id="['.${2}.'-'.${3}.'-'.${4}.'-'.${6}.']" src="'. ${7} .'" class="svg" data-type="svg" data-tag_id="'.${4}.'" data-state="'.${3}.'" data-label="'.${6}.'" data-data="'.${7}.'">', $text);
			$text = preg_replace_callback(
				$pattern,
				function ($matches) {

					$new_text = null;

					$_2 = $matches[2];
					$_3 = $matches[3];
					$_4 = $matches[4];
					$_5 = $matches[5];
					$_6 = $matches[6];
					$_7 = $matches[7];

					# data is a locator encoded as text
					# Restore double quotes from saved safe locator string
					$locator_text = str_replace('\'','"',$_7);
					$locator = json_decode($locator_text);
					if(is_object($locator) && isset($locator->component_tipo, $locator->section_tipo, $locator->section_id)) {

						try {
							$url = component_svg::get_url_from_locator($locator);
						} catch (Throwable $e) {
							debug_log(__METHOD__
								. ' Error resolving svg locator url: ' . $e->getMessage() . PHP_EOL
								. ' locator: ' . $locator_text
								, logger::ERROR
							);
							return $matches[0];
						}

						# Replace double quotes for safe management in text editor
						$data = str_replace('"','\'',$_7);

						$new_text = '<img id="['.$_2.'-'.$_3.'-'.$_4.'-'.$_6.']" src="'.$url.'" class="svg" data-type="svg" data-tag_id="'.$_4.'" data-state="'.$_3.'" data-label="'.$_6.'" data-data="'.$data.'">';

					}
					return $new_text;
				},
				$text
			) ?? $text;
		}

		# DRAW
		$pattern	= TR::get_mark_pattern('draw');
		#$text		= preg_replace($pattern, "<img id=\"$1\" src=\"{$tag_url}/$1\" class=\"svg\" />$codeHiliteOut", $text);
		$text		= preg_replace($pattern, "<img id=\"[$2-$3-$4-$6]\" src=\"{$tag_url}[$2-$3-$4-$6]\" class=\"draw\" data-type=\"draw\" data-tag_id=\"$4\" data-state=\"$3\" data-label=\"$6\" data-data=\"$7\">", $text) ?? $text;

		# GEO
		$pattern	= TR::get_mark_pattern('geo');
		#$text		= preg_replace($pattern, "<img id=\"$1\" src=\"{$tag_url}/$1\" class=\"geo\" />$codeHiliteOut", $text);
		$text		= preg_replace($pattern, "<img id=\"[$2-$3-$4-$6]\" src=\"{$tag_url}[$2-$3-$4-$6]\" class=\"geo\" data-type=\"geo\" data-tag_id=\"$4\" data-state=\"$3\" data-label=\"$6\" data-data=\"$7\">", $text) ?? $text;

		# PAGE
		$pattern	= TR::get_mark_pattern('page');
		$text		= preg_replace($pattern, "<img id=\"[$2-$3-$4-$6]\" src=\"{$tag_url}[$2-$3-$4-$6]\" class=\"page\" data-type=\"page\" data-tag_id=\"$4\" data-state=\"$3\" data-label=\"$6\" data-data=\"$7\">", $text) ?? $text;

		# PERSON
		$pattern	= TR::get_mark_pattern('person'); // $string = "(\[person-([a-z])-(.+)-data:.*?:data\])";
		$text		= preg_replace($pattern, "<img id=\"[$2-$3-$4-$5]\" src=\"{$tag_url}[$2-$3-$4-$5]\" class=\"person\" data-type=\"person\" data-tag_id=\"$4\" data-state=\"$3\" data-label=\"$5\" data-data=\"$6\">", $text) ?? $text;
		#$text		= preg_replace($pattern, "<img id=\"[$2-$3-$4-$5]\" src=\"{$tag_url}/[$2-$3-$4-$5]\" class=\"person\" data-type=\"person\" data-tag_id=\"$4\" data-state=\"$3\" data-label=\"$5\" data-data=\"$6\">", $text);

		# NOTE
		$pattern	= TR::get_mark_pattern('note'); // $string = "(\[note-([a-z])-(.+)-data:.*?:data\])";
		$text		= preg_replace($pattern, "<img id=\"[$2-$3-$4-$6]\" src=\"{$tag_url}[$2-$3-$4-$6]\" class=\"note\" data-type=\"note\" data-tag_id=\"$4\" data-state=\"$3\" data-label=\"$6\" data-data=\"$7\">", $text) ?? $text;
		#$text		= preg_replace($pattern, "<img id=\"[$2-$3-$4-$6]\" src=\"\" class=\"note\" data-type=\"note\" data-tag_id=\"$4\" data-state=\"$3\" data-label=\"$6\" data-data=\"$7\">", $text);

		# lang
		$pattern	= TR::get_mark_pattern('lang'); // $string = "(\[lang-([a-z])-(.+)-data:.*?:data\])";
		$text		= preg_replace($pattern, "<img id=\"[$2-$3-$4-$6]\" src=\"{$tag_url}[$2-$3-$4-$6]\" class=\"lang\" data-type=\"lang\" data-tag_id=\"$4\" data-state=\"$3\" data-label=\"$6\" data-data=\"$7\">", $text) ?? $text;


		return $text;
	}//end add_tag_img_on_the_fly



	/**
	* ADDBABELTAGSONTHEFLY
	* Set an array of tags to preserve in translation and wrap it into appertium notrans tags
	* @param string $text
	* @return string $text
	*/
	public static function addBabelTagsOnTheFly(string $text) : string {

		$ar_tags = [
			'indexIn',
			'indexOut',
			'tc',
			'svg',
			'geo',
			'page',
			'person',
			'note',
			'reference'
			//'strong','em',
		];
		foreach ($ar_tags as $tag) {
			$pattern	= TR::get_mark_pattern($tag);
			$text		= preg_replace($pattern, "<apertium-notrans>$0</apertium-notrans>", $text);
			#if ($tag=='reference') {
			#	dump($text, ' text ++ pattern: '.to_string($pattern));
			#}
		}


		return $text;
	}//end addBabelTagsOnTheFly



	/**
	* DELETEMARKS
	* clean text to translate/subtitles
	* @param string $string
	* @param object|null $options
	* @return string $string
	*/
	public static function deleteMarks( string $string, ?object $options=null ) : string {

		// options
			$deleteTC			= $options->deleteTC ?? true;
			$deleteIndex		= $options->deleteIndex ?? true;
			$deleteSvg			= $options->deleteSvg ?? true;
			$deleteDraw			= $options->deleteDraw ?? true;
			$deleteGeo			= $options->deleteGeo ?? true;
			$delete_page		= $options->delete_page ?? true;
			$delete_person		= $options->delete_person ?? true;
			$delete_note		= $options->delete_note ?? true;
			$delete_reference	= $options->delete_reference ?? true;
			$delete_lang		= $options->delete_lang ?? true;

		// TC clear
		if($deleteTC===true) {
			$pattern = TR::get_mark_pattern('tc');
			$string = preg_replace($pattern, '', $string);	// delete TC tag
		}

		// Index clear
		if($deleteIndex===true) {
			$pattern	= TR::get_mark_pattern('index');
			$string		= preg_replace($pattern, '', $string);
		}

		// Svg clear
		if($deleteSvg===true) {
			$pattern	= TR::get_mark_pattern('svg');
			$string		= preg_replace($pattern, '', $string);
		}

		// Draw clear
		if($deleteDraw===true) {
			$pattern	= TR::get_mark_pattern('draw');
			$string		= preg_replace($pattern, '', $string);
		}

		// Geo clear
		if($deleteGeo===true) {
			$pattern	= TR::get_mark_pattern('geo');
			$string		= preg_replace($pattern, '', $string);
		}

		// Page clear
		if($delete_page===true) {
			$pattern	= TR::get_mark_pattern('page');
			$string		= preg_replace($pattern, '', $string);
		}

		// Person clear
		if($delete_person===true) {
			$pattern	= TR::get_mark_pattern('person');
			$string		= preg_replace($pattern, '', $string);
		}

		// Note clear
		if($delete_note===true) {
			$pattern	= TR::get_mark_pattern('note');
			$string		= preg_replace($pattern, '', $string);
		}

		// references clear
		if($delete_reference===true) {
			$pattern	= TR::get_mark_pattern('reference');
			$string		= preg_replace($pattern, '', $string);
		}

		// lang clear
		if($delete_lang===true) {
			$pattern	= TR::get_mark_pattern('lang');
			$string		= preg_replace($pattern, '', $string);
		}


		return $string;
	}//end deleteMarks



	/**
	* BUILD_TAG
	* Create a normalized tag (only index tags are defined now) from params
	* @see component_text_area::change_tag_state()
	* @param string $type
	* @param string $state
	* @param string|int $id
	* @param string $label
	* @param string $data
	* @return string $tag
	*/
	public static function build_tag(string $type, string $state, $id, string $label, string $data) : string {

		# Safe data for JSON
		$data = str_replace('"', "'", $data);

		switch ($type) {
			case 'indexIn':
				$tag = '[index-'.$state.'-'.$id.'-'.$label.'-data:'.$data.':data]';
				break;
			case 'indexOut':
				$tag = '[/index-'.$state.'-'.$id.'-'.$label.'-data:'.$data.':data]';
				break;
			case 'person':
				$tag = '[person-'.$state.'-'.$id.'-'.$label.'-data:'.$data.':data]';
				break;
			case 'draw':
				$tag = '[draw-'.$state.'-'.$id.'-'.$label.'-data:'.$data.':data]';
				break;
			default:
				// throw new Exception("Error Processing Request. Unimplemented build_tag of type: ".to_string($type), 1);
				debug_log(__METHOD__
					. " Error Processing Request. Unimplemented build_tag of type " . PHP_EOL
					. ' type: ' . to_string($type)
					, logger::ERROR
				);
				$tag = '';
				break;
		}


		return $tag;
	}//end build_tag



	/**
	* MATCH_PATTERN_INDEX_FROM_TAG
	* Using pattern like: \[\/{0,1}(index)-([a-z])-([0-9]{1,6})(-([^-]{0,22})-data:(.*?):data)?\]
	* @param string $tag
	* @param string $type='index'
	* @return array|null
	*/
	public static function match_pattern_index_from_tag(string $tag, string $type='index') : ?array {

		$pattern = TR::get_mark_pattern($type, false);
		if(preg_match_all("/$pattern/", $tag, $matches, PREG_PATTERN_ORDER)) {
			return $matches;
		}

		return null;
	}//end match_pattern_index_from_tag



	# TAG2TYPE
	public static function tag2type(string $tag) : ?string {

		$match_pattern 	= TR::match_pattern_index_from_tag($tag);
		$type 			= $match_pattern[1][0] ?? null;

		return $type;
	}
	# TAG2STATE
	public static function tag2state(string $tag) : ?string {

		$match_pattern 	= TR::match_pattern_index_from_tag($tag);
		$state 			= $match_pattern[2][0] ?? null;

		return $state;
	}
	# TAG2VALUE. Convert tag to value
	public static function tag2value(string $tag) : ?int {

		$match_pattern	= TR::match_pattern_index_from_tag($tag);
		$value			= isset($match_pattern[3][0])
			? (int)$match_pattern[3][0]
			: null;

		return $value;
	}
	# CONVERT tag to label
	public static function tag2label(string $tag) : ?string {

		$match_pattern 	= TR::match_pattern_index_from_tag($tag);
		$value 			= $match_pattern[5][0] ?? null;

		return (string)$value;
	}//end tag2label
	/**
	* TAG2DATA
	* Convert tag to data
	* @param string $tag
	*	Complete tag string like [index-n-7-Label-data:{'key':'value'}:data]
	* @return object | null
	*	Try to parse json data as object. If not is possible parse, return null
	*/
	public static function tag2data(string $tag, string $type='index') : ?object {

		$match_pattern	= TR::match_pattern_index_from_tag($tag, $type);
		$string			= $match_pattern[6][0] ?? null;
		if (!is_null($string)) {
			#$value_string	= preg_replace("'", '"', $string);
			$value_string	= str_replace("'", '"', $string);
			$value			= json_decode($value_string);
		}else{
			$value = null;
		}

		return $value;
	}//end tag2data



	# Limpieza del POST del formulario de TR transcripción
	# Temporalmente habilitamos la función de formateo de TC's para Gerard
	#
	public static function conform_tr_data(string $value) : string {

		// convert br to <p>
		# $value	= preg_replace('/(<\/? ?br>)/i', '</p><p>', $value);

		# strip slashes (need for text received from editor)
		$value = trim(stripslashes($value));

		return $value;
	}//end conform_tr_data



	#Change the format for TC to TC with ms
	public static function formatTC_to_TCms(string $string) : string {
		# Specific code for old transcriptions TC convert like [TC_01:25:11_TC] to [TC_01:25:11.332_TC]
		#
		$pattern	= '/([0-9][0-9]):([0-9][0-9]):([0-9][0-9])/' ;
		$string		= addslashes( preg_replace($pattern, '$1:$2:$3.000', stripslashes($string) ) );
		$string		= stripslashes($string) ;

		$result = $string ;

		return $result ;
	}//end formatTC_to_TCms



	# multipleSpaces2One
	public static function multipleSpaces2One(string $string) : string {

		# utf-8 spaces
		#$ar = array('&#x20;','&#xA0;' ,'&#X202F;','&#x2003;','&#x2000;','&#x2007;','&#x2001;','&#x2002;','&#x2003;','&#x2004;','&#x2005;','&#x2006;','&#x2007;','&#x2008;','&#x2009;','&#x200A;', '&#x200B;','&#xFEFF;');	#%2C%C2%A0%C2%A0%C2%A0%C2%A0%C2%A0%C2%A0%C2%A0+
		$string = urlencode($string);
		# urlencode spaces
		$ar = array('&nbsp;','%C2%A0');
		$string = str_replace($ar, ' ', $string );
		$string = preg_replace("/\ +/", ' ', $string);	# eliminate doubles spaces over urlencode string
		$string = urldecode($string);

		# eliminate invisible chars
		#$string = preg_replace("/\s+/", ' ', $string);
		#$string = preg_replace("/\s/", ' ', $string);
		$string = preg_replace("/\ +/", ' ', $string);

		return $string ;
	}//end multipleSpaces2One



	/**
	* trInfo
	* Info de los TC e Indexaciones de un texto (transcripción)
	*/
	public static function trInfo(string $texto) : ?string {

		$fragmentoFull	= $texto ;
		$html			= null;

		// TC
		$pattern = TR::get_mark_pattern('tc');
		preg_match_all($pattern, $fragmentoFull, $matches);
		$nTCs = count($matches[0]);

		// INDEX
		$pattern = TR::get_mark_pattern('indexIn');
		preg_match_all($pattern, $fragmentoFull, $matches);
		$nIndex = count($matches[0]);

		if($nIndex >0) 	$html .= "<div class='h5div'> Index: $nIndex </div>";
		if($nTCs >0)	$html .= "<div class='h6div'> TC's: $nTCs  </div> ";

		return $html;
	}//end trInfo



	# clean text for list
	# prepara el texto para mostrar un extracto en los listados (sin tags ni tc's)
	public static function limpiezaFragmentoEnListados(string &$string, int $limit=160) : string {
		#dump( debug_backtrace() );
		# dump($string, ' string ++ '.to_string());
		$string = str_replace('<br />',' ', $string);

		// Clean ALL html tags
		$string = strip_tags($string);

		# eliminamos las marcas de tc e indexación
		$string	= TR::deleteMarks($string);

		# cortamos elegantemente el fragmento
		return self::truncate_text($string, $limit, $break=" ", $pad="...");
	}//end limpiezaFragmentoEnListados



	/**
	* TRUNCATE_TEXT
	*/
	public static function truncate_text(string $string, $limit, $break=" ", $pad="...") : string {

	  // return with no change if string is shorter than $limit
	  if(strlen($string) <= $limit) {
	  	return $string;
	  }

	  $string = substr($string, 0, $limit);
	  if( false !== ($breakpoint = strrpos($string, $break)) ) {
		$string = substr($string, 0, $breakpoint);
	  }

	  return $string . $pad;
	}//end truncate_text



	/**
	* GET_CHARS_INFO
	* @return object $chars_info
	*/
	public static function get_chars_info(string $raw_text) : object {

		$chars_info = new stdClass();

		#
		# CLEAN TEXT
		$text_clean = $raw_text;
		# clean text
		$text_clean = trim($text_clean);
		#$text_clean = htmlspecialchars_decode($text_clean);
		# Remove Dédalo marks
		$text_clean = TR::deleteMarks($text_clean);
		# Remove html tags like strong, br, etc.
		$text_clean = strip_tags($text_clean);
		# Decode special html chars
		#$text_clean = html_entity_decode($text_clean);
		$text_clean = htmlspecialchars_decode($text_clean);

		$text_clean = str_replace(array("&nbsp;")," ",$text_clean);


		# COUNT TOTAL_CHARS
		$chars_info->total_chars = mb_strlen($text_clean,'UTF-8'); 	#dump($total_chars, ' $total_chars ++ '.to_string());

		# Remove spaces and breaks
		$text_clean = str_replace(array("&nbsp;"," ","\n"),"",$text_clean);
		#$text_clean = preg_replace("/\s/", "", $text_clean);#  &nbsp;

		# COUNT total_chars_no_spaces
		$chars_info->total_chars_no_spaces = mb_strlen($text_clean,'UTF-8'); #dump($total_chars_no_spaces, ' $total_chars_no_spaces ++ '.to_string());


		return (object)$chars_info;
	}//end get_chars_info



	/**
	* GET_TAGS_OF_TYPE_IN_TEXT
	* Locate text tags from text
	* @param string $raw_text
	* @param array $ar_tag_types
	* @return array $ar_tags_of_type
	*/
	public static function get_tags_of_type_in_text(string $raw_text, array $ar_tag_types) : array {

		$ar_tags_of_type = array();

		foreach ($ar_tag_types as $type) {

			$tag_pattern = TR::get_mark_pattern($type);
			preg_match_all($tag_pattern,  $raw_text,  $matches, PREG_PATTERN_ORDER);
			foreach ($matches[0] as $tag) {

				$ar_tags_of_type[] = (object)[
					'type'	=> $type,
					'tag'	=> $tag
				];
			}
		}


		return $ar_tags_of_type;
	}//end get_tags_of_type_in_text



}//end class tr
