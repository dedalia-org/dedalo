// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L */
/*eslint no-undef: "error"*/



/**
* RENDER_LEGEND
* DOM de la fila #12 en sus DOS mitades, que son cosas distintas:
*
* - el PANEL de edición (chrome del tool, excluido de la descarga de mapa
*   como imagen): cabecera + formulario construidos una sola vez en attach
*   —los inputs tienen que sobrevivir a un reabrir a medio teclear— y la
*   lista de columnas, que se reconstruye entera en cada mutación
*   ESTRUCTURAL (mismo reparto que `render_xyz_basemaps.js`). Teclear NO la
*   reconstruye: perdería el foco a cada pulsación, así que un `input` de
*   nombre solo repinta el overlay.
* - el OVERLAY, la leyenda dibujada sobre el mapa, que es CONTENIDO y por
*   eso no se registra como toolbar node (ver `legend.js` file header).
*
* Las mutaciones salen por `self.<método>(...)`, nunca llamando a
* `legend.js` directamente.
*
* @module render_legend
*/



import {ui} from '../../../core/common/js/ui.js'



/**
* RENDER_LEGEND_PANEL
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel - the panel shell (toolbar.js create_toolbar_panel)
* @returns {HTMLElement} panel
*/
export const render_legend_panel = function(self, panel) {

	const header = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-panel-header',
		parent			: panel
	})
	ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'uca-maps-panel-title',
		text_content	: self.get_tool_label('legend_control_title') || 'Legend',
		parent			: header
	})

	const form = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-legend-form', parent: panel})

	const message = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-legend-message', parent: form})
	message.hidden = true

	const title_input = ui.create_dom_element({
		element_type	: 'input',
		class_name		: 'uca-maps-legend-input uca-maps-legend-title-input',
		parent			: form
	})
	title_input.type		= 'text'
	title_input.placeholder	= self.get_tool_label('legend_title_placeholder') || 'Legend title'
	title_input.value		= self.legend.legend
	title_input.addEventListener('input', () => {
		self.set_legend_title(title_input.value)
	})

	const show_label = ui.create_dom_element({element_type: 'label', class_name: 'uca-maps-legend-show-label', parent: form})
	const show_checkbox = ui.create_dom_element({element_type: 'input', class_name: 'uca-maps-legend-show', parent: show_label})
	show_checkbox.type		= 'checkbox'
	show_checkbox.checked	= self.legend.enable
	show_checkbox.addEventListener('change', () => {
		self.set_legend_visible(show_checkbox.checked)
	})
	ui.create_dom_element({
		element_type	: 'span',
		text_content	: self.get_tool_label('legend_show') || 'Show legend',
		parent			: show_label
	})

	const add_column_btn = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'uca-maps-legend-add-column',
		text_content	: self.get_tool_label('legend_add_column') || 'Add column',
		parent			: form
	})
	add_column_btn.type = 'button'
	add_column_btn.addEventListener('click', () => {
		self.add_legend_column()
		populate_legend_columns(self, panel)
	})

	ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-legend-columns', parent: panel})

	return panel
}//end render_legend_panel



/**
* SHOW_LEGEND_MESSAGE
* Línea de error en flujo, no `ui.show_message` — su toast de página se
* recortaría contra el `overflow-y: auto` del panel (misma razón que
* `render_xyz_basemaps.js`).
*
* Exportada para que un gate pueda fijar el acoplamiento por CLASE entre esta
* función y el nodo que `render_legend_panel` construye: renombrar uno de los
* dos lados revienta la subida de icono en silencio (review-diff, hito 17).
*
* @param {HTMLElement} panel
* @param {string} text
* @returns {void}
*/
export const show_legend_message = function(panel, text) {
	const message = panel.querySelector('.uca-maps-legend-message')
	message.textContent	= text
	message.hidden		= false
}//end show_legend_message



/**
* CLEAR_LEGEND_MESSAGE
* Una negativa vieja que sigue ahí al reabrir el panel describe algo que ya
* no ha pasado. Se limpia al abrir y antes de cada intento nuevo (mismo
* criterio que `render_file_upload.js` clear_upload_message).
*
* @param {HTMLElement} panel
* @returns {void}
*/
export const clear_legend_message = function(panel) {
	const message = panel && panel.querySelector('.uca-maps-legend-message')
	if (message) {
		message.hidden = true
	}
}//end clear_legend_message



/**
* POPULATE_LEGEND_COLUMNS
* Reconstruye la lista de columnas desde `self.legend.columns` — en cada
* apertura del panel y tras cada mutación estructural.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel
* @returns {void}
*/
export const populate_legend_columns = function(self, panel) {

	const list = panel.querySelector('.uca-maps-legend-columns')
	list.replaceChildren()

	if (!self.legend.columns.length) {
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'uca-maps-legend-empty',
			text_content	: self.get_tool_label('legend_empty') || 'The legend has no columns yet.',
			parent			: list
		})
		return
	}

	self.legend.columns.forEach((column, column_index) => {

		const column_node = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-legend-column', parent: list})

		const column_row = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-legend-column-row', parent: column_node})

		const name_input = ui.create_dom_element({
			element_type	: 'input',
			class_name		: 'uca-maps-legend-input uca-maps-legend-column-name',
			parent			: column_row
		})
		name_input.type			= 'text'
		name_input.placeholder	= self.get_tool_label('legend_column_placeholder') || 'Column name'
		name_input.value			= column.name
		name_input.addEventListener('input', () => {
			self.set_legend_column_name(column_index, name_input.value)
		})

		const add_element_btn = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'uca-maps-legend-add-element',
			text_content	: self.get_tool_label('legend_add_element') || 'Add element',
			parent			: column_row
		})
		add_element_btn.type = 'button'
		add_element_btn.addEventListener('click', () => {
			self.add_legend_element(column_index)
			populate_legend_columns(self, panel)
		})

		const delete_column_btn = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'uca-maps-legend-delete-column',
			text_content	: '✕',
			parent			: column_row
		})
		delete_column_btn.type	= 'button'
		delete_column_btn.title	= self.get_tool_label('legend_delete_column') || 'Delete column'
		delete_column_btn.addEventListener('click', () => {
			self.delete_legend_column(column_index)
			populate_legend_columns(self, panel)
		})

		const elements_list = ui.create_dom_element({element_type: 'ul', class_name: 'uca-maps-legend-elements', parent: column_node})

		column.elements.forEach((element, element_index) => {
			render_element_row(self, panel, elements_list, column_index, element_index, element)
		})

	})

}//end populate_legend_columns



/**
* RENDER_ELEMENT_ROW
* Una fila icono + nombre + "Subir icono" + borrar, dentro de su columna.
*
* @param {Object} self
* @param {HTMLElement} panel
* @param {HTMLElement} elements_list
* @param {number} column_index
* @param {number} element_index
* @param {Object} element - {name, icon}
* @returns {void}
*/
const render_element_row = function(self, panel, elements_list, column_index, element_index, element) {

	const item = ui.create_dom_element({element_type: 'li', class_name: 'uca-maps-legend-element', parent: elements_list})

	// `src` assigned AFTER creation on purpose: ui.create_dom_element routes
	// options.src through safe_url, which refuses `data:` — and every icon here
	// is a data URL this browser just minted (the embedded pin, or a FileReader
	// result). If legends ever persist (a stored value arriving from the wire),
	// THIS line and its twin in the overlay are what must be re-guarded.
	const icon = ui.create_dom_element({element_type: 'img', class_name: 'uca-maps-legend-element-icon', parent: item})
	icon.src	= element.icon
	icon.width	= 18
	icon.height	= 18
	icon.alt	= ''

	const name_input = ui.create_dom_element({
		element_type	: 'input',
		class_name		: 'uca-maps-legend-input uca-maps-legend-element-name',
		parent			: item
	})
	name_input.type			= 'text'
	name_input.placeholder	= self.get_tool_label('legend_element_placeholder') || 'Element name'
	name_input.value			= element.name
	name_input.addEventListener('input', () => {
		self.set_legend_element_name(column_index, element_index, name_input.value)
	})

	const upload_btn = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'uca-maps-legend-upload-icon',
		text_content	: self.get_tool_label('legend_upload_icon') || 'Icon',
		parent			: item
	})
	upload_btn.type	= 'button'
	upload_btn.title	= self.get_tool_label('legend_upload_icon_title') || 'Recommended size 36x36'
	upload_btn.addEventListener('click', () => {
		pick_icon_file(self, panel, column_index, element_index)
	})

	const delete_btn = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'uca-maps-legend-delete-element',
		text_content	: '✕',
		parent			: item
	})
	delete_btn.type	= 'button'
	delete_btn.title	= self.get_tool_label('legend_delete_element') || 'Delete element'
	delete_btn.addEventListener('click', () => {
		self.delete_legend_element(column_index, element_index)
		populate_legend_columns(self, panel)
	})

}//end render_element_row



/**
* PICK_ICON_FILE
* Selector de fichero efímero (mismo gesto que v6 `change_icon`): se crea,
* se abre y muere con el handler — nada que limpiar en detach.
*
* @param {Object} self
* @param {HTMLElement} panel
* @param {number} column_index
* @param {number} element_index
* @returns {void}
*/
const pick_icon_file = function(self, panel, column_index, element_index) {

	const file_input = document.createElement('input')
	file_input.type		= 'file'
	file_input.accept	= 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml'

	file_input.addEventListener('change', async () => {

		const file = file_input.files && file_input.files[0]
		if (!file) {
			return
		}

		clear_legend_message(panel)

		const result = await self.set_legend_element_icon(column_index, element_index, file)

		// the tool may be gone: the OS chooser can stay open across a teardown
		// (legend.js set_legend_element_icon carries the same guard)
		if (!self.legend_panel) {
			return
		}

		if (!result.ok && result.error) {
			show_legend_message(panel, result.error)
			return
		}

		populate_legend_columns(self, panel)

	})

	file_input.click()

}//end pick_icon_file



/**
* CREATE_LEGEND_OVERLAY
* La leyenda sobre el mapa, como L.Control propio en 'bottomleft' (API
* pública; v6 se cuelga de `map._controlCorners.topleft`, que además es
* donde viven los botones de este tool). NO se registra como toolbar node:
* es contenido del mapa y tiene que salir en la descarga de imagen.
*
* @param {Object} self
* @returns {Object} el L.Control
*/
export const create_legend_overlay = function(self) {

	const LegendOverlayControl = L.Control.extend({
		options : { position: 'bottomleft' },
		onAdd : function() {
			const container = L.DomUtil.create('div', 'uca-maps-legend-overlay')
			L.DomEvent.disableClickPropagation(container)
			L.DomEvent.disableScrollPropagation(container)
			return container
		}
	})

	self.legend_overlay = new LegendOverlayControl()
	self.legend_overlay.addTo(self.geolocation.map)

	return self.legend_overlay
}//end create_legend_overlay



/**
* RENDER_LEGEND_OVERLAY
* Repinta el overlay entero desde `self.legend`. Se esconde con el checkbox
* apagado y también cuando no hay NADA que enseñar (ni título ni columnas):
* v6 deja una caja vacía sobre el mapa, que es ruido, no información.
*
* @param {Object} self
* @returns {void}
*/
export const render_legend_overlay = function(self) {

	const container = self.legend_overlay && self.legend_overlay.getContainer()
	if (!container) {
		return
	}

	container.replaceChildren()

	const legend	= self.legend
	// emptiness is measured in what would be DRAWN, not in how many columns
	// exist: a column just created, still unnamed and with no elements, paints
	// a blank white box — which is the noise this branch exists to avoid
	const is_empty	= !legend.legend && !legend.columns.some((column) => column.name || column.elements.length)
	container.hidden = !legend.enable || is_empty
	if (container.hidden) {
		return
	}

	if (legend.legend) {
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'uca-maps-legend-overlay-title',
			text_content	: legend.legend,
			parent			: container
		})
	}

	const columns_node = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-legend-overlay-columns',
		parent			: container
	})

	for (const column of legend.columns) {

		const column_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'uca-maps-legend-overlay-column',
			parent			: columns_node
		})

		if (column.name) {
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'uca-maps-legend-overlay-column-name',
				text_content	: column.name,
				parent			: column_node
			})
		}

		for (const element of column.elements) {

			const element_node = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'uca-maps-legend-overlay-element',
				parent			: column_node
			})

			// same safe_url bypass as the panel row above — locally minted
			// data URL, never a value off the wire (yet)
			const icon = ui.create_dom_element({element_type: 'img', parent: element_node})
			icon.src	= element.icon
			icon.width	= 18
			icon.height	= 18
			icon.alt	= ''

			ui.create_dom_element({
				element_type	: 'span',
				text_content	: element.name,
				parent			: element_node
			})

		}

	}

}//end render_legend_overlay



/**
* REMOVE_LEGEND_OVERLAY
* @param {Object} self
* @returns {void}
*/
export const remove_legend_overlay = function(self) {

	if (!self.legend_overlay) {
		return
	}

	try {
		if (self.geolocation && self.geolocation.map) {
			self.geolocation.map.removeControl(self.legend_overlay)
		}
	} catch (error) {
		console.warn('tool_uca_maps legend: error removing the legend overlay', error)
	}

	self.legend_overlay = null

}//end remove_legend_overlay



// @license-end
