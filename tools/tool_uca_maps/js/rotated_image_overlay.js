// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L*/
/*eslint no-undef: "error"*/

/**
 * ROTATED_IMAGE_OVERLAY
 * An image placed by THREE corners (top-left, top-right, bottom-left), not a
 * bbox: a GeoTIFF reprojected to WGS84 is a rotated, skewed quadrilateral that
 * `L.imageOverlay(url, bounds)` would stretch. One CSS `matrix()` maps the
 * picture onto the parallelogram the three span; the fourth corner follows.
 */

/**
 * CORNER_TRANSFORM
 * The geometry alone, in layer pixels, so it can be tested without a map: the
 * box the parallelogram occupies (where the container goes, and its size) and
 * the affine matrix taking the picture's own pixels onto it, relative to that box.
 *
 * @param {{x:number, y:number}} top_left
 * @param {{x:number, y:number}} top_right
 * @param {{x:number, y:number}} bottom_left
 * @param {number} width - the picture's natural width, px
 * @param {number} height - the picture's natural height, px
 * @returns {{min:{x:number, y:number}, size:{x:number, y:number}, matrix:number[]|null}}
 *   `matrix` is null while the picture has no size yet (not loaded)
 */
export const corner_transform = function (top_left, top_right, bottom_left, width, height) {
	const bottom_right = {
		x: top_right.x + bottom_left.x - top_left.x,
		y: top_right.y + bottom_left.y - top_left.y,
	};
	const xs = [top_left.x, top_right.x, bottom_left.x, bottom_right.x];
	const ys = [top_left.y, top_right.y, bottom_left.y, bottom_right.y];
	const min = { x: Math.min(...xs), y: Math.min(...ys) };
	const size = { x: Math.max(...xs) - min.x, y: Math.max(...ys) - min.y };

	if (!(width > 0) || !(height > 0)) {
		return { min, size, matrix: null };
	}

	// the first column is where one picture pixel along x lands, the second
	// where one along y lands; the translation puts the picture's origin on
	// the top-left corner, measured from the box
	const matrix = [
		(top_right.x - top_left.x) / width,
		(top_right.y - top_left.y) / width,
		(bottom_left.x - top_left.x) / height,
		(bottom_left.y - top_left.y) / height,
		top_left.x - min.x,
		top_left.y - min.y,
	];

	return { min, size, matrix };
}; //end corner_transform

/**
 * BUILD_OVERLAY_CLASS
 * Built on first use: `L` exists only once component_geolocation loaded Leaflet.
 * `_image` is the CONTAINER, the name the inherited methods (opacity, z-index,
 * zoom re-placing and animation, removal) work on; the picture inside carries the
 * matrix. Options: opacity, zIndex, className, alt; no `interactive` (the carrier
 * takes the clicks).
 *
 * @returns {Function} an L.ImageOverlay subclass
 */
const build_overlay_class = function () {
	return L.ImageOverlay.extend({
		initialize(url, top_left, top_right, bottom_left, options) {
			this._url = url;
			this._set_corners(top_left, top_right, bottom_left);
			L.setOptions(this, options);
		},

		_initImage() {
			const picture = (this._picture = L.DomUtil.create('img', 'leaflet-image-layer'));
			// hidden until loaded: with no size there is no matrix yet, and it
			// would flash at its natural size in the container's corner
			picture.style.display = 'none';
			picture.style.transformOrigin = '0 0';
			picture.alt = this.options.alt;
			picture.onload = () => {
				picture.style.display = 'block';
				this._reset();
				this.fire('load');
			};
			picture.onerror = () => this.fire('error');
			picture.src = this._url;

			const container = (this._image = L.DomUtil.create('div', 'leaflet-image-layer'));
			if (this._zoomAnimated) {
				L.DomUtil.addClass(container, 'leaflet-zoom-animated');
			}
			if (this.options.className) {
				L.DomUtil.addClass(container, this.options.className);
			}
			container.onselectstart = L.Util.falseFn;
			container.onmousemove = L.Util.falseFn;
			container.appendChild(picture);

			this._updateZIndex();
		},

		_reset() {
			const map = this._map;
			if (!map || !this._image) {
				return;
			}

			const { min, size, matrix } = corner_transform(
				map.latLngToLayerPoint(this._top_left),
				map.latLngToLayerPoint(this._top_right),
				map.latLngToLayerPoint(this._bottom_left),
				this._picture.naturalWidth,
				this._picture.naturalHeight,
			);

			const box_min = L.point(min.x, min.y);
			L.DomUtil.setPosition(this._image, box_min);
			this._image.style.width = size.x + 'px';
			this._image.style.height = size.y + 'px';
			// the inherited zoom animation scales the container by these bounds
			this._bounds = L.latLngBounds(
				map.layerPointToLatLng(box_min),
				map.layerPointToLatLng(box_min.add(L.point(size.x, size.y))),
			);

			if (matrix) {
				this._picture.style.transform = 'matrix(' + matrix.join(', ') + ')';
			}
		},

		// the inherited setUrl writes `src` on `_image`, which here is the container
		setUrl(url) {
			this._url = url;
			if (this._picture) {
				this._picture.src = url;
			}
			return this;
		},

		_set_corners(top_left, top_right, bottom_left) {
			this._top_left = L.latLng(top_left);
			this._top_right = L.latLng(top_right);
			this._bottom_left = L.latLng(bottom_left);
		},

		/**
		 * REPOSITION
		 * Moves the picture onto three new corners (image_edit.js: a handle drag,
		 * a carrier drag).
		 */
		reposition(top_left, top_right, bottom_left) {
			this._set_corners(top_left, top_right, bottom_left);
			this._reset();
			return this;
		},

		/**
		 * GET_CORNERS
		 * @returns {{top_left:Object, top_right:Object, bottom_left:Object}} L.LatLng each
		 */
		get_corners() {
			return {
				top_left: this._top_left,
				top_right: this._top_right,
				bottom_left: this._bottom_left,
			};
		},
	});
}; //end build_overlay_class

let overlay_class = null;

/**
 * ROTATED_IMAGE_OVERLAY
 * @param {string} url
 * @param {Object} top_left - anything L.latLng accepts
 * @param {Object} top_right
 * @param {Object} bottom_left
 * @param {Object} [options] - opacity, zIndex, className, alt
 * @returns {Object} the overlay, not yet on a map
 */
export const rotated_image_overlay = function (url, top_left, top_right, bottom_left, options) {
	overlay_class = overlay_class || build_overlay_class();

	return new overlay_class(url, top_left, top_right, bottom_left, options);
}; //end rotated_image_overlay

// @license-end
