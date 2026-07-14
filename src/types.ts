export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_KEY: string;
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
