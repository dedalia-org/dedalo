# UCA Maps (`tool_uca_maps`)

> See also: [Tools user guide](index.md) · [Developer reference](../development/tools/reference/tool_uca_maps.md)

A cartography toolbar for the map component: inspect, style and export each drawn object, add
your own basemaps and WMS layers, upload vector files and georeferenced images, look up cadastral
parcels and administrative units, search places (modern and ancient), keep a legend, and download
the map as an image.

## What it's for

The map component (`component_geolocation`) stores a point and the objects drawn on it. Working
with heritage sites (excavations, monuments, find spots) needs more than that: measuring an
area, bringing in a survey delivered as a shapefile, placing a scanned excavation plan over the
map, checking which cadastral parcel a site sits on, or handing a georeferenced map to someone
who works in a GIS.

Concrete scenario: an archaeologist receives the boundary of a site as a zipped shapefile in UTM
zone 30N and a scanned plan of the dig. They open the site's record, upload the shapefile (the
tool reprojects it onto the map), place the plan over the map as an image and fit it by its
corners, click the boundary to read its area and mark it as the record's uncertainty area, check
the Catastro parcel underneath, add a legend, and download the result as a GeoTIFF that opens in
QGIS where it belongs.

## When to use it

- You need to measure, style, describe or export an object drawn on a record's map.
- You have geographic data in a file (shapefile, GeoJSON, KML) or a georeferenced image
  (GeoTIFF) and want it on the record's map.
- You want an extra basemap or WMS layer on this record, or a legend explaining its symbols.
- You want the cadastral parcel or the administrative unit at a point (Spain), or the location of
  a place by its modern or ancient name.

When NOT to use it:

- To set only the record's point or draw a simple shape, the map component's own drawing tools
  are enough; this tool adds to them, it does not replace them.
- To import geographic data into many records at once, use [CSV import](using_import_dedalo_csv.md)
  or [RDF import](using_import_rdf.md).

## Where to find it

The tool appears **inline on map components** (`component_geolocation`) in edit mode, where your
profile is authorized for it. Click its button on the map: a short modal opens while the tool
loads, and its buttons then appear in a vertical bar on the left of the map. Most buttons open
their own panel, and only one panel is open at a time; Catastro and Create 1x1 polygon are on/off
modes without a panel.

The map tool works best with the map in full screen (the map component's own full-screen button).

!!! warning "Most changes wait for the map's save button"
    Drawing, styling, uploading, editing the legend or moving the map mark it as changed; only
    the map component's own **save** button writes them to the record, and leaving the record
    without saving loses them. The exception is adding or deleting an XYZ basemap or a WMS
    layer: that saves the map at once, together with any change still pending on it.

## Using it, button by button

The buttons, top to bottom:

1. **Object console** (always active). Click any object on the map (marker, line, polygon,
   circle, rectangle) and its console opens:
   - **Information**: geometry type, coordinates, centre, the centre's elevation (looked up
     online), and the area, radius or length depending on the type.
   - **Style**: colour, fill opacity, line width, line opacity and dash pattern.
   - **Vector download**: the object as **GeoJSON**, **Shapefile** (zipped) or **KML**.
   - **Centroid**: adds a marker at the object's geometric centre.
   - **Uncertainty** (polygons): stores the polygon's area and its scale tier in the object, and
     follows the polygon when you reshape it.
   - **Hierarchy of the object** (not for markers): bring it to the **Front** or send it to the
     **Back**; unchecking puts it back in the order a reload would draw.
   - **Properties**: add, edit and delete key-value pairs, and **Export as PDF** a sheet with the
     object, its properties and its associated image.
   - **Associate image**: attach a JPG or PNG to the object and browse the **Gallery**. When the
     object carries links to images on another website (for example in a GeoJSON's
     `properties.images`), **Import linked images** brings them in as image records.

   Click an **image placed on the map** instead and the console shows **View image** (the
   original), **Enable editing** (move, rotate and fit the image by its corners), **Opacity**,
   **z-index**, and **Image download** as **GeoTIFF**, PNG or JPG.
2. **Download map as image**: type a file name and pick **PNG**, **JPG**, **GIF**, **WebP** or
   **GeoTIFF** (georeferenced, opens in a GIS). If a layer loads straight from its provider and
   cannot be drawn into the image, the panel says which.
3. **Objects**: two lists, **Vector Objects** and **Rasterized Objects** (images). A checkbox
   shows or hides each object; the eye button centres the map on it.
4. **Create 1x1 polygon**: turn the mode on and click a marker: a 1 m² square is drawn around it,
   already marked as uncertainty, and the marker is locked in place.
5. **XYZ basemaps**: the available basemaps, and a form to add your own by URL template
   (`https://…/{z}/{x}/{y}.png`), attribution and minimum/maximum zoom. Adding one saves it in
   the record at once; it is listed under **Saved in this record**, where you reorder or delete
   it.
6. **WMS services**: paste the address of a WMS server, search its layers and add the ones you
   want; each one is saved in the record as you add it. Each added layer has a visibility
   checkbox, an **Opacity** slider and a delete button.
7. **Catastro** (Spain; see the conditions below): turn it on and click the map to fetch the
   cadastral parcel at that point and draw it. The Catastro layer is shown over the basemap, not
   instead of it.
8. **Administrative Units** (Spain; same language condition): shows the administrative units
   layer over the basemap; click the map to name the unit at that point.
9. **Upload file to map**: two panels.
   - **Upload vector file**: `.zip` (shapefile), `.geojson` or `.kml`, up to 10 MB. A file that
     declares its projection is reprojected automatically. One that does not (a GeoJSON without
     `crs`, a shapefile without `.prj`) needs its projection chosen from **Default projections**
     or typed in (for example `EPSG:25830`). A multi-part geometry arrives as one object per part,
     so each part can be measured and styled on its own.
   - **Upload image**: `.tif` (georeferenced), `.jpg`, `.jpeg` or `.png`. A GeoTIFF lands at its
     own coordinates; an image without coordinates is placed over the current view, ready to fit
     with **Enable editing**. The image is stored as an image record linked to the map.
10. **Place search**: type a place name and pick a result; the map centres on it.
11. **Geolocation**: centres the map on your current position (your browser asks for permission).
12. **Legend**: a title, groups and elements, each element with a symbol (point, line or area,
    with its colours) or an uploaded image (recommended 36×36). **Show legend** draws it on the
    map, on the record's small map, and in the downloaded image.
13. **Roman Empire**: three gazetteers of the ancient world. **Pleiades** (by place name or by
    Pleiades id), **Pelagios** (by name, across the chosen layers) and **DARE**
    (imperium.ahlfeldt.se, by modern or ancient name, type and country). A result with a location
    centres the map on it.

A scale bar sits in the bottom-right corner of the map, also on the record's small map.

## Tips and gotchas

!!! note "Catastro and Administrative Units depend on the record's data language"
    Both buttons appear only when the record's data language is Spanish, Catalan or Basque. The
    Catastro button also needs an administrator to enable Catastro for that map (see below);
    without it the button does not appear. Parcels in the Canary Islands cannot be looked up from
    the map yet: the tool says so instead of returning a wrong parcel.

!!! note "Administrative Units names the unit; it does not draw it"
    Clicking the map names the unit the service returns at that point. It does not add the unit's
    polygon to the record.

!!! warning "Shapefile export cuts texts at 254 characters"
    This is a limit of the shapefile format (its DBF table). GeoJSON and KML keep the full text:
    use them when an object's properties hold long texts.

!!! note "A WMS layer's opacity lasts for the session"
    An added WMS layer is saved with the record, but its opacity is not: it starts fully opaque
    after a reload.

!!! note "Layers that load straight from their provider"
    Some basemaps load directly from their provider (ArcGIS by default, and DARE) and cannot be
    drawn into a downloaded image. The download panel names them. An administrator can route
    ArcGIS through the server (see below), or you can add the layer to the record from the XYZ
    panel.

!!! note "Removing an image from the map keeps its image record"
    The image record created by an upload stays in the image section when you remove the image from
    the map; delete it there if it is no longer needed.

!!! tip "The PDF embeds JPEG images"
    The object's PDF sheet includes its associated image when that image is a JPEG; otherwise the
    sheet says why it was left out.

!!! note "DARE and accents"
    DARE does not find names written with accents (`Cádiz` finds nothing, `Gades` does). This is
    how the service behaves.

## For administrators

### Enable Catastro, named administrative units and ArcGIS

Catastro is not built into Dédalo (its licence must be accepted by the institution that uses it),
so each map component declares it in its ontology node. The same list can carry the IGN
administrative units with names, and ArcGIS routed through the server. The steps, as a developer
or root user:

1. In the ontology, open the node of the map component (for example `rsc900`, the map of the
   Entities section `rsc295`). On a production install, prefer a
   [local ontology override](../core/ontology/local_ontology_overrides.md): an ontology update
   overwrites the shared node.
2. In **Properties**, add a `map_sources` key next to the existing ones and save:
   ```json
   "map_sources": [
     { "id": "catastro", "label": "Catastro", "type": "wms",
       "url": "https://ovc.catastro.meh.es/Cartografia/WMS/ServidorWMS.aspx",
       "params": { "version": "1.1.1", "layers": "Catastro", "styles": "", "format": "image/png",
                   "transparent": true, "crs": "EPSG:3857" },
       "attribution": "Sede Electrónica del Catastro — Dirección General del Catastro" },
     { "id": "ign_unidades", "label": "Unidades administrativas (IGN)", "type": "wms",
       "url": "https://www.ign.es/wms-inspire/unidades-administrativas",
       "params": { "version": "1.3.0", "layers": "AU.AdministrativeUnit", "styles": "",
                   "format": "image/png", "transparent": true, "crs": "EPSG:3857" },
       "attribution": "CC BY 4.0 ign.es" },
     { "id": "arcgis", "label": "ArcGIS", "type": "xyz",
       "url": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
       "params": { "min_zoom": 0, "max_zoom": 19 },
       "attribution": "Tiles © Esri — Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community" }
   ]
   ```
   `catastro` enables the Catastro button. `ign_unidades` is optional: without it, Administrative
   Units shows the built-in boundaries layer (lines only); with it, the IGN layer with unit names.
   `arcgis` is also optional: with it, the tool's ArcGIS basemap goes through the server and is
   included in downloaded images. Keep only the entries you want.
3. Process the change: in the inspector, the row under the top buttons has an unlabelled icon
   (**Ontology** on hover, or Ctrl+S) → **Process**. Saving without processing changes nothing.
4. Reload the record: the Catastro button appears.

By enabling Catastro the institution accepts its download licence and the conditions of its
online service (no bulk downloads). Its attribution carries the date of the day, as the licence
requires.

### Tool options

Set in the Tools configuration section (`dd996`), over the defaults the tool ships:

- `external_images_enabled` (default `true`): allows **Import linked images**. Set it to `false`
  to stop the tool from fetching images from other websites.
- `gazetteer_data_path` (empty by default): the directory holding the Pleiades and Pelagios data.
  The tool ships no gazetteer data; fill the directory with
  `bun tools/tool_uca_maps/gazetteers/provision.ts --out <dir>`. Without it the Roman Empire panel
  offers DARE only, and says so for the other two.

### Server requirement: GDAL

Format conversions (shapefile and KML export and import, reprojection, GeoTIFF export, placing a
GeoTIFF at its own coordinates) run the GDAL command-line programs (`ogr2ogr`, `ogrinfo`,
`gdal_translate`, `gdalwarp`, `gdalinfo`, `gdalsrsinfo`) on the server. Without GDAL, an uploaded
GeoTIFF is placed over the current view, and the panel says why.

## Related

- **[Upload](using_upload.md)**: the shared post-upload step that files an uploaded image into
  its image record.
- **[Media versions](using_media_versions.md)**: manage the image records the tool creates for
  uploaded and linked images.
- **[Developer reference](../development/tools/reference/tool_uca_maps.md)**: the server actions,
  their permission gates, the external services and the GDAL conversions.
