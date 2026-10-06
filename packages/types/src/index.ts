export const UserRole = {
  Admin: "admin",
  Member: "member"
} as const;

export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const CuencadaStatus = {
  Past: "past",
  Upcoming: "upcoming",
  Active: "active",
  Draft: "draft"
} as const;

export type CuencadaStatus = (typeof CuencadaStatus)[keyof typeof CuencadaStatus];

export const RsvpStatus = {
  Yes: "yes",
  Maybe: "maybe",
  No: "no"
} as const;

export type RsvpStatus = (typeof RsvpStatus)[keyof typeof RsvpStatus];

export interface PublicCuencada {
  id: string;
  year: number;
  slug: string;
  title: string;
  status: CuencadaStatus;
  startsAt: string;
  endsAt: string;
  city: string;
  state: string;
  country: string;
  description: string;
  heroImageUrl: string | null;
  themeColor: string;
  publicItinerary: ItineraryItem[];
  publicLocations: LocationItem[];
}

export interface ItineraryItem {
  id: string;
  date: string;
  time: string | null;
  title: string;
  description: string;
  locationName: string | null;
  visibility: "public" | "members";
}

export interface LocationItem {
  id: string;
  name: string;
  kind: "hotel" | "venue" | "map" | "other";
  address: string | null;
  url: string | null;
}

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  mustChangePassword: boolean;
}
