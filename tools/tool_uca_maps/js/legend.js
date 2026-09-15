// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



/**
* LEGEND
* Fila #12 del audit ("Legend — Leyenda manual"): un editor MANUAL de
* leyenda (título + N columnas, cada una con elementos icono+texto) y la
* propia leyenda dibujada sobre el mapa. No genera nada automáticamente a
* partir de las capas WMS activas — igual que v6, que tampoco pide
* `GetLegendGraphic`.
*
* Estado SOLO DE SESIÓN, como XYZ (#5) y WMS (#6): v6 guarda un JSON por
* `section_tipo` dentro de la carpeta del tool
* (`class.tool_leaflet_special_tools.php:1063` `legends()`) y aquí no hay
* dónde escribirlo — un tool todavía no puede aprovisionar una sección de
* ontología propia. Consecuencia: NO hay botón "Guardar leyenda" ni los tres
* auto-guardados con `setTimeout` de 3 s que v6 dispara al escribir; el
* overlay se repinta en vivo.
*
* El overlay NO se registra como toolbar node a propósito: una leyenda es
* contenido del mapa, así que ENTRA en la descarga de mapa como imagen
* (`map_image_download.js` excluye solo lo registrado). El botón y el panel
* de edición sí son chrome y siguen fuera.
*
* @module legend
*/



import {strip_tags} from '../../../core/common/js/utils/util.js'
import {
	create_toolbar_button,
	create_toolbar_panel,
	set_toolbar_panel_visible,
	is_toolbar_panel_visible,
	remove_toolbar_button,
	remove_toolbar_panel
} from './toolbar.js'
import {
	render_legend_panel,
	populate_legend_columns,
	clear_legend_message,
	create_legend_overlay,
	render_legend_overlay,
	remove_legend_overlay
} from './render_legend.js'



/** Tipos que v6 acepta como icono (`special_tools_legend.js` change_icon +
* el `finfo` del PHP). El SVG se mantiene: el icono vive como data URL
* dentro de un `<img>`, que es un contexto sin scripting, y en esta rama no
* se guarda ni se sirve desde la instalación. */
export const ALLOWED_ICON_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']

/** Tope de v6, verbatim. */
export const MAX_ICON_BYTES = 2000000

/** Pin por defecto de un elemento nuevo. v6 sirve `img/pin.svg` desde la
* carpeta del tool; aquí va incrustado para no depender de una URL de
* asset (`img-src` ya admite `data:`, `static_asset.ts` APP_CSP). */
export const DEFAULT_ELEMENT_ICON = 'data:image/svg+xml;base64,' + btoa(
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">' +
	'<path fill="#1a73e8" d="M12 2c-3.9 0-7 3.1-7 7 0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7zm0 9.5' +
	'a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg>'
)



/**
* EMPTY_LEGEND
* La misma forma que v6 escribe en el JSON la primera vez
* (`legends()`: `{"legend":"", "enable":true, "columns":[]}`), para que el
* día que la pregunta #7 se cierre, persistir sea escribir este objeto tal
* cual.
*
* @returns {Object}
*/
export const empty_legend = function() {
	return {legend: '', enable: true, columns: []}
}//end empty_legend



/**
* ATTACH_LEGEND
* Botón+panel "Legend" (patrón toolbar.js) + el overlay de la leyenda en la
* esquina 'bottomleft' del mapa — la única libre: 'topleft' la ocupan los
* botones de este tool, 'topright' la barra de dibujo de Geoman y
* 'bottomright' la barra de escala (hito 15). Idempotente.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const attach_legend = function(self) {

	if (self.legend_control || !self.geolocation || !self.geolocation.map) {
		return
	}

	self.legend = empty_legend()

	self.legend_control = create_toolbar_button(self, {
		title		: self.get_tool_label('legend_control_title') || 'Legend',
		text		: self.get_tool_label('legend_control_text') || 'Legend',
		class_name	: 'uca-maps-legend-control',
		on_click	: () => toggle_legend_panel(self)
	})

	self.legend_panel = create_toolbar_panel(self, {class_name: 'uca-maps-legend-panel'})
	render_legend_panel(self, self.legend_panel)

	create_legend_overlay(self)
	render_legend_overlay(self)

}//end attach_legend



/**
* TOGGLE_LEGEND_PANEL
* Dirección leída del DOM, nunca de una bandera cacheada (toolbar.js file
* header) — un panel hermano puede haber cerrado este sin pasar por aquí.
*
* @param {Object} self
* @returns {void}
*/
const toggle_legend_panel = function(self) {

	const next_visible = !is_toolbar_panel_visible(self.legend_panel)

	if (next_visible) {
		clear_legend_message(self.legend_panel)
		populate_legend_columns(self, self.legend_panel)
	}

	set_toolbar_panel_visible(self, self.legend_panel, self.legend_control, next_visible)

}//end toggle_legend_panel



/**
* SET_LEGEND_TITLE
* @param {Object} self
* @param {string} text
* @returns {void}
*/
export const set_legend_title = function(self, text) {

	self.legend.legend = strip_tags(String(text || ''))
	render_legend_overlay(self)

}//end set_legend_title



/**
* SET_LEGEND_VISIBLE
* El checkbox "Mostrar leyenda" de v6. Solo esconde el overlay: las
* columnas siguen editables con la leyenda oculta, igual que en v6.
*
* @param {Object} self
* @param {boolean} visible
* @returns {void}
*/
export const set_legend_visible = function(self, visible) {

	self.legend.enable = Boolean(visible)
	render_legend_overlay(self)

}//end set_legend_visible



/**
* ADD_LEGEND_COLUMN
* @param {Object} self
* @returns {{ok: boolean, index: number}}
*/
export const add_legend_column = function(self) {

	self.legend.columns.push({name: '', elements: []})
	render_legend_overlay(self)

	return {ok: true, index: self.legend.columns.length - 1}
}//end add_legend_column



/**
* DELETE_LEGEND_COLUMN
* @param {Object} self
* @param {number} index
* @returns {{ok: boolean}}
*/
export const delete_legend_column = function(self, index) {

	if (index<0 || index>=self.legend.columns.length) {
		return {ok: false}
	}

	self.legend.columns.splice(index, 1)
	render_legend_overlay(self)

	return {ok: true}
}//end delete_legend_column



/**
* SET_LEGEND_COLUMN_NAME
* @param {Object} self
* @param {number} index
* @param {string} text
* @returns {{ok: boolean}}
*/
export const set_legend_column_name = function(self, index, text) {

	const column = self.legend.columns[index]
	if (!column) {
		return {ok: false}
	}

	column.name = strip_tags(String(text || ''))
	render_legend_overlay(self)

	return {ok: true}
}//end set_legend_column_name



/**
* ADD_LEGEND_ELEMENT
* @param {Object} self
* @param {number} column_index
* @returns {{ok: boolean, index?: number}}
*/
export const add_legend_element = function(self, column_index) {

	const column = self.legend.columns[column_index]
	if (!column) {
		return {ok: false}
	}

	column.elements.push({name: '', icon: DEFAULT_ELEMENT_ICON})
	render_legend_overlay(self)

	return {ok: true, index: column.elements.length - 1}
}//end add_legend_element



/**
* DELETE_LEGEND_ELEMENT
* @param {Object} self
* @param {number} column_index
* @param {number} element_index
* @returns {{ok: boolean}}
*/
export const delete_legend_element = function(self, column_index, element_index) {

	const column = self.legend.columns[column_index]
	if (!column || element_index<0 || element_index>=column.elements.length) {
		return {ok: false}
	}

	column.elements.splice(element_index, 1)
	render_legend_overlay(self)

	return {ok: true}
}//end delete_legend_element



/**
* SET_LEGEND_ELEMENT_NAME
* @param {Object} self
* @param {number} column_index
* @param {number} element_index
* @param {string} text
* @returns {{ok: boolean}}
*/
export const set_legend_element_name = function(self, column_index, element_index, text) {

	const column	= self.legend.columns[column_index]
	const element	= column && column.elements[element_index]
	if (!element) {
		return {ok: false}
	}

	element.name = strip_tags(String(text || ''))
	render_legend_overlay(self)

	return {ok: true}
}//end set_legend_element_name



/**
* SET_LEGEND_ELEMENT_ICON
* El icono se queda ENTERO en el navegador (data URL): v6 manda el data URL
* al servidor para que le devuelva el mismo data URL
* (`legend_icon()` del PHP: olfatea el mime, comprueba el tamaño y hace eco)
* — sin persistencia no hay nada que el servidor pueda aportar ahí, así que
* este hito no añade ninguna acción de servidor. Tipo y tamaño se comprueban
* ANTES de leer el fichero, para no cargar 30 MB en memoria y rechazarlos
* después.
*
* @param {Object} self
* @param {number} column_index
* @param {number} element_index
* @param {File} file
* @returns {Promise<{ok: boolean, error?: string}>}
*/
export const set_legend_element_icon = async function(self, column_index, element_index, file) {

	// the only mutator with an await in it: the OS file chooser can outlive
	// the tool (teardown nulls self.legend), and the picker's handler is on a
	// detached input detach cannot reach — same guard shape as
	// render_file_upload.js's post-await panel check
	const column	= self.legend && self.legend.columns[column_index]
	const element	= column && column.elements[element_index]
	if (!element || !file) {
		return {ok: false}
	}

	if (!ALLOWED_ICON_TYPES.includes(file.type)) {
		return {
			ok		: false,
			error	: self.get_tool_label('legend_error_icon_type') || 'Icon file type not allowed (PNG, JPEG, GIF, WebP or SVG only).'
		}
	}
	if (file.size > MAX_ICON_BYTES) {
		return {
			ok		: false,
			error	: self.get_tool_label('legend_error_icon_size') || 'The icon must not exceed 2 MB.'
		}
	}

	const data_url = await read_file_as_data_url(file)
	if (!self.legend) {
		return {ok: false}
	}
	if (!data_url) {
		return {
			ok		: false,
			error	: self.get_tool_label('legend_error_icon_read') || 'The icon could not be read.'
		}
	}

	element.icon = data_url
	render_legend_overlay(self)

	return {ok: true}
}//end set_legend_element_icon



/**
* READ_FILE_AS_DATA_URL
* @param {File} file
* @returns {Promise<string|null>} null si el fichero no se pudo leer
*/
const read_file_as_data_url = function(file) {

	return new Promise((resolve) => {
		const reader = new FileReader()
		reader.onload	= () => resolve(String(reader.result || '') || null)
		reader.onerror	= () => resolve(null)
		reader.readAsDataURL(file)
	})

}//end read_file_as_data_url



/**
* DETACH_LEGEND
* Destrucción real (CLAUDE.local.md) — botón, panel y overlay fuera del
* mapa, estado a null.
*
* @param {Object} self
* @returns {void}
*/
export const detach_legend = function(self) {

	remove_toolbar_button(self, self.legend_control)
	remove_toolbar_panel(self, self.legend_panel)
	remove_legend_overlay(self)

	self.legend			= null
	self.legend_control	= null
	self.legend_panel	= null

}//end detach_legend



// @license-end
