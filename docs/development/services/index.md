# Services

> See also: [Add a service](../extending/add_a_service.md) · [services subsystem reference](../../core/system/services.md) · [Glossary → service](../../understanding/glossary.md#service)

A [service](../../understanding/glossary.md#service) is a specialized, mostly client-side code element that provides a shared function — file upload, autocomplete, access to Time Machine versions, a text editor, and so on — in a unified way, reused by components, sections and tools. A service is instanced *by* a caller and acts on the caller's behalf; it has no ontology node and no data of its own.

This page shows the instancing pattern shared by every service. To build a new one, follow [Add a service](../extending/add_a_service.md); for the full subsystem reference (every shipped service and its public API), see the [services reference](../../core/system/services.md).

## Instancing a service

The generic pattern — import the instance factory, instance the service, then run its `build` → `render` lifecycle:

``` js
// import instances module
import * as instances from '../../../core/common/js/instances.js'

// init
const service_sample = await instances.get_instance({
    model               : 'service_sample',
    custom_property     : ['value1','value2'],
    mode                : 'edit',
    id_variant          : 'my_service', // optionally set to prevent id collisions
    caller              : self // object mandatory, normally a component, tool or section instance
})

// build
await service_sample.build()

// render
const service_node = await service_sample.render()

// Place it in DOM
my_container_node.appendChild(service_node)
```

## Pages

- **[Service Upload](service_upload.md)** — the file-upload service: lifecycle, the `upload_file_done` event payload, and server-side path reconstruction.