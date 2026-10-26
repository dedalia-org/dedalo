# Events

> See also: [Browser client](client/index.md) · [Server-side observers](system/observers.md) · [Glossary](glossary.md)

Dédalo implements an event manager used across all ontology definitions (areas, sections, components, tools, services, etc). The event manager is an observer/observable pattern, but the connection between instances is made with tokens. The event manager centralizes all events fired by observables and runs some functions or methods of the observers.

!!! note "Client vs server"
    Everything below through **Active events** documents the **client-side** `event_manager` — pure browser JavaScript (`core/common/js/event_manager.js`) served as-is by the server. The server additionally has its own **server-side observer** mechanism, driven by the same `properties.observe` configuration but running on save instead of in the tab — see [Server-side observers](#server-side-observers) below.

## Event definition

Every event is created as unique and centralize object, all instances can subscribe to events created by others or create new ones, all events are by definition:

- Auto-explained. Each event is auto-explained, the event_name is the key to subscribe or publish
- Controlled by instances. The instances has control to create new ones and destroy it
- Self-contained. The token is stored in the instances to be referenced in the event manager; the instance stores only the token to call it.
- objects with only 3 properties.

All events are stored in the events array of the event manager.

 Events format:

```json
[{
    "event_name"  : "update_data",  //string. The common name of the events for fired by publish/changes as 'activate_component'
    "token"       : "event_1",      //string. Unique id stored in the instance for control the event as 'event_19'
    "callback"    : "sync_data()"   //method/function. The method or function that will fired when publish/change will fired
}]
```

## Event manager class

The event_manager class is instantiated by the page.

Event manager defines few methods and store all events in a common and shared array named `events`.

### Reference

#### subscribe()

Add received event to the events list array

```js
subscribe(event_name, callback) 
```

##### Parameters

- `event_name` : String with the name of the event to be subscribed, the event will be created into the events property. The name can contain some unique combination of parameters to identify the event as language or the own id of the component.
- `callback` : Method or function to be performed when the event is fired like: 'fn_activate_component'

!!! tip "Naming events"
    Using a combination of parameters added to the event name is possible to create a specific context to perform the event. For ex:
    ```event_manager.subscribe('render_' + self.lang, fn_render_lang)``` only will fire with the publisher send a render event with specific lang ignoring all other render events.

##### Returns

subscribe returns a string with the `token`. The string token is created with incremental number at the end like: 'event_270'

##### Using

```js
import {event_manager} from '../../common/js/event_manager.js'

event_manager.subscribe('activate_component', fn_activate_component)

function fn_activate_component(component) {
    console.log("component activated: ",component.label);
}
```

##### Automatic subscription

Event could be defined into the ontology as a property of the components. When a component has an event defined Dédalo will subscribe it into the event manager automatically.

**Scope of the automatic subscription:** The ontology can define an observer property that specifies the tipo that this component will listen, therefore the event has a scope of the same section_tipo and same section_id for the observer and observable.

To create the name of the event a id is created with this rule:

```js
const event     = self.context.properties.observe[i].client.event
const id_base   = section_tipo +'_'+ section_id +'_'+ component_tipo
const perform   = self.context.properties.observe[i].client.perform
```

All components have their own id_base and can be referenced as `self.id_base`, so the event can be fired by:

```js
event_manager.publish(event +'_'+ self.section_tipo +'_'+ self.section_id +'_'+ self.tipo, perform)
```

or the short format with the id_base of the observable component:

```js
event_manager.publish(event +'_'+ self.id_base, perform)
```

## Server-side observers

One ontology key, `properties.observe`, drives two mechanisms that share nothing
but their configuration:

- **Client-side** — everything documented above. An entry's `client` half makes
  the browser `event_manager` fire the observer component's callback live, in
  the open tab. Pure UI reactivity; nothing is stored.
- **Server-side** — an entry's `server` half makes the server **recompute** the
  observer after the observed component's save commits: an external mirror is
  rebuilt, an info/state widget is recomputed into a Time Machine row, or a
  relay re-enters propagation so a dependency chain continues. This runs on
  every save door (editor, import, API tool, duplicate), not only on an
  interactive edit.

The two halves are independent: an entry may carry either, both or neither, and
both are common: on the ontology this manual is written against, 60 of the 136
`observe` entries are client-only and the other 76 carry a `server` half.

The one thing worth knowing here, because it is the opposite of the client side:
**the server edge is declared by the observer alone.** The observed component
does not have to name its watchers, and the `properties.observers` array that
used to be required for that is now legacy.

Everything else — which records each observer recomputes on, the value law of
`set_dato_external`, the grow-only fail-safe, the bounded cascade, and how to
diagnose an observer that did not fire — is on its own page:
**[Server-side observers](system/observers.md)**.

## Active events

### activate_component

```js
event_manager.publish('activate_component', component)
```

**Emitted by:**

- ui.js

### active_layer_

```js
event_manager.publish('active_layer_'+self.id, layer)
```

**Emitted by:**

- vector_editor.js

### add_row_

```js
event_manager.publish('add_row_'+ self.id)
```

**Emitted by:**

- render_edit_component_portal.js
  
### built_

```js
event_manager.publish('built_' + self.id)
```

**Emitted by:**

- paginator.js

### button_edit_click

```js
event_manager.publish('button_edit_click', this)
```

**Emitted by:**

- component_info.js
- render_edit_component_portal.js

### change_publication_value_

```js
event_manager.publish('change_publication_value_'+self.id_base, changed_value)
```

**Emitted by:**

- render_edit_component_publication.js

### change_search_element

```js
event_manager.publish('change_search_element', self)
```

**Emitted by:**

- component_filter.js
- component_portal.js
- render_edit_component_date.js
- render_search_component_3d.js
- render_search_component_av.js
- render_search_component_check_box.js
- render_search_component_date.js
- render_search_component_email.js
- render_search_component_filter_records.js
- render_search_component_filter.js
- render_search_component_image.js
- render_search_component_input_text.js
- render_search_component_iri.js
- render_search_component_json.js
- render_search_component_number.js
- render_search_component_portal.js
- render_search_component_publication.js
- render_search_component_radio_button.js
- render_search_component_section_id.js
- render_search_component_select.js
- render_search_component_svg.js
- render_search_component_text_area.js

### click_

```js
event_manager.publish('click_' + current_button.model)
```

**Emitted by:**

- render_area_graph.js
- render_area_thesaurus.js
- view_default_list_section.js
- view_graph_list_section.js

### click_no_tag_

```js
event_manager.publish('click_no_tag_'+ self.id_base, {caller: self})
```

**Emitted by:**

- view_default_edit_text_area.js
  
### click_reference_

```js
event_manager.publish('click_reference_'+ self.id_base, {tag: tag_obj, caller: self, text_editor: text_editor})
```

**Emitted by:**

- view_default_edit_text_area.js

### click_tag_draw_

```js
event_manager.publish('click_tag_draw_'+ self.id_base, {tag: tag_obj, caller: self, text_editor: text_editor})
```

**Emitted by:**

- view_default_edit_text_area.js

### click_tag_geo_

```js
event_manager.publish('click_tag_geo_'+ self.id_base, {tag: tag_obj, caller: self, text_editor: text_editor})
```

**Emitted by:**

- view_default_edit_text_area.js

### click_tag_index_

```js
event_manager.publish('click_tag_index_'+ id_base, {tag: tag})
```

**Emitted by:**

- view_default_edit_text_area.js
- view_indexation_edit_portal.js

### click_tag_lang_

```js
event_manager.publish('click_tag_lang_'+ self.id_base, {tag: tag_obj, caller: self, text_editor: text_editor})
```

**Emitted by:**

- view_default_edit_text_area.js

### click_tag_note_

```js
event_manager.publish('click_tag_note_'+ self.id_base, {tag: tag_obj, caller: self, text_editor: text_editor})
```

**Emitted by:**

- view_default_edit_text_area.js

### click_tag_pdf_

```js
event_manager.publish('click_tag_pdf_'+ self.id_base, {tag: tag_obj, caller: self, text_editor: text_editor})
```

**Emitted by:**

- view_default_edit_text_area.js

### click_tag_person_

```js
event_manager.publish('click_tag_person_'+ self.id_base, {tag: tag_obj, caller: self, text_editor: text_editor})
```

**Emitted by:**

- view_default_edit_text_area.js

### click_tag_tc_

```js
event_manager.publish('click_tag_tc_'+ self.id_base, {tag: tag_obj, caller: self, text_editor: text_editor})
```

**Emitted by:**

- view_default_edit_text_area.js

### create_fragment_

```js
event_manager.publish('create_fragment_'+ self.id, {
    caller  : self,
    key     : key,
    text_editor : current_text_editor
})
```

**Emitted by:**

- component_text_area.js

### create_geo_tag_

```js
event_manager.publish('create_geo_tag_'+ self.id_base, {
    caller      : self,
    text_editor : text_editor
})
```

**Emitted by:**

- view_default_edit_text_area.js

### create_note_tag_

```js
event_manager.publish('create_note_tag_'+ self.id_base + '_' + i, {
    caller      : self,
    text_editor : text_editor
})
```

**Emitted by:**

- view_default_edit_text_area.js
  
### create_reference_

```js
event_manager.publish('create_reference_'+ self.id_base + '_' + key, {
    caller      : self,
    text_editor : self
})
```

**Emitted by:**

- service_ckeditor.js

### deactivate_component

```js
event_manager.publish('deactivate_component', component)
```

**Emitted by:**

- ui.js

### dedalo_notification

```js
event_manager.publish('dedalo_notification', page_globals.dedalo_notification)
```

**Emitted by:**

- component_common.js
- render_inspector.js
- render_page.js
- section.js

### delete_section_

```js
event_manager.publish('delete_section_' + self.caller.id, {
    section_tipo    : self.caller.section_tipo,
    section_id      : self.caller.section_id,
    caller          : self.caller // section
})
```

**Emitted by:**

- render_inspector.js
- render_list_section.js

### destroy_

```js
event_manager.publish('destroy_'+self.id)
```

**Emitted by:**

- common.js

### duplicate_section_

```js
event_manager.publish('duplicate_section_' + self.caller.id, {
    section_tipo    : self.caller.section_tipo,
    section_id      : self.caller.section_id,
    caller          : self.caller // section
})
```

**Emitted by:**

- render_inspector.js

### editor_ready_

```js
event_manager.publish('editor_ready_' + self.id, current_service_text_editor)
```

**Emitted by:**

- view_default_edit_text_area.js
- view_line_edit_text_area.js

### editor_tag_

```js
event_manager.publish('editor_tag_'+ change.type + '_change_' + self.id_base, change)
```

**Emitted by:**

- view_default_edit_text_area.js
- view_line_edit_text_area.js

### full_screen_

```js
event_manager.publish('full_screen_'+self.id, false)
```

**Emitted by:**

- render_edit_component_portal.js
- vector_editor.js
- view_default_edit_image.js

### image_quality_change_

```js
event_manager.publish('image_quality_change_'+self.id, img_src)
```

**Emitted by:**

- render_edit_component_image.js
- vector_editor.js

### initiator_link_

```js
top_window.event_manager.publish('initiator_link_' + self.initiator, {
    section_tipo    : section_tipo,
    section_id      : section_id
})
```

**Emitted by:**

- render_list_section.js

### key_up_esc

```js
event_manager.publish('key_up_esc' +'_'+ self.id_base, features.av_player.av_rewind_seconds)
```

**Emitted by:**

- view_default_edit_text_area.js

### key_up_f2

```js
event_manager.publish('key_up_f2' +'_'+ self.id_base, evt.code)
```

**Emitted by:**

- view_default_edit_text_area.js

### key_up_persons

```js
event_manager.publish('key_up_persons' +'_'+ self.id_base, key_person_number)
```

**Emitted by:**

- view_default_edit_text_area.js

### link_term_

```js
window_base.event_manager.publish('link_term_' + linker_id, {
    section_tipo    : children_data.section_tipo,
    section_id      : children_data.section_id,
    label           : current_label_term ? current_label_term.value : ''
})
```

**Emitted by:**

- render_ts_object.js

### login_failed

```js
event_manager.publish('login_failed', api_response)
```

**Emitted by:**

- login.js

### login_successful

```js
event_manager.publish('login_successful', api_response)
```

**Emitted by:**

- login.js

A notification, published **before** the re-login identity decision
(`error_dispatch.settle_relogin_attempt`). It never authorises resuming queued
work: a subscriber that retries a save on it would replay the page user's edit
under whoever just logged in. Nothing in the client subscribes to it.

### modal_close

```js
event_manager.publish('modal_close', event)
```

**Emitted by:**

- ui.js

### mosaic_hover_

```js
event_manager.publish(`mosaic_hover_${section_record.id_base}_${section_record.caller.section_tipo}_${section_record.caller.section_id}`, this)
```

**Emitted by:**

- view_coins_mosaic_portal.js
- view_tool_cataloging_mosaic.js

### mosaic_mouseleave_

```js
event_manager.publish(`mosaic_mouseleave_${section_record.id_base}_${section_record.caller.section_tipo}_${section_record.caller.section_id}`, this)
```

**Emitted by:**

- view_coins_mosaic_portal.js

### mosaic_show_

```js
event_manager.publish(`mosaic_show_${hover_section_record.id_base}_${hover_section_record.caller.section_tipo}_${hover_section_record.caller.section_id}`, this)
```

**Emitted by:**

- view_indexation_edit_portal.js

### new_section_

```js
event_manager.publish('new_section_' + self.id)
```

**Emitted by:**

- render_area_graph.js
- render_area_thesaurus.js
- render_inspector.js
- view_default_list_section.js
- view_graph_list_section.js

### paginator_goto_

```js
event_manager.publish('paginator_goto_'+self.id, offset)
```

**Emitted by:**

- paginator.js

### paginator_show_all_

```js
event_manager.publish('paginator_show_all_' + self.id)
```

**Emitted by:**

- paginator.js

### process_uploaded_file_done_

```js
event_manager.publish('process_uploaded_file_done_' + self.id, api_response)
```

**Emitted by:**

- tool_upload.js

### relation_list_paginator_

```js
event_manager.publish('relation_list_paginator_' + self.section_tipo, self)
```

**Emitted by:**

- relation_list.js (from the `paginator_goto_<id>` event of its `paginator` instance)

### remove_element_

```js
event_manager.publish('remove_element_'+self.id, row_key)
```

**Emitted by:**

- component_info.js
- view_tree_edit_portal.js

### render_

```js
event_manager.publish('render_'+self.id, result_node)
```

**Emitted by:**

- common.js

### render_component_filter_

```js
event_manager.publish('render_component_filter_' + current_instance.section_tipo, current_instance)
```

**Emitted by:**

- view_default_edit_section_record.js

### render_instance

```js
event_manager.publish('render_instance', self)
```

**Emitted by:**

- area.js
- area_development.js
- area_graph.js
- area_maintenance.js
- area_thesaurus.js
- section.js

### render_page

```js
event_manager.publish('render_page')
```

**Emitted by:**

- render_page.js

### reset_paginator_

```js
event_manager.publish('reset_paginator_' + self.id, limit)
```

**Emitted by:**

- paginator.js
  
### save

```js
event_manager.publish('save', {
    instance        : self,
    api_response    : null,
    msg             : msg
})
```

**Emitted by:**

- component_common.js

### save_

```js
event_manager.publish('save_'+ self.id_base,
    {
        instance        : self,
        api_response    : response
    }
)
```

**Emitted by:**

- component_common.js

### set_lang_value_

```js
event_manager.publish('set_lang_value_' + self.id_base , datalist_item.section_id)
```

**Emitted by:**

- view_default_edit_select.js

### show_save_button_

```js
event_manager.publish( 'show_save_button_' + self.id )
```

**Emitted by:**

- view_default_edit_security_access.js

### sync_data_

```js
event_manager.publish('sync_data_'+id_base_lang, {
    caller          : self,
    changed_data    : null
})
```

**Emitted by:**

- common.js
- component_common.js

### tab_active_

```js
event_manager.publish('tab_active_'+tipo, child_node)
```

**Emitted by:**

- render_section_tab.js

### text_selection_

```js
event_manager.publish('text_selection_'+ self.id, {selection: selection, caller: self})
```

**Emitted by:**

- view_default_edit_text_area.js

### tm_edit_record

```js
event_manager.publish('tm_edit_record', data)
```

**Emitted by:**

- view_tool_time_machine_list.js

### toggle_search_panel_

```js
event_manager.publish('toggle_search_panel_'+self.id)
```

**Emitted by:**

- page.js
- render_area_graph.js
- render_area_thesaurus.js
- render_inspector.js
- view_base_list_section.js
- view_default_list_section.js
- view_graph_list_section.js
- view_graph_solved_section.js
- view_tool_cataloging_mosaic.js

### ts_add_child_

```js
event_manager.publish('ts_add_child_' + data_obj.caller, {
    locator         : data_obj.locator,
    new_ts_section  : {
        section_id      : new_section_id,
        section_tipo    : section_tipo
    },
    callback : fn_callback
})
```

**Emitted by:**

- ts_object.js

### update_area_radio_

```js
event_manager.publish('update_area_radio_' + self.id + '_' + current_parent.tipo + '_' + current_parent.section_tipo, value_to_propagate)
```

**Emitted by:**

- component_security_access.js
- view_default_edit_security_access.js

### update_item_value_

```js
event_manager.publish('update_item_value_' + self.id + '_' + item.tipo + '_' + item.section_tipo, input_value)
```

**Emitted by:**

- component_security_access.js

### update_sections_list_

```js
event_manager.publish('update_sections_list_' + self.id)
```

**Emitted by:**

- render_search.js

### update_value_

```js
event_manager.publish('update_value_'+id_base, {
    caller          : self
})
```

**Emitted by:**

- common.js

### update_widget_value_

```js
event_manager.publish(`update_widget_value_${i}_${widget_id}`, widget_value)
```

**Emitted by:**

- component_info.js

### updated_layer_data_

```js
event_manager.publish('updated_layer_data_'+ self.id_base,
    {
        layer: {
            type        : 'geo',
            layer_id    : layer_id
        },
        caller: self
    }
)
```

**Emitted by:**

- component_geolocation.js

### updated_subtitles_file_

```js
event_manager.publish('updated_subtitles_file_' + self.media_component.id, {
    lang : self.transcription_component.data.lang
})
```

**Emitted by:**

- render_tool_transcription.js

### upload_file_done_

```js
event_manager.publish('upload_file_done_' + self.caller.id, {file_data : api_response.file_data})
```

**Emitted by:**

- service_upload.js

### upload_file_status_

```js
event_manager.publish('upload_file_status_'+id, {
    value   : 0,
    msg     : 'Loading file ' + file.name
})
```

**Emitted by:**

- service_upload.js

### user_navigation

```js
event_manager.publish('user_navigation', user_navigation_rqo)
```

**Emitted by:**

- page.js
- render_list_section.js
- render_menu_mobile.js
- render_menu_tree.js
- section.js
- view_mini_section_record.js

### viewer_ready_

```js
event_manager.publish('viewer_ready_'+self.id, viewer_3d)
```

**Emitted by:**

- view_default_edit_3d.js

### window_bur_

```js
event_manager.publish('window_bur_'+self.id, self)
```

**Emitted by:**

- component_info.js
- render_edit_component_portal.js
