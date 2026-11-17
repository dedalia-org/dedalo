// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0




/**
* ELEMENTS
* List of components to test
* Defines components that will be test
*/



import * as fn from './data.js'



export const elements = []



// components general values
export const section_tipo	= 'test3'
export const section_id		= 1
export const mode			= 'edit'
export const lang			= 'lg-eng'
export const permissions	= 2



// Per-suite test3 record isolation (WC-021 in-run isolation).
// Relation new_value_params[0] MUST be a section the caller's ontology declares as
// target (WC-2026-08-14-relation-insert-target-validation refuses `off_target`
// at the save door); section_id is int-canonical (WC-2026-08-10).
// The all-component save SWEEP (test_components_data_changes) writes to its
// own record (test3/10, overridden inside that suite), and the run-order
// fragile READ suites below bind their element to a private CLONE of record 1
// so the sweep never poisons the record they assert against. The clones are
// provisioned by the canonical seed (src/core/test_data/manifest.ts →
// SUITE_ISOLATION_RECORDS). Read-only suites keep the shared section_id (1).
export const date_section_id	= 11 // test_component_date owns test3/11
export const iri_section_id		= 12 // test_component_iri owns test3/12
export const geo_section_id		= 14 // test_component_geolocation owns test3/14
export const media_3d_section_id = 15 // test_component_3d owns test3/15
export const additional_text_area_section_id = 16 // test_additional_text_area owns test3/16
export const uca_maps_section_id = 17 // the tool_uca_maps suites own test3/17



// component_3d
	elements.push({
		model				: 'component_3d',
		tipo				: 'test26',
		section_tipo		: section_tipo,
		section_id			: media_3d_section_id, // own record (test3/15) — see per-suite isolation above
		mode				: mode,
		lang				: page_globals?.dedalo_data_nolan ?? 'lg-nolan',
		new_value			: fn.random_3d_value, // return array
		new_value_params	: [section_tipo, media_3d_section_id, 'test26'],
		new_value_action	: 'set_data'
		// test_save		: false
	})

// component_av
	elements.push({
		model				: 'component_av',
		tipo				: 'test94',
		section_tipo		: section_tipo,
		section_id			: section_id,
		mode				: mode,
		lang				: page_globals?.dedalo_data_nolan ?? 'lg-nolan',
		new_value			: fn.random_av_value, // return array
		new_value_params	: [section_tipo, section_id, 'test94'],
		new_value_action	: 'set_data'
		// test_save		: false
	})

// button
	// elements.push({
	// 	model			: 'button',
	// 	tipo			: 'test212',
	// 	section_tipo	: section_tipo,
	// 	section_id		: section_id,
	// 	mode			: mode,
	// 	lang			: page_globals?.dedalo_data_nolan ?? 'lg-nolan',
	// 	new_value		: fn.random_string,
	// 	test_save		: false
	// })

// component_calculation -to disappear-  (WORKING HERE)

// component_check_box
	elements.push({
		model				: 'component_check_box',
		tipo				: 'test88',
		section_tipo		: section_tipo,
		section_id			: section_id,
		mode				: mode,
		lang				: page_globals?.dedalo_data_nolan ?? 'lg-nolan',
		new_value			: fn.random_locator,
		new_value_params	: ['dd64','test88']
	})

// component_date
	elements.push({
		model				: 'component_date',
		tipo				: 'test145',
		section_tipo		: section_tipo,
		section_id			: date_section_id, // own record (test3/11) — see per-suite isolation above
		mode				: mode,
		lang				: page_globals?.dedalo_data_nolan ?? 'lg-nolan',
		new_value			: fn.random_date_value
	})

// component_email
	elements.push({
		model				: 'component_email',
		tipo				: 'test208',
		section_tipo		: section_tipo,
		section_id			: section_id,
		mode				: mode,
		lang				: page_globals?.dedalo_data_nolan ?? 'lg-nolan',
		new_value			: fn.random_email_value
	})

// component_external
	elements.push({
		model				: 'component_external',
		tipo				: 'test215',
		// section_tipo		: section_tipo,
		section_tipo		: 'zenon1',
		// section_id		: section_id,
		section_id			: '000147689',
		mode				: mode,
		lang				: page_globals?.dedalo_data_nolan ?? 'lg-nolan',
		new_value			: fn.random_external_value,
		test_save			: false
	})

// component_filter_master
	elements.push({
		model				: 'component_filter_master',
		tipo				: 'test70',
		section_tipo		: section_tipo,
		section_id			: section_id,
		mode				: mode,
		lang				: page_globals?.dedalo_data_nolan ?? 'lg-nolan',
		new_value			: fn.random_locator,
		new_value_params	: ['dd153','test70'] // [section_tipo, from_component_tipo, paginated_key]
	})

// component_filter_records
	elements.push({
		model				: 'component_filter_records',
		tipo				: 'test69',
		section_tipo		: section_tipo,
		section_id			: section_id,
		mode				: mode,
		lang				: page_globals?.dedalo_data_nolan ?? 'lg-nolan',
		new_value			: fn.random_filter_records_value,
		new_value_params	: [] // [section_tipo, from_component_tipo, paginated_key]
	})

// component_filter
	elements.push({
		model				: 'component_filter',
		tipo				: 'test101',
		section_tipo		: section_tipo,
		section_id			: section_id,
		mode				: mode,
		lang				: page_globals?.dedalo_data_nolan ?? 'lg-nolan',
		new_value			: fn.random_locator,
		new_value_params	: ['dd153','test101'] // [section_tipo, from_component_tipo, paginated_key]
	})

// component_geolocation
	elements.push({
		model				: 'component_geolocation',
		tipo				: 'test100',
		section_tipo		: section_tipo,
		section_id			: geo_section_id, // own record (test3/14) — see per-suite isolation above
		mode				: mode,
		lang				: page_globals?.dedalo_data_nolan ?? 'lg-nolan',
		new_value			: fn.random_geolocation,
		new_value_params	: [] // [section_tipo, from_component_tipo, paginated_key]
	})

// component grouper/sync ?????? (WORKING HERE)

// component_image
	elements.push({
		model				: 'component_image',
		tipo				: 'test99',
		section_tipo		: section_tipo,
		section_id			: section_id,
		mode				: mode,
		lang				: page_globals?.dedalo_data_nolan ?? 'lg-nolan',
		new_value			: fn.random_image_value,
		new_value_params	: [],
		new_value_action	: 'set_data'
		// test_save		: false
	})

// component_info
	elements.push({
		model			: 'component_info',
		tipo			: 'test212',
		section_tipo	: section_tipo,
		section_id		: section_id,
		mode			: mode,
		lang			: page_globals?.dedalo_data_nolan ?? 'lg-nolan',
		new_value		: fn.random_info_value,
		test_save		: false
	})

// component_input_text
	elements.push({
		model			: 'component_input_text',
		tipo			: 'test52',
		section_tipo	: section_tipo,
		section_id		: section_id,
		mode			: mode,
		lang			: lang,
		new_value		: fn.random_string_value,
		new_value_params: [lang]
	})

// component_inverse -section_id from caller-
	elements.push({
		model			: 'component_inverse',
		tipo			: 'test68',
		section_tipo	: section_tipo,
		section_id		: section_id,
		mode			: mode,
		lang			: page_globals?.dedalo_data_nolan ?? 'lg-nolan', // is nolan ?
		test_save		: false
	})

// component_ip -to disappear- (WORKING HERE)

// component_iri
	elements.push({
		model			: 'component_iri',
		tipo			: 'test140',
		section_tipo	: section_tipo,
		section_id		: iri_section_id, // own record (test3/12) — see per-suite isolation above
		mode			: mode,
		lang			: page_globals?.dedalo_data_nolan ?? 'lg-nolan', // is nolan ?
		new_value		: fn.random_iri_value
	})

// component_json
	elements.push({
		model			: 'component_json',
		tipo			: 'test18',
		section_tipo	: section_tipo,
		section_id		: section_id,
		mode			: mode,
		lang			: page_globals?.dedalo_data_nolan ?? 'lg-nolan',
		new_value		: fn.random_json_value
	})

// component_number
	elements.push({
		model			: 'component_number',
		tipo			: 'test211',
		section_tipo	: section_tipo,
		section_id		: section_id,
		mode			: mode,
		lang			: page_globals?.dedalo_data_nolan ?? 'lg-nolan',
		new_value		: fn.random_number_value
	})

// component_password
	elements.push({
		model			: 'component_password',
		tipo			: 'test152',
		section_tipo	: section_tipo,
		section_id		: section_id,
		mode			: mode,
		lang			: page_globals?.dedalo_data_nolan ?? 'lg-nolan',
		new_value		: fn.random_string_value,
		test_save		: false
	})

// component_pdf
	elements.push({
		model				: 'component_pdf',
		tipo				: 'test85',
		section_tipo		: section_tipo,
		section_id			: section_id,
		mode				: mode,
		lang				: lang,
		new_value			: fn.random_pdf_value,
		new_value_params	: [],
		new_value_action	: 'set_data'
		// test_save		: false
	})

// component_portal (basic v5 config)
	elements.push({
		model				: 'component_portal',
		tipo				: 'test80',
		section_tipo		: section_tipo,
		section_id			: section_id,
		mode				: mode,
		lang				: page_globals?.dedalo_data_nolan ?? 'lg-nolan',
		new_value			: fn.random_locator,
		new_value_params	: ['test3', 'test80', 0] // [section_tipo, from_component_tipo, paginated_key]
	})

// component_publication
	elements.push({
		model				: 'component_publication',
		tipo				: 'test92',
		section_tipo		: section_tipo,
		section_id			: section_id,
		mode				: mode,
		lang				: page_globals?.dedalo_data_nolan ?? 'lg-nolan',
		new_value			: fn.random_locator,
		new_value_params	: ['dd64','test92']
	})

// component_radio_button
	elements.push({
		model				: 'component_radio_button',
		tipo				: 'test87',
		section_tipo		: section_tipo,
		section_id			: section_id,
		mode				: mode,
		lang				: page_globals?.dedalo_data_nolan ?? 'lg-nolan',
		new_value			: fn.random_locator,
		new_value_params	: ['dd64','test87']
	})

// component_relation_children
	elements.push({
		model				: 'component_relation_children',
		tipo				: 'test201',
		section_tipo		: section_tipo,
		section_id			: section_id,
		mode				: mode,
		lang				: page_globals?.dedalo_data_nolan ?? 'lg-nolan',
		new_value			: fn.custom_locator,
		new_value_params	: [
			section_tipo, // section_tipo
			2, // section_id
			'test201', // from_component_tipo
			'dd48' // type
		],
		test_save			: false
	})

// component_relation_index
	elements.push({
		model				: 'component_relation_index',
		tipo				: 'test25',
		section_tipo		: section_tipo,
		section_id			: section_id,
		mode				: mode,
		lang				: page_globals?.dedalo_data_nolan ?? 'lg-nolan',
		new_value			: fn.random_locator,
		new_value_params	: ['es1','test25'],
		test_save			: false
		// test_exclude		: [
		// 	'save data equals'
		// ]
	})

// component_relation_model
	elements.push({
		model				: 'component_relation_model',
		tipo				: 'test169',
		section_tipo		: section_tipo,
		section_id			: section_id,
		mode				: mode,
		lang				: page_globals?.dedalo_data_nolan ?? 'lg-nolan',
		new_value			: fn.random_locator,
		new_value_params	: ['test2','test169']
	})

// component_relation_parent
	elements.push({
		model				: 'component_relation_parent',
		tipo				: 'test71',
		section_tipo		: section_tipo,
		section_id			: section_id,
		mode				: mode,
		lang				: page_globals?.dedalo_data_nolan ?? 'lg-nolan',
		// a parent link is read back from the other side (the target's children),
		// so it points at a record the saving suite BUILDS, never a drawn id
		// (owned_target.js — the GitHub run 38650819505 children red)
		new_value			: fn.target_locator, // (params, owned target section_id)
		new_value_params	: [section_tipo,'test71'],
		owned_target		: section_tipo,
		test_save			: true
	})

// component_relation_related
	elements.push({
		model				: 'component_relation_related',
		tipo				: 'test54', //  'test56',
		section_tipo		: section_tipo,
		section_id			: section_id,
		mode				: mode,
		lang				: page_globals?.dedalo_data_nolan ?? 'lg-nolan',
		new_value			: (_arguments) => {
			const locator = fn.random_locator(_arguments)
			locator.type_rel = 'dd620'
			return locator
		},
		new_value_params	: [section_tipo,'test54']
	})

// component_section_id
	elements.push({
		model			: 'component_section_id',
		tipo			: 'test102',
		section_tipo	: section_tipo,
		section_id		: section_id,
		mode			: mode,
		lang			: page_globals?.dedalo_data_nolan ?? 'lg-nolan',
		new_value		: fn.random_string,
		test_save		: false
	})

// component_security_access
	elements.push({
		model				: 'component_security_access',
		tipo				: 'test157',
		section_tipo		: section_tipo,
		section_id			: section_id,
		mode				: mode,
		lang				: page_globals?.dedalo_data_nolan ?? 'lg-nolan',
		new_value			: fn.random_security_access
	})

// component_select
	elements.push({
		model				: 'component_select',
		tipo				: 'test91',
		section_tipo		: section_tipo,
		section_id			: section_id,
		mode				: mode,
		lang				: page_globals?.dedalo_data_nolan ?? 'lg-nolan',
		new_value			: fn.random_locator,
		new_value_params	: ['dd64','test91']
	})

// component_select_lang
	elements.push({
		model				: 'component_select_lang',
		tipo				: 'test89',
		section_tipo		: section_tipo,
		section_id			: section_id,
		mode				: mode,
		lang				: page_globals?.dedalo_data_nolan ?? 'lg-nolan',
		new_value			: fn.random_locator,
		new_value_params	: ['lg1','test89']
	})

// component_svg
	elements.push({
		model				: 'component_svg',
		tipo				: 'test177',
		section_tipo		: section_tipo,
		section_id			: section_id,
		mode				: mode,
		lang				: page_globals?.dedalo_data_nolan ?? 'lg-nolan',
		new_value			: fn.random_svg_value,
		new_value_action	: 'set_data'
		// test_save		: false
	})

// component_text_area
	elements.push({
		model			: 'component_text_area',
		tipo			: 'test17',
		section_tipo	: section_tipo,
		section_id		: section_id,
		mode			: mode,
		lang			: lang,
		new_value		: fn.random_string_value,
		new_value_params: [lang]
	})



// @license-end
