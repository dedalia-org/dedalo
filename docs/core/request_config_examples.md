# Request config examples

A cookbook of real Dédalo v7 ontology `request_config` JSON, organized by scenario. Each entry keeps the scenario, the JSON, and an explanation of every non-obvious key.

This document does **not** re-explain the architecture or the wire format — see the two companion docs:

- **[request_config.md](request_config.md)** — the server-side config system that produces these configs: explicit vs implicit configuration, self-resolution, the `section_tipo` source vocabulary, `request_config_object`/`dd_object` interfaces, pagination, caching, the construction flow and the error contract.
- **[rqo.md](rqo.md)** — the wire message the client builds *from* these configs: the RQO envelope, `dd_api`/`action` whitelists, `source`/`sqo`/`show`/`search`/`choose`/`hide`, response shapes per action, and the **canonical `show.interface` reference table** ([rqo.md → show.interface](rqo.md#show-interface)).

> Note on tipos: the examples use working-set conventions (`numisdata*`, `hierarchy*`, `rsc*`, `oh*`, `zenon1`, `dd15`). These are real tipos from the project ontology and test fixtures, not invented. The base `ontology.copy.gz` ships only core models (`rsc*`); project tipos come with the installed ontology.

## Table of contents

**Display configs**

1. [Section list configuration](#1-section-list-configuration)
2. [Section edit configuration](#2-section-edit-configuration)
3. [Portal component](#3-portal-component)
4. [Autocomplete with search/choose](#4-autocomplete-with-searchchoose)
5. [Autocomplete thesaurus](#5-autocomplete-thesaurus)
6. [External API integration](#6-external-api-integration)
7. [Hierarchical portal](#7-hierarchical-portal)
8. [Multi-section portal](#8-multi-section-portal)
9. [With pre-filters](#9-with-pre-filters)
10. [With fixed filter](#10-with-fixed-filter)
11. [With interface controls](#11-with-interface-controls)
12. [Dynamic DDO map](#12-dynamic-ddo-map)

**End-to-end RQO flows** (the calls a client builds from the configs above)

13. [Create → edit round-trip](#13-create-edit-round-trip)
14. [Duplicate, delete and count](#14-duplicate-delete-count)
15. [Time-machine read](#15-time-machine-read)
16. [Paginated next page and multi-filter search](#16-paginated-next-page-multi-filter-search)
17. [Lazy context and graph term labels](#17-lazy-context-graph-term-labels)
18. [Portal full grid in one read (show-all, columns as siblings)](#18-portal-full-grid-in-one-read)

---

## 1. Section list configuration

**Scenario**: Configure a section to display a list of numismatic objects with key columns.

```json
{
  "source": {
    "request_config": [
      {
        "api_engine": "dedalo",
        "type": "main",
        "sqo": {
          "section_tipo": [
            {
              "value": ["numisdata3"],
              "source": "section"
            }
          ]
        },
        "show": {
          "ddo_map": [
            {
              "tipo": "numisdata413",
              "section_tipo": "self",
              "parent": "self",
              "mode": "list",
              "view": "line"
            },
            {
              "tipo": "numisdata27",
              "section_tipo": "self",
              "parent": "self"
            },
            {
              "tipo": "numisdata30",
              "section_tipo": "self",
              "parent": "self"
            },
            {
              "tipo": "numisdata35",
              "section_tipo": "self",
              "parent": "self"
            }
          ],
          "sqo_config": {
            "limit": 10,
            "offset": 0,
            "full_count": true,
            "operator": "$or"
          }
        }
      }
    ]
  }
}
```

**Explanation**:
- `api_engine: "dedalo"` — internal Dédalo backend (the default; external engines such as `zenon` are covered in [#6](#6-external-api-integration)).
- `type: "main"` — the primary config object. The implicit builder emits exactly this same `type:'main'` shape for un-migrated nodes, so callers never branch on the source.
- `sqo.section_tipo` — the target section, given as `{value, source}`. `source: "section"` means the literal tipos in `value` (TLD-active-checked). See the full source vocabulary in [request_config.md → sqo.section_tipo source vocabulary](request_config.md#sqosection_tipo-source-vocabulary).
- `ddo_map` — the columns to display (publication, number, mint, date). Each entry is a DDO.
- `section_tipo: "self"` / `parent: "self"` — placeholders resolved server-side: `self` section_tipo → the current section's tipo, `self` parent → the element's own tipo.
- `view: "line"` on the first ddo controls its row rendering variant.
- `sqo_config` — display-side SQO tuning. `full_count: true` makes the server return the total (for the pager); `operator: "$or"` is the default for section lists.

*See properties:* [`sqo`](rqo.md#sqo-object-optional), [`show.ddo_map` / `sqo_config`](rqo.md#show-object-optional), [pagination defaults](request_config.md#default-limits).

---

## 2. Section edit configuration

**Scenario**: Configure section edit mode with grouped components.

```json
{
  "source": {
    "request_config": [
      {
        "api_engine": "dedalo",
        "sqo": {
          "section_tipo": [
            {
              "value": ["numisdata3"],
              "source": "section"
            }
          ],
          "limit": 1
        },
        "show": {
          "ddo_map": [
            {
              "tipo": "numisdata100",
              "section_tipo": "self",
              "parent": "self",
              "mode": "edit",
              "properties": {
                "css": {
                  ".content_data": {
                    "grid-template-columns": "repeat(3, 1fr)"
                  }
                }
              }
            },
            {
              "tipo": "numisdata130",
              "section_tipo": "self",
              "parent": "self",
              "parent_grouper": "numisdata100"
            },
            {
              "tipo": "numisdata27",
              "section_tipo": "self",
              "parent": "self",
              "parent_grouper": "numisdata100"
            },
            {
              "tipo": "numisdata28",
              "section_tipo": "self",
              "parent": "self",
              "parent_grouper": "numisdata100"
            }
          ]
        }
      }
    ]
  }
}
```

**Explanation**:
- `sqo.limit: 1` — edit mode shows a single record (this is also the section+edit default; setting it explicitly documents intent).
- `numisdata100` is a `section_group` (`mode: "edit"`); the three following components declare `parent_grouper: "numisdata100"`, so they render *inside* that group instead of at the top level. `parent` stays `self` (ontology parent); `parent_grouper` is purely a layout grouping directive.
- `properties.css` — per-ddo inline style scoped to that element's container. Here a 3-column grid for the group's `.content_data`. Keep this minimal; heavy styling belongs in LESS, not the config.

*See properties:* [`parent_grouper`, `properties.css` and the `dd_object` field set](request_config.md#dd_object-ddo-shape).

---

## 3. Portal component

**Scenario**: Portal (a `component_portal` in list/show mode) displaying coins inside a type record, with a nested image column.

```json
{
  "source": {
    "mode": "list",
    "request_config": [
      {
        "api_engine": "dedalo",
        "sqo": {
          "section_tipo": [
            {
              "value": ["numisdata4"],
              "source": "section"
            }
          ]
        },
        "show": {
          "ddo_map": [
            {
              "tipo": "numisdata164",
              "section_tipo": "self",
              "parent": "self",
              "view": "mosaic"
            },
            {
              "tipo": "rsc29",
              "section_tipo": "rsc170",
              "parent": "numisdata164",
              "view": "thumbnail"
            }
          ],
          "sqo_config": {
            "limit": 50
          }
        }
      }
    ]
  }
}
```

**Explanation**:
- The portal targets section `numisdata4` (coins). `numisdata164` is the displayed component, with `view: "mosaic"` for a card layout.
- The second ddo (`rsc29`, an image component living in section `rsc170`) is **nested**: its `parent` is `numisdata164`, not `self`. This resolves the image *through* the coin record into the portal card. `view: "thumbnail"` keeps it small.
- `sqo_config.limit: 50` — portals raise the per-page limit above the section list default.

*See properties:* [nested ddo chains via `parent`](rqo.md#show-object-optional), [`view` source field](rqo.md#source-object-mandatory).

---

## 4. Autocomplete with search/choose

**Scenario**: Autocomplete component with different fields for searching vs. selecting. This is the `service_autocomplete` flow (`source->action: 'search'`).

```json
{
  "source": {
    "mode": "autocomplete",
    "request_config": [
      {
        "api_engine": "dedalo",
        "sqo": {
          "section_tipo": [
            {
              "value": ["numisdata4"],
              "source": "section"
            }
          ]
        },
        "show": {
          "ddo_map": [
            {
              "tipo": "numisdata27",
              "section_tipo": "self",
              "parent": "self"
            }
          ],
          "fields_separator": ", "
        },
        "search": {
          "ddo_map": [
            {
              "tipo": "numisdata27",
              "section_tipo": "self",
              "parent": "self"
            },
            {
              "tipo": "numisdata81",
              "section_tipo": "self",
              "parent": "self"
            }
          ],
          "sqo_config": {
            "limit": 30
          }
        },
        "choose": {
          "ddo_map": [
            {
              "tipo": "numisdata27",
              "section_tipo": "self",
              "parent": "self"
            },
            {
              "tipo": "numisdata30",
              "section_tipo": "self",
              "parent": "self"
            }
          ],
          "fields_separator": " | "
        }
      }
    ]
  }
}
```

**Explanation**:
- `show` — what is displayed once a record is linked. `fields_separator: ", "` joins multiple component values into one string.
- `search` — the fields actually queried when the user types (number + key). When `search` is present it replaces `show` for the *search* pass; `sqo_config.limit: 30` caps suggestions.
- `choose` — the fields shown in the dropdown picker (number + mint). When present it overrides `search`/`show` for the result list only.
- Fallback chain: `choose → search → show` for the picker; `choose.sqo_config.limit → search/show sqo_config → 25` for its limit. See [rqo.md → choose](rqo.md#choose-object-optional).

*See properties:* [`search`](rqo.md#search-object-optional), [`choose`](rqo.md#choose-object-optional), [`fields_separator`](rqo.md#show-object-optional).

---

## 5. Autocomplete thesaurus

**Scenario**: Autocomplete for thesaurus terms with parent display.

```json
{
  "source": {
    "mode": "autocomplete",
    "request_config": [
      {
        "api_engine": "dedalo",
        "sqo": {
          "section_tipo": [
            {
              "value": [2],
              "source": "hierarchy_types"
            }
          ]
        },
        "show": {
          "ddo_map": [
            {
              "tipo": "hierarchy25",
              "section_tipo": "self",
              "parent": "self",
              "value_with_parents": 1
            }
          ],
          "fields_separator": ", "
        },
        "search": {
          "ddo_map": [
            {
              "tipo": "hierarchy25",
              "section_tipo": "self",
              "parent": "self",
              "value_with_parents": 1
            }
          ],
          "sqo_config": {
            "limit": 30
          }
        },
        "choose": {
          "ddo_map": [
            {
              "tipo": "hierarchy25",
              "section_tipo": "self",
              "parent": "self",
              "value_with_parents": 1
            },
            {
              "tipo": "hierarchy27",
              "section_tipo": "self",
              "parent": "self"
            }
          ],
          "sqo_config": {
            "limit": 30
          },
          "fields_separator": " | "
        }
      }
    ]
  }
}
```

**Explanation**:
- `source: "hierarchy_types"` — a dynamic `section_tipo` source: the `value` array holds thesaurus *type* ids, and the server resolves them to the live set of section_tipos via `get_hierarchy_sections_from_types()`. See [request_config.md → sqo.section_tipo source vocabulary](request_config.md#sqosection_tipo-source-vocabulary).
- `value_with_parents: 1` — render the full term path (e.g. `Roman > Aureus`) instead of just the leaf label.
- `choose` adds a second field (`hierarchy27`) for a richer picker row.

*See properties:* [`section_tipo` source vocabulary](request_config.md#sqosection_tipo-source-vocabulary), [`value_with_parents` on `dd_object`](request_config.md#dd_object-ddo-shape).

---

## 6. External API integration

**Scenario**: Zenon API integration for bibliographic search (`api_engine: "zenon"`).

```json
{
  "source": {
    "mode": "autocomplete",
    "request_config": [
      {
        "api_engine": "zenon",
        "sqo": {
          "section_tipo": [
            {
              "value": ["zenon1"],
              "source": "section"
            }
          ]
        },
        "show": {
          "ddo_map": [
            {
              "tipo": "zenon5",
              "section_tipo": "self",
              "parent": "self",
              "fields_map": true
            }
          ],
          "fields_separator": ". "
        },
        "search": {
          "ddo_map": [
            {
              "tipo": "zenon5",
              "section_tipo": "self",
              "parent": "self",
              "fields_map": true
            }
          ],
          "sqo_config": {
            "limit": 20
          }
        },
        "choose": {
          "ddo_map": [
            {
              "tipo": "zenon5",
              "section_tipo": "self",
              "parent": "self",
              "fields_map": true
            }
          ],
          "sqo_config": {
            "limit": 30
          }
        }
      }
    ]
  }
}
```

**Zenon section `api_config`** (lives in the TARGET section's properties — `zenon1` here — *not* in the request_config; it is the `api_engine`-specific connection block, and the parsed item carries `api_config: null` for every ordinary `dedalo` engine):

```json
{
  "api_config": {
    "entity": "zenon",
    "api_url": "https://zenon.dainst.org/api/v1/record",
    "api_url_search": "https://zenon.dainst.org/api/v1/search",
    "ui_base_url": "https://zenon.dainst.org/Record/",
    "response_map": [
      { "local": "ar_records", "remote": "records" },
      { "local": "msg", "remote": "status" }
    ]
  }
}
```

**Explanation**:
- `api_engine: "zenon"` — routes data retrieval through the external Zenon adapter instead of the matrix tables.
- `fields_map: true` — a lazy flag: the engine REPLACES it with the named component's own `properties.fields_map` and stamps the ddo's `model`, `lang` and `permissions`. The hydrated array is what the client sends as `&field[]=`, so it stays on the wire.
- `api_config` is resolved from the section the show ddo names. Those five keys are the only ones published: anything else is dropped, credential-shaped keys (`api_key`, `token`, …) are stripped, and every URL must be `http(s)` — a `javascript:` `ui_base_url` refuses the whole block, because the portal concatenates it with a record id to open a window. A service credential belongs in `../private/.env` on a secret catalog key, never in the ontology.
- `api_url` / `api_url_search` hosts must also be listed in `DEDALO_EXTERNAL_ALLOWED_HOSTS` before the SERVER will fetch them.

*See properties:* [`api_engine`](rqo.md#api_engine-string-optional-default-dedalo), [`api_config`](request_config.md#request_config_object-shape).

---

## 7. Hierarchical portal

**Scenario**: Portal with nested components (type → obverse/reverse coin portals → image).

```json
{
  "source": {
    "mode": "list",
    "request_config": [
      {
        "api_engine": "dedalo",
        "sqo": {
          "section_tipo": [
            {
              "value": ["numisdata3"],
              "source": "section"
            }
          ]
        },
        "show": {
          "ddo_map": [
            {
              "tipo": "numisdata27",
              "section_tipo": "self",
              "parent": "self"
            },
            {
              "tipo": "numisdata77",
              "section_tipo": "self",
              "parent": "self"
            },
            {
              "tipo": "numisdata164",
              "section_tipo": "numisdata4",
              "parent": "numisdata77"
            },
            {
              "tipo": "rsc29",
              "section_tipo": "rsc170",
              "parent": "numisdata164",
              "view": "default"
            },
            {
              "tipo": "numisdata165",
              "section_tipo": "numisdata4",
              "parent": "numisdata77"
            },
            {
              "tipo": "rsc29",
              "section_tipo": "rsc170",
              "parent": "numisdata165",
              "view": "default"
            }
          ]
        }
      }
    ]
  }
}
```

**Explanation**:
- The `parent` chains build a resolution tree: `numisdata164`/`numisdata165` resolve *through* the `numisdata77` portal; each `rsc29` image resolves through its respective coin component.
- Multiple sections (`numisdata3`, `numisdata4`, `rsc170`) appear in a single config — each ddo declares its own `section_tipo`.
- The same component type (`rsc29`) is listed twice with different `parent` values — that is how one component renders under two distinct branches.

*See properties:* [ddo chains and `parent`](rqo.md#show-object-optional).

---

## 8. Multi-section portal

**Scenario**: Portal that searches across multiple section types (toponymy hierarchies for Spain, France, Italy).

```json
{
  "source": {
    "mode": "autocomplete",
    "request_config": [
      {
        "api_engine": "dedalo",
        "sqo": {
          "section_tipo": [
            {
              "value": ["es1", "fr1", "it1"],
              "source": "section"
            }
          ]
        },
        "show": {
          "ddo_map": [
            {
              "tipo": "hierarchy25",
              "section_tipo": "self",
              "parent": "self"
            }
          ],
          "fields_separator": ", "
        },
        "search": {
          "ddo_map": [
            {
              "tipo": "hierarchy25",
              "section_tipo": "self",
              "parent": "self"
            }
          ],
          "sqo_config": {
            "limit": 30
          }
        },
        "choose": {
          "ddo_map": [
            {
              "tipo": "hierarchy25",
              "section_tipo": "self",
              "parent": "self"
            }
          ],
          "fields_separator": " | "
        }
      }
    ]
  }
}
```

**Explanation**:
- The `value` array carries several literal section tipos (`source: "section"`); the search spans all three at once.
- `section_tipo: "self"` in the ddos then resolves to the *set* of section_tipos in context, so one ddo entry covers every targeted section.

*See properties:* [`self` resolves to an array of section_tipos](request_config.md#self-resolution-and-dynamic-section_tipo-sources).

---

## 9. With pre-filters

**Scenario**: Portal pre-filtered by a list (dropdown) selection.

```json
{
  "source": {
    "request_config": [
      {
        "api_engine": "dedalo",
        "sqo": {
          "section_tipo": [
            {
              "value": ["numisdata4"],
              "source": "section"
            }
          ],
          "filter_by_list": [
            {
              "section_tipo": "numisdata4",
              "component_tipo": "numisdata140"
            }
          ]
        },
        "show": {
          "ddo_map": [
            {
              "tipo": "numisdata27",
              "section_tipo": "self",
              "parent": "self"
            }
          ]
        }
      }
    ]
  }
}
```

**Explanation**:
- `filter_by_list` names a `{section_tipo, component_tipo}` descriptor; the server expands each one into a `{context, datalist}` pair — `component_tipo`'s **full list of selectable option values**, read live from the DB in the request data lang — so the client can render a search-panel dropdown pre-filter for `numisdata140`. The values are fetched at build time, not hardcoded.
- **Caching note**: like `fixed_filter`, `filter_by_list` resolves *record/DB data with no invalidation path*, so this config is rebuilt every request. See the [anti-pattern note](#caching-anti-pattern-record-derived-filters) below.

*See properties:* [`filter_by_list` vs `fixed_filter` vs `filter`](request_config.md#filter-vs-filter_by_list-vs-fixed_filter), [caching skip conditions](request_config.md#caching-and-the-cache-key).

---

## 10. With fixed filter

**Scenario**: Portal showing only records related to the *current* record (context-dependent).

```json
{
  "source": {
    "request_config": [
      {
        "api_engine": "dedalo",
        "sqo": {
          "section_tipo": [
            {
              "value": ["numisdata4"],
              "source": "section"
            }
          ],
          "fixed_filter": [
            {
              "source": "component_data",
              "operator": "$or",
              "value": [
                {
                  "q": "numisdata30",
                  "path": [
                    { "section_tipo": "numisdata4", "component_tipo": "numisdata159" }
                  ],
                  "search_section_id": true
                }
              ]
            }
          ]
        },
        "show": {
          "ddo_map": [
            {
              "tipo": "numisdata27",
              "section_tipo": "self",
              "parent": "self"
            }
          ]
        }
      }
    ]
  }
}
```

**Explanation**: a `fixed_filter` descriptor is `{source, operator?, value}`; `source` selects one of three resolution strategies (each documented in [request_config.md → `filter` vs `filter_by_list` vs `fixed_filter`](request_config.md#filter-vs-filter_by_list-vs-fixed_filter)):
- `"fixed_dato"` — embedded SQO filter objects, used as-is (installed-tipo checked).
- `"component_data"` (shown above) — the filter value is **resolved from the calling record's own data**: with no `ddo_map`, the component named by `q` (`numisdata30`) is read from the *calling* section (here it lives in `numisdata3`, the record currently open); `search_section_id: true` joins the resolved locators' `section_id`s into one comma-separated filter against `path` (targeting `numisdata159` on the portal's `numisdata4` records). This is what makes the portal per-record: the filter changes with every calling record.
- `"hierarchy_terms"` — a thesaurus subtree (a term's children, flat or recursive) becomes a `section_id IN (...)` filter.
- **Caching note**: `fixed_filter` reads record data and therefore disables caching for this config. See the [anti-pattern note](#caching-anti-pattern-record-derived-filters).

*See properties:* [`fixed_filter`](request_config.md#filter-vs-filter_by_list-vs-fixed_filter), [caching skip conditions](request_config.md#caching-and-the-cache-key).

---

## 11. With interface controls

**Scenario**: Portal with custom button configuration.

The full list of `interface` keys, their defaults, and what each controls is the **canonical table in [rqo.md → show.interface](rqo.md#show-interface)** — it is not repeated here to avoid drift. Below is an illustrative config; only the keys actually used are explained.

```json
{
  "source": {
    "request_config": [
      {
        "api_engine": "dedalo",
        "sqo": {
          "section_tipo": [
            {
              "value": ["numisdata4"],
              "source": "section"
            }
          ]
        },
        "show": {
          "ddo_map": [
            {
              "tipo": "numisdata27",
              "section_tipo": "self",
              "parent": "self"
            }
          ],
          "interface": {
            "read_only": false,
            "button_add": true,
            "button_delete": true,
            "button_delete_link": true,
            "button_delete_link_and_record": false,
            "button_link": true,
            "button_edit": true,
            "button_edit_options": {
              "action_mousedown": "navigate",
              "action_contextmenu": "open_window"
            },
            "tools": false,
            "show_autocomplete": true
          }
        }
      }
    ]
  }
}
```

**Keys used here** (see [rqo.md](rqo.md#show-object-optional) for the rest):
- `button_delete_link: true` + `button_delete_link_and_record: false` — the delete modal offers "Unlink" but not "Unlink and delete the record".
- `button_edit: true` (non-default) with `button_edit_options` — left-click navigates to the record; right-click (context menu) opens it in a new window.
- `tools: false` — hides the component tools entry for this portal.

*See the canonical reference:* [rqo.md → show.interface](rqo.md#show-interface).

---

## 12. Dynamic DDO map

**Scenario**: Use `get_ddo_map` to build columns from a shared `section_map` instead of listing them inline.

```json
{
  "source": {
    "request_config": [
      {
        "api_engine": "dedalo",
        "sqo": {
          "section_tipo": [
            {
              "value": ["numisdata3"],
              "source": "section"
            }
          ]
        },
        "show": {
          "get_ddo_map": {
            "model": "section_map",
            "columns": [
              {
                "path": ["components", "identification"]
              },
              {
                "path": ["components", "mint"]
              },
              {
                "path": ["components", "date"]
              }
            ]
          },
          "sqo_config": {
            "limit": 10
          }
        }
      }
    ]
  }
}
```

**Section map definition** (in the `section_map` child term's properties):
```json
{
  "components": {
    "identification": ["numisdata27", "numisdata28"],
    "mint": ["numisdata30"],
    "date": ["numisdata35"]
  }
}
```

**Explanation**:
- `get_ddo_map` is a `{model: "section_map", columns: [...]}` directive; the server resolves it from `section::get_section_map()` into a concrete `ddo_map` at build time.
- Each `path` navigates the section_map properties structure; `["components", "mint"]` pulls the `numisdata30` ddo.
- Changing the section_map propagates to every section that references it — the canonical way to share column definitions.

*See properties:* [`get_ddo_map` resolution and the `section_map`](request_config.md#get_ddo_map-dynamic-ddo_map).

---

## 13. Create → edit round-trip

**Scenario**: The canonical "new record" lifecycle — create an empty record, then open it in edit mode. These are **RQO calls** the client makes (`dd_core_api`); they are not stored in the ontology.

**Step 1 — create** an empty record in the section's matrix table:

```json
{
  "action" : "create",
  "dd_api" : "dd_core_api",
  "source" : {
    "typo"         : "source",
    "type"         : "section",
    "model"        : "section",
    "tipo"         : "numisdata3",
    "section_tipo" : "numisdata3",
    "mode"         : "list",
    "lang"         : "lg-eng"
  }
}
```

Response (`result` is the new `section_id` as a string, or `false` on failure):

```json
{ "result": "1042", "msg": "OK. Request done successfully", "errors": [] }
```

**Step 2 — read** that record in edit mode, filtered to the new id:

```json
{
  "action" : "read",
  "dd_api" : "dd_core_api",
  "source" : {
    "typo"         : "source",
    "type"         : "section",
    "action"       : "search",
    "model"        : "section",
    "tipo"         : "numisdata3",
    "section_tipo" : "numisdata3",
    "section_id"   : 1042,
    "mode"         : "edit",
    "lang"         : "lg-eng"
  },
  "sqo" : {
    "section_tipo"       : ["numisdata3"],
    "limit"              : 1,
    "offset"            : 0,
    "filter_by_locators" : [{ "section_tipo": "numisdata3", "section_id": 1042 }]
  }
}
```

**Explanation**:
- `create` requires write permission (≥ 2) on the section and uses the counter service to allocate the new `section_id`; it does **not** take an `sqo`.
- The follow-up `read` uses `sqo.filter_by_locators` to pin exactly the new record, `limit: 1` and `mode: "edit"`. The `show` layout is resolved server-side from the section's ontology `request_config` (e.g. [#2](#2-section-edit-configuration)), so the call carries no `show` of its own.
- The top-level `action` is `read`; the per-element behavior is `source->action: "search"`.

*See:* [rqo.md → create / read actions](rqo.md#action-string-mandatory), [request_config.md → edit pagination default](request_config.md#default-limits).

---

## 14. Duplicate, delete and count

**Scenario**: Record-lifecycle RQO calls beyond create — deep-copy, multi-record delete with mode flags, and a non-blocking count.

**Duplicate** a record (deep copy). Two security gates apply: section write (≥ 2) **and** `security::assert_record_in_user_scope()`. `result` is the new `section_id`:

```json
{
  "action" : "duplicate",
  "dd_api" : "dd_core_api",
  "source" : {
    "typo"       : "source",
    "type"       : "section",
    "model"      : "section",
    "tipo"       : "numisdata3",
    "section_tipo" : "numisdata3",
    "section_id" : 1042,
    "mode"       : "list",
    "lang"       : "lg-eng"
  }
}
```

**Delete** one or more records. Targets come from `sqo.filter_by_locators` (preferred, multi-record) or `source->section_id`:

```json
{
  "action" : "delete",
  "dd_api" : "dd_core_api",
  "source" : {
    "typo"       : "source",
    "type"       : "section",
    "model"      : "section",
    "tipo"       : "numisdata3",
    "section_tipo" : "numisdata3",
    "mode"       : "list",
    "lang"       : "lg-eng"
  },
  "sqo" : {
    "filter_by_locators" : [
      { "section_tipo": "numisdata3", "section_id": 1042 },
      { "section_tipo": "numisdata3", "section_id": 1043 }
    ]
  },
  "options" : {
    "delete_mode"               : "delete_record",
    "delete_with_children"      : true,
    "delete_diffusion_records"  : true
  }
}
```

**Explanation**:
- `delete_mode` — `"delete_data"` empties the record's components but keeps the (now-empty) record; `"delete_record"` removes the record itself.
- `delete_with_children: true` — also delete the record's hierarchy children.
- `delete_diffusion_records: true` — also remove the published diffusion rows for these records.
- `delete` is section-model only and requires write (≥ 2). Using `filter_by_locators` deletes several records in one call.

!!! note "Delete option flags"
    `options.delete_with_children` is read at the dispatch chokepoint: it lets
    the caller explicitly accept subtree orphaning, bypassing the
    children-exist refusal for the ontology/hierarchy registry cascade (only
    those registry sections cascade their whole TLD on delete — an arbitrary
    section's hierarchy-children are not recursively deleted). `options.delete_diffusion_records`
    is accepted on the wire but not read anywhere: diffusion unpublish runs
    unconditionally as a post-commit step of every `delete_record`, with no
    opt-out. `delete_mode` and `filter_by_locators`-based multi-delete are
    fully implemented.

**Count** without blocking the session (forces `full_count`, merges the session filter, and returns `0` on permission denial — no leak):

```json
{
  "action" : "count",
  "dd_api" : "dd_core_api",
  "prevent_lock" : true,
  "source" : {
    "typo": "source", "type": "section", "model": "section",
    "tipo": "numisdata3", "section_tipo": "numisdata3", "mode": "list"
  },
  "sqo" : { "section_tipo": ["numisdata3"], "filter": null }
}
```

`result` is `{ "total": <int> }` (or `0` when access is denied).

*See:* [rqo.md → Use cases (count)](rqo.md#count-without-blocking-the-session), [rqo.md → security gates](rqo.md#security-model-summary).

---

## 15. Time-machine read

**Scenario**: Read a component's historical value from the time-machine (`dd15`). The time-machine service model is permission-exempt by design (it serves snapshots, not live data).

```json
{
  "action" : "read",
  "dd_api" : "dd_core_api",
  "source" : {
    "typo"         : "source",
    "type"         : "component",
    "action"       : "get_data",
    "model"        : "component_input_text",
    "tipo"         : "numisdata27",
    "section_tipo" : "numisdata3",
    "section_id"   : 42,
    "mode"         : "tm",
    "lang"         : "lg-eng",
    "data_source"  : "tm",
    "matrix_id"    : 987654
  }
}
```

**Explanation**:
- `mode: "tm"` + `source->data_source: "tm"` — route the read through the time-machine instead of the live matrix table.
- `matrix_id` addresses the specific historical matrix row to resolve.
- `source->action: "get_data"` — data-only for one component (honors `matrix_id`/`data_source`, pagination and `ar_target_section_tipo`).
- The time-machine section tipo is `dd15` (`DEDALO_TIME_MACHINE_SECTION_TIPO`); a `count` over it goes through `service_time_machine`, which is exempt from the usual section permission checks.

*See:* [rqo.md → source fields (`matrix_id`, `data_source`)](rqo.md#source-object-mandatory), [`read · get_data` modifier](rqo.md#read-one-record-in-edit-mode).

---

## 16. Paginated next page and multi-filter search

**Scenario**: Advance a section list to its second page, and run a multi-clause search-panel filter. Both are RQO `read · search` calls; the session SQO keeps navigation continuous across calls.

**Next page** — same source as the list, with `offset` advanced by `limit`:

```json
{
  "action" : "read",
  "dd_api" : "dd_core_api",
  "source" : {
    "typo": "source", "type": "section", "action": "search", "model": "section",
    "tipo": "numisdata3", "section_tipo": "numisdata3", "mode": "list", "lang": "lg-eng"
  },
  "sqo" : {
    "section_tipo" : ["numisdata3"],
    "limit"        : 10,
    "offset"       : 10
  }
}
```

**Multi-filter** — an `$and` of clauses across several component paths, as the search panel emits:

```json
{
  "action" : "read",
  "dd_api" : "dd_core_api",
  "source" : {
    "typo": "source", "type": "section", "action": "search", "model": "section",
    "tipo": "numisdata3", "section_tipo": "numisdata3", "mode": "list", "lang": "lg-eng"
  },
  "sqo" : {
    "section_tipo" : ["numisdata3"],
    "filter" : {
      "$and": [
        { "q": "Rome", "path": [{ "section_tipo": "numisdata3", "component_tipo": "numisdata30" }] },
        {
          "$or": [
            { "q": "aureus", "path": [{ "section_tipo": "numisdata3", "component_tipo": "numisdata27" }] },
            { "q": "denarius", "path": [{ "section_tipo": "numisdata3", "component_tipo": "numisdata27" }] }
          ]
        }
      ]
    },
    "limit"  : 10,
    "offset" : 0
  }
}
```

**Explanation**:
- `read · search` (the default `source->action`) persists the SQO to the session for section list/edit/list_thesaurus, so the *next* page can continue navigation even if a later call omits the filter.
- The first clause matches mint = "Rome"; the nested `$or` matches denomination "aureus" or "denarius"; the whole filter is their `$and`. Each `q`/`path` clause is one component-path search term — full grammar in [sqo.md](sqo.md).
- The server clamps `limit` regardless of what the client sends; send `limit: null` to accept the mode default.

*See:* [rqo.md → Autocomplete search / `source->action: search`](rqo.md#autocomplete-search-service_autocomplete), [request_config.md → Session Override](request_config.md#session-override), [sqo.md](sqo.md) for the filter grammar.

---

## 17. Lazy context and graph term labels

**Scenario**: Two public read-only helpers used after a list/graph renders — lazy structure context for one element, and batch label resolution for graph nodes.

**Lazy element context** (`search.get_component()` after the list draws). `simple: true` returns the lightweight structure context, no data:

```json
{
  "action" : "get_element_context",
  "dd_api" : "dd_core_api",
  "source" : {
    "typo": "source", "type": "component", "model": "component_input_text",
    "tipo": "numisdata27", "section_tipo": "numisdata3", "mode": "list", "lang": "lg-eng"
  },
  "simple" : true
}
```

`result` is the element's context object. For the filter panel's field list, the sibling action `get_section_elements_context` returns an *array* of component contexts for one or more sections (`options.context_type: "simple"`, `use_real_sections`, `ar_components_exclude`).

**Batch graph term labels** — resolve authoritative section_map term labels for many locators at once (≤ 1000), used by the graph/tree view:

```json
{
  "action" : "get_section_terms",
  "dd_api" : "dd_core_api",
  "prevent_lock" : true,
  "source" : { "typo": "source", "type": "section", "tipo": "numisdata3", "mode": "list" },
  "locators" : [
    { "section_tipo": "numisdata3", "section_id": 42 },
    { "section_tipo": "numisdata4", "section_id": 17 }
  ]
}
```

`result` is an object keyed `"{section_tipo}_{section_id}" => term`; bad or unreadable locators are silently skipped (no error, no leak).

**Explanation**:
- `get_element_context` / `get_section_elements_context` fetch *structure only* — pair them with the rendered list so columns can lazy-load their context without re-reading data. Both are registered in the TS `dd_core_api` action table (`src/core/api/dispatch.ts`).
- `get_section_terms` is the graph-view label resolver; it caps at 1000 locators per call and is safe to run with `prevent_lock: true`.

!!! note "get_matrix_ontology_locator / test are not registered"
    `get_section_terms` and `get_indexation_grid` are both registered in
    `ACTION_REGISTRY['dd_core_api']`. `get_matrix_ontology_locator` and `test`
    are not. See [rqo.md → `dd_core_api` actions](rqo.md#action-string-mandatory)
    for the current action set.

*See:* [rqo.md → dd_core_api actions](rqo.md#action-string-mandatory), [section_map resolution](request_config.md#get_ddo_map-dynamic-ddo_map).

---

## 18. Portal full grid in one read

**Scenario**: Read one record and get a portal's **entire** related grid — all rows and the chosen columns — in a *single* call, instead of the default page. This is the **reverse path**: the client sends `show.ddo_map` and the server rebuilds the element's request_config from the RQO (`build_request_config_from_rqo`). It is how `tool_print` renders a record's bibliography portal without per-portal/per-row calls.

```json
{
  "action" : "read",
  "dd_api" : "dd_core_api",
  "source" : {
    "typo": "source", "type": "section", "action": "search", "model": "section",
    "tipo": "numisdata6", "section_tipo": "numisdata6", "mode": "list", "lang": "lg-spa"
  },
  "sqo" : {
    "section_tipo"       : ["numisdata6"],
    "limit"              : 1,
    "offset"             : 0,
    "filter_by_locators" : [{ "section_tipo": "numisdata6", "section_id": 2 }]
  },
  "show" : {
    "ddo_map" : [
      { "tipo": "numisdata1007", "section_tipo": "self", "parent": "numisdata6", "mode": "list" },

      { "tipo": "numisdata163", "section_tipo": "self", "parent": "numisdata6",
        "model": "component_portal", "mode": "list", "view": "default",
        "column_id": "numisdata163", "limit": 0 },

      { "tipo": "rsc368", "section_tipo": "rsc332", "parent": "numisdata163", "column_id": "a",
        "model": "component_portal", "mode": "list",
        "with_value": { "mode": "list", "view": "line" }, "children_view": "text", "fixed_mode": true },
      { "tipo": "rsc336", "section_tipo": "rsc332", "parent": "numisdata163", "column_id": "b",
        "model": "component_input_text", "mode": "list", "fixed_mode": true },
      { "tipo": "rsc369", "section_tipo": "rsc332", "parent": "numisdata163", "column_id": "c",
        "model": "component_input_text", "mode": "list", "fixed_mode": true }
    ],
    "sqo_config" : { "full_count": false, "limit": 1, "offset": 0, "mode": "list", "operator": "$or" }
  }
}
```

**Explanation**:
- `sqo.filter_by_locators` + `limit: 1` pin exactly the record to read; `show.ddo_map` is **client-sent**, so the server rebuilds this element's request_config from the RQO (the same `build_request_config_from_rqo` path used by time machine / graph view / `tool_print`).
- `numisdata163` (Bibliografía) is a `component_portal`. Its **columns are the *sibling* ddos** `rsc368` / `rsc336` / `rsc369`, each carrying `parent: "numisdata163"` + a `column_id` (`a`/`b`/`c`) — **not** nested inside the portal ddo. The server collects them by `parent` (`get_children_recursive`) and grafts them into the portal's own (rebuilt) config. A `request_config`/`sqo` placed *on* the portal ddo would be ignored.
- **`"limit": 0` on the portal ddo is the key**: it returns **all** related rows in this one read instead of the portal's mode default (1 in list, 10 in edit) — the read equivalent of the portal's "show all". The rows are loaded regardless (a portal always loads its references for sorting); `limit` only sets the *output slice*. See [dd_object.md → How a ddo_map resolves](dd_object.md#how-a-ddo_map-resolves-the-chain).
- `with_value` (per-data mode/view), `children_view` and `fixed_mode` tune how each column renders.
- The client-sent ddos pass the gate: `sanitize_client_ddo_map()` keeps only whitelisted fields (now including `limit`/`offset`, as non-negative ints) and `validate_requested_ddo()` re-checks tipo/TLD/permissions — so this cannot widen access, only the page size of data the user can already read.

*See properties:* [per-ddo `limit` / `column_id` / `with_value` / `fixed_mode`](dd_object.md#properties), [the ddo chain + client whitelist](dd_object.md#how-a-ddo_map-resolves-the-chain), [`show.ddo_map`](rqo.md#show-object-optional), [config rebuilt from the client RQO (Stage 1)](request_config.md).

---

## Common patterns

### Pattern: minimal configuration

The smallest valid config — one column, defaults for everything else:

```json
{
  "source": {
    "request_config": [
      {
        "show": {
          "ddo_map": [
            {"tipo": "component_tipo", "section_tipo": "self", "parent": "self"}
          ]
        }
      }
    ]
  }
}
```

### Pattern: read-only display

```json
{
  "source": {
    "request_config": [
      {
        "show": {
          "ddo_map": ["..."],
          "interface": {
            "read_only": true,
            "button_add": false,
            "button_delete": false,
            "button_link": false,
            "tools": false
          }
        }
      }
    ]
  }
}
```

### Pattern: high-volume portal

```json
{
  "source": {
    "request_config": [
      {
        "sqo": {
          "section_tipo": ["..."],
          "limit": 100
        },
        "show": {
          "ddo_map": ["..."],
          "sqo_config": {
            "limit": 100,
            "full_count": false
          }
        }
      }
    ]
  }
}
```

`full_count: false` skips the expensive total-count query — use it when the UI does not need an exact record count.

### `fixed_filter` and `filter_by_list` always read live data

`fixed_filter` ([#10](#10-with-fixed-filter)) and `filter_by_list` ([#9](#9-with-pre-filters)) both read record/DB data. Since there is no config-level cache at all (see [request_config.md → Caching](request_config.md#caching-and-the-cache-key)), this is not a special case to opt out of — every build already re-reads this live data on every request.

---

## Testing your configuration

1. **Read the error contract** — an invalid tipo, an unresolvable node, or a missing model simply drops the ddo from the `ddo_map` with no warnings field to inspect (see [request_config.md → Error contract](request_config.md#error-contract-and-warnings)); step through `buildRequestConfigForElement()`/`processSingleDdo()` directly when a `ddo_map` comes back unexpectedly empty.
2. **Diagnose at the wire level** — for RQO/transport problems (empty result with no error, stale list, CSRF, empty `section_tipo`) use [rqo.md → Troubleshooting](rqo.md#troubleshooting).
3. **Test with different user permissions** — per-ddo permission gating only applies to SECTION-owned explicit configs (see [request_config.md → Explicit vs implicit configuration](request_config.md#explicit-vs-implicit-configuration)); verify with several access levels.
