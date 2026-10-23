/** Maps: places, directions, map images and leave-by times (docs/DESIGN.md, Maps). */
export * from './types';
export { MapsService, MAPS_KEY, MAPS_KEY_ENV, DEFAULT_CAP, looksLikeGoogleId, type MapsHost, type MapsAnswer, type SearchInput, type DirectionsInput, type MapImageInput } from './service';
export { GoogleProvider, googleError, SEARCH_MASK, DETAILS_MASK, ROUTE_MASK, PLACE_FIELDS, API_NAMES, GOOGLE_HOSTS } from './google';
export { OsmProvider, OSM_DEFAULTS, OSM_ATTRIBUTION, osmId } from './osm';
export { TtlCache, DailyCap, Gate } from './limits';
export { decodePolyline, encodePolyline, metersBetween, parseLatLng, placeLink, directionsLink, worldPx, fitZoom } from './geo';
export { NO_CALENDAR, travelEvents, isOnline, type CalendarPort, type CalendarEventLike } from './leave-by';
export { attachMaps, mapsOf, setCalendarPort, calendarPortOf } from './registry';
export { durationWords, distanceWords, MODE_WORDS, MODE_BY, LINK_WORDS, priceMarks } from './words';
