/**
 * Drizzle relational-query metadata (no database objects). Only the
 * relations the app is expected to traverse with `db.query.*` are declared.
 */
import { relations } from "drizzle-orm";
import { refreshTokens, sessions, users } from "./auth.js";
import { announcements, cuencadaItineraryItems, cuencadaLocations, cuencadas, dailyMessages } from "./cuencadas.js";
import { people } from "./people.js";
import { profiles } from "./profiles.js";
import { cuencadaRsvps } from "./rsvp.js";

export const usersRelations = relations(users, ({ one, many }) => ({
  profile: one(profiles, { fields: [users.id], references: [profiles.userId] }),
  person: one(people, { fields: [users.id], references: [people.userId] }),
  sessions: many(sessions),
  rsvps: many(cuencadaRsvps)
}));

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
  refreshTokens: many(refreshTokens)
}));

export const refreshTokensRelations = relations(refreshTokens, ({ one }) => ({
  session: one(sessions, { fields: [refreshTokens.sessionId], references: [sessions.id] })
}));

export const cuencadasRelations = relations(cuencadas, ({ many }) => ({
  itinerary: many(cuencadaItineraryItems),
  locations: many(cuencadaLocations),
  dailyMessages: many(dailyMessages),
  announcements: many(announcements),
  rsvps: many(cuencadaRsvps)
}));

export const cuencadaItineraryItemsRelations = relations(cuencadaItineraryItems, ({ one }) => ({
  cuencada: one(cuencadas, { fields: [cuencadaItineraryItems.cuencadaId], references: [cuencadas.id] }),
  location: one(cuencadaLocations, {
    fields: [cuencadaItineraryItems.locationId],
    references: [cuencadaLocations.id]
  })
}));

export const cuencadaLocationsRelations = relations(cuencadaLocations, ({ one }) => ({
  cuencada: one(cuencadas, { fields: [cuencadaLocations.cuencadaId], references: [cuencadas.id] })
}));

export const dailyMessagesRelations = relations(dailyMessages, ({ one }) => ({
  cuencada: one(cuencadas, { fields: [dailyMessages.cuencadaId], references: [cuencadas.id] })
}));

export const announcementsRelations = relations(announcements, ({ one }) => ({
  cuencada: one(cuencadas, { fields: [announcements.cuencadaId], references: [cuencadas.id] })
}));

export const cuencadaRsvpsRelations = relations(cuencadaRsvps, ({ one }) => ({
  cuencada: one(cuencadas, { fields: [cuencadaRsvps.cuencadaId], references: [cuencadas.id] }),
  user: one(users, { fields: [cuencadaRsvps.userId], references: [users.id] })
}));
