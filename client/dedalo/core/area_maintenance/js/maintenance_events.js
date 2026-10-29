// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/

/**
 * MAINTENANCE_EVENTS
 * The maintenance area's cross-widget event names: a LEAF module with no
 * imports. A widget that talks to the dashboard imports from here, never from
 * the dashboard module (render_area_maintenance.js), so a widget's render
 * module never depends on the dashboard it is mounted in.
 */

/**
 * OPEN_WIDGET_EVENT
 * Document CustomEvent a widget dispatches to ask the dashboard to show
 * ANOTHER widget (`detail: {id}`). Example: media_control's line pointing at
 * publication_hosts. The System Map answers it: it switches to the map view and
 * mounts that widget. An id the engine does not serve is ignored.
 */
export const OPEN_WIDGET_EVENT = 'dd_maintenance_open_widget';

// @license-end
