import argon2 from "argon2";
import { eq } from "drizzle-orm";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db/client.js";
import { profiles, users } from "./db/schema.js";

const config = loadConfig();
const db = createDatabase(config);
const email = config.SEED_ADMIN_EMAIL.toLowerCase();

const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);

if (!existing) {
  const passwordHash = await argon2.hash(config.SEED_ADMIN_TEMP_PASSWORD);
  const [admin] = await db.insert(users).values({
    email,
    displayName: "Administrador Cuencada",
    passwordHash,
    role: "admin",
    status: "active",
    mustChangePassword: true
  }).returning();

  if (admin) {
    await db.insert(profiles).values({ userId: admin.id, fullName: admin.displayName, city: "México" });
  }
}
