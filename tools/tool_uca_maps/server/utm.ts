/**
 * UTM (ETRS89, GRS80) easting/northing → latitude/longitude, northern
 * hemisphere: Krüger's series to the sixth order of n (Karney 2011), sub-
 * millimetre over a zone. In the tool rather than through GDAL, which is
 * optional on an install: Catastro's ring must not depend on it.
 */

const A = 6378137;
const F = 1 / 298.257222101; // GRS80
const K0 = 0.9996;
const FALSE_EASTING = 500000;

const N = F / (2 - F);
const N2 = N * N;
const N3 = N2 * N;
const N4 = N3 * N;
const N5 = N4 * N;
const N6 = N5 * N;
const ECC = Math.sqrt(F * (2 - F));
const RECTIFYING_RADIUS = (A / (1 + N)) * (1 + N2 / 4 + N4 / 64 + N6 / 256);

const BETA = [
	N / 2 - (2 * N2) / 3 + (37 * N3) / 96 - N4 / 360 - (81 * N5) / 512 + (96199 * N6) / 604800,
	N2 / 48 + N3 / 15 - (437 * N4) / 1440 + (46 * N5) / 105 - (1118711 * N6) / 3870720,
	(17 * N3) / 480 - (37 * N4) / 840 - (209 * N5) / 4480 + (5569 * N6) / 90720,
	(4397 * N4) / 161280 - (11 * N5) / 504 - (830251 * N6) / 7257600,
	(4583 * N5) / 161280 - (108847 * N6) / 3991680,
	(20648693 * N6) / 638668800,
];

/** The zone whose central meridian is nearest `lon` (degrees). */
export function utmZoneOf(lon: number): number {
	return Math.floor((lon + 180) / 6) + 1;
}

/** [lat, lon] in degrees of a point in UTM `zone`, northern hemisphere. */
export function utmToLatLon(easting: number, northing: number, zone: number): [number, number] {
	const xi = northing / (K0 * RECTIFYING_RADIUS);
	const eta = (easting - FALSE_EASTING) / (K0 * RECTIFYING_RADIUS);

	let xiPrime = xi;
	let etaPrime = eta;
	BETA.forEach((beta, index) => {
		const j = 2 * (index + 1);
		xiPrime -= beta * Math.sin(j * xi) * Math.cosh(j * eta);
		etaPrime -= beta * Math.cos(j * xi) * Math.sinh(j * eta);
	});

	const sinhEta = Math.sinh(etaPrime);
	const cosXi = Math.cos(xiPrime);
	const tauPrime = Math.sin(xiPrime) / Math.sqrt(sinhEta * sinhEta + cosXi * cosXi);

	// τ from τ′ (conformal → geodetic latitude), Newton to convergence
	let tau = tauPrime;
	for (let step = 0; step < 10; step++) {
		const sigma = Math.sinh(ECC * Math.atanh((ECC * tau) / Math.sqrt(1 + tau * tau)));
		const tauI = tau * Math.sqrt(1 + sigma * sigma) - sigma * Math.sqrt(1 + tau * tau);
		const delta =
			((tauPrime - tauI) / Math.sqrt(1 + tauI * tauI)) *
			((1 + (1 - ECC * ECC) * tau * tau) / ((1 - ECC * ECC) * Math.sqrt(1 + tau * tau)));
		tau += delta;
		if (Math.abs(delta) < 1e-14) break;
	}

	const centralMeridian = (zone - 1) * 6 - 180 + 3;
	const lat = (Math.atan(tau) * 180) / Math.PI;
	const lon = centralMeridian + (Math.atan2(sinhEta, cosXi) * 180) / Math.PI;
	return [lat, lon];
}
