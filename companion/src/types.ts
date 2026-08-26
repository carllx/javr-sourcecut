/**
 * Eporner Browser Companion Types & Domain Model
 */

export type ProbeStatus =
  | "pending"
  | "probing"
  | "detected"
  | "no_av1"
  | "unknown"
  | "error";

export interface RenditionProfile {
  videoId: string;
  sourceUrl: string;
  maxResolution: string; // e.g. "4K", "2160p", "1080p", "unknown"
  av1Resolutions: string[]; // e.g. ["2160p", "1080p"]
  highestAv1Resolution: string | null; // e.g. "2160p", "1080p", or null
  has4kAv1: boolean;
  probeStatus: ProbeStatus;
  error?: string;
  updatedAt?: number;
}

export interface CandidateCard {
  videoId: string;
  url: string;
  element: HTMLElement;
  advertisedResolution: string; // e.g. "4K 2160p", "4K", "1080p"
  is4kPlus: boolean;
  badgeContainer?: HTMLElement;
  profile?: RenditionProfile;
}

export interface FilterStats {
  totalCards: number;
  total4kPlus: number;
  confirmedAv1: number;
  confirmed4kAv1: number;
  confirmedNoAv1: number;
  probing: number;
  errorCount: number;
}

export interface StorageAdapter {
  get<T>(key: string, defaultValue: T): Promise<T> | T;
  set<T>(key: string, value: T): Promise<void> | void;
  delete?(key: string): Promise<void> | void;
}

export interface Requester {
  fetchText(url: string): Promise<string>;
}
