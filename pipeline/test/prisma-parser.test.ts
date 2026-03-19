import { describe, it, expect } from "vitest";
import { parsePrismaSchema } from "../src/lib/prisma-parser.js";

describe("parsePrismaSchema", () => {
  it("extracts column mappings from @map annotations", () => {
    const schema = `
model OrganizationBilling {
  organizationId   String @id @map("organization_id")
  stripeCustomerId String? @map("stripe_customer_id")
  limits           Json   @default("{}")
  stripe           Json   @default("{}")
  createdAt        DateTime @default(now()) @map("created_at")
  updatedAt        DateTime @updatedAt @map("updated_at")

  @@map("OrganizationBilling")
}`;
    const result = parsePrismaSchema(schema);
    expect(result.OrganizationBilling).toBeDefined();
    expect(result.OrganizationBilling.columns.stripeCustomerId).toBe("stripe_customer_id");
    expect(result.OrganizationBilling.columns.organizationId).toBe("organization_id");
    expect(result.OrganizationBilling.columns.limits).toBe("limits");
    expect(result.OrganizationBilling.columns.stripe).toBe("stripe");
    expect(result.OrganizationBilling.columns.createdAt).toBe("created_at");
  });

  it("uses model name as table name when no @@map", () => {
    const schema = `
model User {
  id    String @id @default(cuid())
  name  String
  email String @unique
}`;
    const result = parsePrismaSchema(schema);
    expect(result.User.table_name).toBe("User");
    expect(result.User.columns.id).toBe("id");
    expect(result.User.columns.name).toBe("name");
  });

  it("uses @@map value as table name", () => {
    const schema = `
model ApiKey {
  id        String @id
  label     String
  createdAt DateTime @default(now()) @map("created_at")

  @@map("api_keys")
}`;
    const result = parsePrismaSchema(schema);
    expect(result.ApiKey.table_name).toBe("api_keys");
  });

  it("handles multiple models", () => {
    const schema = `
model User {
  id   String @id
  name String
}

model Organization {
  id   String @id
  name String
  isAIEnabled Boolean @default(false) @map("is_ai_enabled")
}`;
    const result = parsePrismaSchema(schema);
    expect(Object.keys(result)).toHaveLength(2);
    expect(result.User.columns.id).toBe("id");
    expect(result.Organization.columns.isAIEnabled).toBe("is_ai_enabled");
  });

  it("skips relation fields (no scalar type)", () => {
    const schema = `
model User {
  id           String        @id
  name         String
  memberships  Membership[]
  organization Organization? @relation(fields: [orgId], references: [id])
  orgId        String?       @map("org_id")
}`;
    const result = parsePrismaSchema(schema);
    expect(result.User.columns.id).toBe("id");
    expect(result.User.columns.name).toBe("name");
    expect(result.User.columns.orgId).toBe("org_id");
    // Relation fields should NOT appear as columns
    expect(result.User.columns.memberships).toBeUndefined();
    expect(result.User.columns.organization).toBeUndefined();
  });

  it("handles empty schema", () => {
    const result = parsePrismaSchema("");
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("handles schema with only enums and datasource", () => {
    const schema = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Role {
  owner
  admin
  member
}`;
    const result = parsePrismaSchema(schema);
    expect(Object.keys(result)).toHaveLength(0);
  });
});
