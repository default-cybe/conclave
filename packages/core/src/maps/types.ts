/**
 * Maps for the assistant (docs/DESIGN.md, Maps): places, directions and
 * travel time, and map images, from Google Maps Platform or OpenStreetMap.
 * Types only, shared by the hub, its routes and the clients.
 */

export type TravelMode = 'walk' | 'transit' | 'drive' | 'bicycle';
export const TRAVEL_MODES: TravelMode[] = ['walk', 'transit', 'drive', 'bicycle'];

/** google needs a key and billing; osm needs neither. */
export type MapsProviderId = 'google' | 'osm';

/** Where card links open. Both work by coordinates. */
export type MapsLinkApp = 'google' | 'apple';

/** Every outbound call kind, for the daily count. */
export type MapsApi = 'places' | 'routes' | 'geocode' | 'timezone' | 'staticmap' | 'nominatim' | 'osrm' | 'tiles';

export interface LatLng {
  lat: number;
  lng: number;
}

/** A place as the cards show it. Fields a provider does not have are left out. */
export interface PlaceCard {
  /** Google place id, or "osm:N123" for an OpenStreetMap node, way (W) or relation (R). */
  id: string;
  name: string;
  address?: string;
  lat: number;
  lng: number;
  /** 1 to 5. Google only. */
  rating?: number;
  /** How many ratings. Google only. */
  ratings?: number;
  /** Google only: OpenStreetMap hours are often out of date, so cards leave them out. */
  openNow?: boolean;
  /** 0 (free) to 4 (very expensive). Google only. */
  price?: number;
  /** Opens the place in the owner's maps app. */
  mapsUrl: string;
  /** Directions to the place in the owner's maps app. */
  directionsUrl: string;
  /** Metres from where the search was centred. */
  distanceMeters?: number;
}

export interface RouteEnd {
  label: string;
  lat: number;
  lng: number;
}

export interface RouteCard {
  /** Pass to MapImage as route to draw it. */
  id: string;
  from: RouteEnd;
  to: RouteEnd;
  /** The mode the times are for. */
  mode: TravelMode;
  /** The mode asked for, when the provider could not do it (transit on OpenStreetMap). */
  asked?: TravelMode;
  durationSec: number;
  /** Time traffic adds to a drive. Google only. */
  trafficSec?: number;
  distanceMeters: number;
  /** Epoch ms. */
  departAt: number;
  arriveAt: number;
  /** Set when an arrival time was asked for: depart by then. */
  leaveBy?: number;
  /** "17:40" in the owner's timezone. */
  departText: string;
  arriveText: string;
  leaveByText?: string;
  /** The arrival in the destination's own timezone, when it differs ("14:05 Europe/London"). */
  arriveLocal?: string;
  /** The owner's timezone the texts are in. */
  zone: string;
  /** "via A100", or the lines of a transit trip ("U2, S41"). */
  summary?: string;
  /** One plain line on what the times leave out. */
  note?: string;
  directionsUrl: string;
}

export interface MapImageCard {
  id: string;
  width: number;
  height: number;
  alt: string;
}

/** What a maps tool result carries for the clients (ToolResultMeta.maps). Never a key or a provider URL with one. */
export type MapsCardData =
  | { kind: 'places'; provider: MapsProviderId; links: MapsLinkApp; places: PlaceCard[]; attribution?: string }
  | { kind: 'route'; provider: MapsProviderId; links: MapsLinkApp; route: RouteCard; attribution?: string }
  | { kind: 'map'; provider: MapsProviderId; image: MapImageCard; attribution?: string };

/** A place with what details add. */
export interface PlaceDetails extends PlaceCard {
  /** "Monday: 08:00 to 18:00" lines. Google: current hours; OpenStreetMap: the raw opening_hours tag, as text only. */
  hours?: string[];
  website?: string;
}

export interface RouteResult {
  durationSec: number;
  staticDurationSec?: number;
  distanceMeters: number;
  /** Encoded polyline, precision 5. */
  polyline?: string;
  summary?: string;
  start?: LatLng;
  end?: LatLng;
}

/** One marker on a map image. */
export interface MapMarker {
  lat: number;
  lng: number;
  /** One letter or digit. */
  label?: string;
}

/** What a map image draws. Kept on the hub; the image route builds the provider call from it when a client asks. */
export interface MapImageSpec {
  provider: MapsProviderId;
  width: number;
  height: number;
  markers: MapMarker[];
  /** Encoded polyline of a route, precision 5. */
  path?: string;
  zoom?: number;
  alt: string;
}

export interface MapsHome {
  address: string;
  lat: number;
  lng: number;
  /** The home's timezone, from the Time Zone API when Google is the provider. */
  zone?: string;
}

/** Settings > Maps. The key itself never leaves the hub; keySet says whether there is one. */
export interface MapsSettingsDto {
  /** The provider in use. */
  provider: MapsProviderId;
  /** The provider set in Settings; undefined means Google with a key, else OpenStreetMap. */
  chosen?: MapsProviderId;
  google: { keySet: boolean; keyFrom?: 'hub' | 'env' };
  osm: {
    email?: string;
    nominatimUrl: string;
    osrmUrl: string;
    tileUrl: string;
    /** The public OpenStreetMap servers are in use: light use only. */
    publicServers: boolean;
  };
  home?: MapsHome;
  mode: TravelMode;
  links: MapsLinkApp;
  dailyCap: number;
  today: { date: string; calls: number; byApi: Partial<Record<MapsApi, number>> };
}

export interface MapsSettingsPatch {
  provider?: MapsProviderId | null;
  /** An address or "lat,lng". null clears it. */
  home?: string | null;
  mode?: TravelMode;
  links?: MapsLinkApp;
  dailyCap?: number;
  osm?: { email?: string | null; nominatimUrl?: string | null; osrmUrl?: string | null; tileUrl?: string | null };
}

/** One check of the Test button. */
export interface MapsTestStep {
  api: MapsApi;
  /** "Places API (New)". */
  name: string;
  ok: boolean;
  /** Plain words: what came back, or what to fix. */
  message: string;
}

export interface MapsTestResult {
  provider: MapsProviderId;
  ok: boolean;
  steps: MapsTestStep[];
}

/** A calendar event with a place, for leave-by times. */
export interface LeaveByItem {
  title: string;
  /** Epoch ms. */
  start: number;
  startText: string;
  location: string;
  mode: TravelMode;
  durationSec?: number;
  leaveBy?: number;
  /** "17:40". */
  leaveByText?: string;
  /** Why there is no time: the place was not found, the cap, no route. */
  error?: string;
}

export interface LeaveByDto {
  date: string;
  zone: string;
  /** Empty when there is no calendar, no event with a place, or no home. */
  items: LeaveByItem[];
  /** Why there are no items when events with places exist: "Set your home in Settings, Maps." */
  reason?: string;
}

/** Plain-words failure. `code` lets the clients and tests tell them apart. */
export type MapsErrorCode = 'no_key' | 'billing' | 'restricted' | 'disabled' | 'bad_key' | 'quota' | 'cap' | 'not_found' | 'no_route' | 'bad_input' | 'network' | 'refused' | 'error';

export class MapsError extends Error {
  constructor(
    readonly code: MapsErrorCode,
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}
