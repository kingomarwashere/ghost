export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  PHOTOS: R2Bucket;
  ADMIN_KEY: string;
  TFNSW_API_KEY?: string;
  OPENWEB_NINJA_KEY: string;
  MAPILLARY_TOKEN?: string;
  NSW_FUELCHECK_KEY?: string;
  NSW_FUELCHECK_SECRET?: string;
  GOOGLE_MAPS_KEY?: string;
  GHOST_UPLOAD_PASS?: string; // shared password for /api/custom-cars uploads (default 'lickmyghost')
  VALHALLA_SECRET?: string;   // X-Ghost-Secret for the self-hosted Valhalla gateway (ghost-valhalla.theradicalparty.com)
  TOMTOM_API_KEY?: string;    // TomTom Traffic Flow tiles — proxied server-side so the key never ships to the browser
}

export interface User {
  id: string;
  username: string;
  email: string;
  score: number;
  created_at: number;
  last_seen: number | null;
}

export interface Report {
  id: string;
  lat: number;
  lng: number;
  type: 'police' | 'speed_trap' | 'accident' | 'hazard';
  description?: string;
  confirms: number;
  denies: number;
  created_at: number;
  expires_at: number;
}

export interface Camera {
  id: string;
  lat: number;
  lng: number;
  type: 'speed' | 'red_light' | 'average_speed' | 'mobile';
  source: 'osm' | 'gov';
  description?: string;
  state?: string;
  road?: string;
  speed_limit?: number;
  external_id?: string;
  direction?: number | null;
}
