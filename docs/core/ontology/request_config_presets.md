# Request config presets (section layout maps)

> See also: [Ontology](index.md) · [RQO](../../api/rqo.md) · [dd_object](../../api/dd_object.md) · [request_config](../request_config.md)

!!! note "Applied by the TS engine (since 2026-07-10)"
    Request config presets are **ordinary ontology data** — a `dd1244` record
    with its `dd625` JSON payload — and the schema/authoring workflow below is
    unchanged. The TS engine now reads and applies them: they run as the
    stage-2 override in `src/core/relations/request_config/build.ts`, which
    dynamically imports `resolvePresetRequestConfig` from
    `src/core/relations/request_config/presets.ts`. When an active preset
    matches the `(tipo, section_tipo, mode)` triple for the current user (a
    public preset is the fallback), its `dd625` JSON payload replaces
    `properties.source.request_config` so the existing explicit builder parses
    it with no special-casing. This override is **section-owned only** (like
    the V6 oracle, it gates on the element being a `section`), so a preset
    redefines a section's layout but does not overlay an ordinary component.

Request config presets let administrators and privileged users override the
default ontology definition for a section's layout — that is, redefine which
elements (components, section groups, etc.) are displayed when the browser loads a
section. This page explains how to create a preset and how to write its `ddo_map`.

## Introduction

### Main concepts

The primary mechanism for rendering a section in Dédalo retrieves the ontology
section definition for the current section in the current mode (`edit` or `list`,
primarily) and prepares all components for rendering on the client side, creating
the context with all the necessary information (tipo, name, parent, tools, labels,
etc.). Users can create a custom set of components by overriding this default
context with a request config preset, which is loaded and parsed to generate the
new set.

#### Request config

A request config is a basic definition for creating a [RQO](../../api/rqo.md) (Request
Query Object) used in Dédalo's working API calls. It is defined in the ontology
node properties for standard use, but can be overridden with the local
(per-installation) request config presets.

## Creating a new request config preset

To create a new preset, create a new record in section
[`dd1244`](https://dedalo.dev/ontology/dd1244) — Request config presets (Layout
map).

!!! note "Menu path: Administration > List of values > Settings and tools > Request config presets (Layout map)"

### Inputs

---

- #### Name [dd624](https://dedalo.dev/ontology/dd624) String  
  Descriptive name of the preset.  
  Used only for human-readable identification and description of the preset.  
    
    Sample: 'Numismatic Object list'  

---

- #### Tipo [dd1242](https://dedalo.dev/ontology/dd1242) String
  Tipo (ontology identifier [see more info](index.md#what-the-dédalo-ontology-is)) of the element. Support is currently limited to sections.  
  It is used to locate the preset by tipo.  

    Sample: '[numisdata4](https://dedalo.dev/ontology/numisdata4)'

---

- #### Section tipo [dd642](https://dedalo.dev/ontology/dd642) String  
  Tipo (ontology identifier [see more info](index.md#what-the-dédalo-ontology-is)) of the section.  
  It is used to locate the preset by section_tipo.  
  This may look redundant with `tipo`, but the combination of `tipo` and `section_tipo` will be used to extend presets to components such as portals in the future.  

    Sample: '[numisdata4](https://dedalo.dev/ontology/numisdata4)'

---

- #### Mode [dd1246](https://dedalo.dev/ontology/dd1246) String
  Mode of the section visualization (edit | list).   
  It is used to locate the preset by mode.  
    
    Sample: 'list'

---

- #### User [dd654](https://dedalo.dev/ontology/dd654) Locator
  This is the user ID of the owner of the current preset.  
  This is used to locate the preset by user ID.  
    
    Sample (resolved value): 'Xavier'  
    Sample data: [{"type":"dd151","section_id":5,"section_tipo":"dd128","from_component_tipo":"dd654"}]

---

- #### Public [dd640](https://dedalo.dev/ontology/dd640) Locator
  Public status of the current preset (Yes | No).  
  It is used to filter presets by public status.  
  If value is 'Yes', other users will use this preset as a fallback when no self-presets are available.  
  If value is 'No', only the preset's owner can load it; all other users will load their own preset for the current section or the default ontology configuration instead.

    Sample (resolved value): 'Yes'  
    Sample data: [{"type":"dd151","section_id":1,"section_tipo":"dd64","from_component_tipo":"dd640"}]

---

- #### Active [dd1566](https://dedalo.dev/ontology/dd1566) Locator
  Active status of the current preset (Yes | No).  
  It is used to filter presets by active status.  
  If this is 'Yes', this preset will be available, else will be ignored when presets are loaded.  

    Sample (resolved value): 'Yes'  
    Sample data: [{"type":"dd151","section_id":1,"section_tipo":"dd64","from_component_tipo":"dd1566"}]

---

- #### JSON data [dd625](https://dedalo.dev/ontology/dd625) JSON
  Definition of the current preset. It contains an array with one or more [Request Config](../../api/rqo.md) objects.  
  This JSON value will replace the current Ontology Request Config definition for the tipo + section_tipo + user id matches.  
  Users can define full [Request Config](../../api/rqo.md) items, but for simplicity, only main properties used for the layout will be enumerated here.  

--- 

## Creating a [ddo_map](../../api/rqo.md#parameters)

The **ddo_map** contains the list of all [ddo](../../api/dd_object.md) items to display.  
There are various **ddo_map** wrappers for different uses, but for display we use [show](../../api/rqo.md#parameters), as follows:  
*{show > ddo_map > [ddo 1, ddo 2, …]}*.

All [ddo](../../api/dd_object.md) items to render must sit inside the **show > ddo_map** array property and follow this pattern:



* **info** : String with descriptive info about the **ddo**. Sample: *Type (component_portal)*
* **mode** : String with the preset target **[mode](../../api/dd_object.md#properties)**. Sample: *list*
* **tipo** : String with the preset target **[tipo](../../api/dd_object.md#properties)**. Sample: *numisdata158*
* **view** : String, optional. Overrides the default **[view](../../api/dd_object.md#properties)** of the component. Sample: *line*
* **parent** : String with the **[tipo](../../api/dd_object.md#properties)** of the section (the parent of the current component). The value 'self' resolves to the current section type automatically. Sample: *self*
* **section_tipo**: String with the **[tipo](../../api/dd_object.md#properties)** of the section. The value 'self' resolves to the current section type automatically. Sample: *self*

List-mode specifics:

* **width** : String, optional, list mode only. Overrides the default column **[width](../../api/dd_object.md#properties)** in the list. Sample: *5rem*

#### Sample of JSON data [dd625](https://dedalo.dev/ontology/dd625) value for **LIST** mode:

```json
[
  {
    "show": {
      "ddo_map": [
        {
          "info": "Publishable (component_publication)",
          "mode": "list",
          "tipo": "numisdata158",
          "view": "line",
          "width": "5rem",
          "parent": "self",
          "section_tipo": "self"
        },
        {
          "info": "State (component_radio_button)",
          "tipo": "numisdata160",
          "width": "15.5rem",
          "parent": "self",
          "section_tipo": "self"
        },
        {
          "info": "Type (component_portal)",
          "tipo": "numisdata161",
          "view": "line",
          "width": "auto",
          "parent": "self",
          "section_tipo": "self"
        },
        {
          "info": "Obverse (component_portal)",
          "tipo": "numisdata164",
          "width": "106px",
          "parent": "self",
          "section_tipo": "self"
        },
        {
          "info": "Image (component_image)",
          "tipo": "rsc29",
          "view": "default",
          "parent": "numisdata164",
          "section_tipo": "rsc170"
        }
      ]
    }
  }
]
```

Edit-mode specifics:

* **properties** : Object, optional, edit mode only. Overrides the default properties of the ontology node **[properties](../../api/dd_object.md#properties)**.
This is usually used to change a component's CSS or to give it a custom label.  


    - **css** : To change the CSS of an element, set a selector such as *.wrapper_component* and add the desired style properties, e.g. *"grid-column": "span 3"*, in JSON format.  
    A component's main selectors are defined in the [components DOM structure](../components/index.md#dom-structure) and must be set with a leading `.`, e.g. *.wrapper_component*.   
    
    ```text
    ── .wrapper_component (all component wrapper div)
       ├── .label (name of the component div)
       ├── .buttons_container (buttons div hidden by default. Visible when component is active)
       └── .content_data (div containing all the component data)
           └── .content_value (div with each component value)
    ```
    
    
    - **label** : To change the label of the component, set an object with the Dédalo language code (e.g. 'lg-eng') as the key and the label (e.g. 'My component label') as the value. Add as many languages as you need.  
    Note that if the currently selected application language is not one of the defined values, the first value is used as a fallback.
    
Sample:

```json
    {
        "css": {
          ".wrapper_component": {
            "grid-column": "span 3",
            "background-color": "yellow"
          }
        },
        "label": {
          "lg-eng": "My Type",
          "lg-spa": "Mi tipo"
        }
    }
```

* **parent_grouper** : String, optional, edit mode only. Overrides the ddo's default **[parent_grouper](../../api/dd_object.md#properties)** property
(sets the DOM parent of the current component node, usually a ***section_group*** defined previously).  
Sample: *numisdata129*


#### Sample of JSON data [dd625](https://dedalo.dev/ontology/dd625) value for **EDIT** mode:

```json
[
  {
    "show": {
      "ddo_map": [
        {
          "info": "Section group General",
          "tipo": "numisdata129",
          "parent": "self",
          "properties": {
            "css": {
              ".content_data": {
                "grid-template-columns": "repeat(10, 1fr)"
              }
            }
          },
          "section_tipo": "self"
        },
        {
          "info": "ID (component_section_id)",
          "tipo": "numisdata130",
          "parent": "self",
          "properties": {
            "css": {
              ".wrapper_component": {
                "grid-column": "span 1"
              }
            }
          },
          "section_tipo": "self",
          "parent_grouper": "numisdata129"
        },
        {
          "info": "Type (component_portal)",
          "tipo": "numisdata161",
          "view": "line",
          "parent": "self",
          "properties": {
            "css": {
              ".wrapper_component": {
                "grid-column": "span 3",
                "background-color": "yellow"
              }
            },
            "label": {
              "lg-eng": "My Type",
              "lg-spa": "Mi tipo"
            }
          },
          "section_tipo": "self",
          "parent_grouper": "numisdata129"
        },
        {
          "info": "Obverse (component_portal)",
          "tipo": "numisdata164",
          "view": "mosaic",
          "parent": "self",
          "properties": {
            "css": {
              ".wrapper_component": {
                "grid-row": "2 / span 4",
                "grid-column": "span 3"
              },
              ".wrapper_component.edit >.list_body": {
                "height": "20rem"
              },
              ".wrapper_component .wrapper_service_autocomplete .section_record": {
                "display": "flex",
                "justify-content": "space-between"
              }
            },
            "label": {
              "lg-eng": "My Obverse",
              "lg-spa": "Mi Obverse"
            }
          },
          "section_tipo": "self",
          "parent_grouper": "numisdata129"
        }
      ]
    }
  }
]
```

