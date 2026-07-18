// Hand-written fixture matching the triptych contract data shapes. Used ONLY as a
// dev-only fallback (import.meta.env.DEV) when the real analysis/PR artifacts 404 —
// lets the Data tab render before the pipeline lands. Surfaced in the UI via a
// "FIXTURE" chip so it's never mistaken for real analysis output.
import type { DataArtifact, DataOverlay } from "../lib/api";

export const dataFixture: DataArtifact = {
  schemaVersion: 1,
  status: "ok",
  sources: ["src/types/database.ts", "src/types/mood.ts"],
  entities: [
    {
      id: "Family",
      name: "Family",
      kind: "object",
      provenance: "generated-db",
      definedIn: "src/types/database.ts",
      fields: [
        { name: "id", type: "string", optional: false },
        { name: "name", type: "string", optional: false },
        { name: "owner_id", type: "string", optional: false },
        { name: "created_at", type: "string", optional: false },
      ],
      pos: { x: 40, y: 40, w: 220, h: 150 },
    },
    {
      id: "FamilyMember",
      name: "FamilyMember",
      kind: "object",
      provenance: "generated-db",
      definedIn: "src/types/database.ts",
      fields: [
        { name: "id", type: "string", optional: false },
        { name: "family_id", type: "string", optional: false },
        { name: "user_id", type: "string", optional: false },
        { name: "role", type: "'owner' | 'member'", optional: false },
        { name: "mood", type: "MoodEmoji", optional: true },
      ],
      pos: { x: 340, y: 40, w: 220, h: 172 },
    },
    {
      id: "MoodEmoji",
      name: "MoodEmoji",
      kind: "enum",
      provenance: "app-type",
      definedIn: "src/types/mood.ts",
      fields: [],
      values: ["happy", "neutral", "sad", "excited"],
      pos: { x: 640, y: 40, w: 220, h: 120 },
    },
    {
      id: "Profile",
      name: "Profile",
      kind: "object",
      provenance: "generated-db",
      definedIn: "src/types/database.ts",
      fields: [
        { name: "id", type: "string", optional: false },
        { name: "display_name", type: "string", optional: false },
        { name: "avatar_url", type: "string | null", optional: true },
        { name: "bio", type: "string | null", optional: true },
      ],
      pos: { x: 40, y: 320, w: 220, h: 150 },
    },
    {
      id: "Invite",
      name: "Invite",
      kind: "object",
      provenance: "generated-db",
      definedIn: "src/types/database.ts",
      fields: [
        { name: "id", type: "string", optional: false },
        { name: "family_id", type: "string", optional: false },
        { name: "email", type: "string", optional: false },
        { name: "status", type: "string", optional: false },
      ],
      pos: { x: 340, y: 320, w: 220, h: 150 },
    },
    {
      id: "MoodEntry",
      name: "MoodEntry",
      kind: "object",
      provenance: "app-type",
      definedIn: "src/types/mood.ts",
      fields: [
        { name: "id", type: "string", optional: false },
        { name: "member_id", type: "string", optional: false },
        { name: "emoji", type: "MoodEmoji", optional: false },
        { name: "note", type: "string | null", optional: true },
        { name: "logged_at", type: "string", optional: false },
      ],
      pos: { x: 640, y: 320, w: 220, h: 172 },
    },
  ],
  edges: [
    { source: "FamilyMember", target: "Family", label: "references" },
    { source: "FamilyMember", target: "MoodEmoji", label: "references" },
    { source: "Invite", target: "Family", label: "references" },
    { source: "MoodEntry", target: "FamilyMember", label: "references" },
    { source: "MoodEntry", target: "MoodEmoji", label: "references" },
  ],
  consumers: {
    "src/types/database.ts": ["src/lib/family-data.ts", "src/lib/profile.ts", "src/hooks/useFamily.ts"],
    "src/types/mood.ts": ["src/lib/mood-log.ts", "src/components/MoodPicker.tsx"],
  },
};

export const dataOverlayFixture: DataOverlay = {
  status: "ok",
  entities: {
    Family: {
      status: "modified",
      fields: {
        activity_insights_enabled: { status: "added", type: "boolean | null", prevType: null },
      },
    },
    Profile: {
      status: "modified",
      fields: {
        bio: { status: "removed", type: null, prevType: "string | null" },
      },
    },
    FamilyMember: {
      status: "modified",
      fields: {
        role: {
          status: "changed",
          type: "'owner' | 'member' | 'guest'",
          prevType: "'owner' | 'member'",
        },
      },
    },
    MoodEmoji: {
      status: "modified",
      valuesAdded: ["anxious"],
      valuesRemoved: [],
    },
  },
  addedEntities: [
    {
      id: "ActivityInsight",
      name: "ActivityInsight",
      kind: "object",
      provenance: "generated-db",
      definedIn: "src/types/database.ts",
      fields: [
        { name: "id", type: "string", optional: false },
        { name: "family_id", type: "string", optional: false },
        { name: "metric", type: "string", optional: false },
        { name: "value", type: "number", optional: false },
        { name: "computed_at", type: "string", optional: false },
      ],
      pos: { x: 0, y: 0, w: 220, h: 172 },
    },
  ],
  migrationOps: [
    {
      file: "supabase/migrations/006_activity_insights.sql",
      op: "ALTER TABLE families ADD COLUMN activity_insights_enabled boolean",
      table: "families",
      analyzed: true,
    },
    {
      file: "supabase/migrations/006_activity_insights.sql",
      op: "CREATE TABLE activity_insights (id uuid PRIMARY KEY, family_id uuid, metric text, value numeric, computed_at timestamptz)",
      table: "activity_insights",
      analyzed: true,
    },
    {
      file: "supabase/migrations/007_backfill.sql",
      op: "DO $$ BEGIN /* procedural backfill */ END $$;",
      analyzed: false,
    },
  ],
};
