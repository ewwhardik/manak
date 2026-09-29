/**
 * Event announcements and organizer broadcasts.
 *
 * Provides event organizers with tools to publish time-sensitive bulletins,
 * pinned alerts, schedule shifts, and deadline updates directly to participants.
 */

import { defineCommand } from "../registry.ts";
import type { Command } from "../registry.ts";
import { EVENT_REF } from "./events.ts";
import {
  createAnnouncement,
  deleteAnnouncement,
  listAnnouncements,
} from "../../db/index.ts";
import type { EventRow } from "../../db/index.ts";

export const announcementCreate = defineCommand({
  name: "announcements.create",
  summary: "Publish a new announcement or pinned alert card for an event.",
  method: "POST",
  path: "/api/events/:event/announcements",
  capability: { audience: "organizer", scope: "event" },
  input: {
    event: EVENT_REF,
    title: { kind: "text", label: "Title", help: "Broadcast title (1-200 characters)." },
    content: { kind: "text", label: "Content", help: "Announcement message or instructions." },
    pinned: { kind: "bool", optional: true, label: "Pin to top", help: "Display as high-priority alert card." },
  },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        announcement: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            content: { type: "string" },
            pinned: { type: "boolean" },
            createdAt: { type: "integer" },
          },
          required: ["id", "title", "content", "pinned", "createdAt"],
        },
      },
      required: ["announcement"],
    },
  },
  limit: "organize",
  records: ["announcement.created"],
  form: {
    title: "Post Announcement",
    submit: "Broadcast",
    redirect: ({ input }) => `/events/${encodeURIComponent(String(input.event))}`,
  },
  handler: ({ ctx, event, input, accountId }) => {
    const row = event as EventRow;
    const authorId = accountId ?? ctx.actorId ?? "system";
    const created = createAnnouncement(ctx, {
      eventId: row.id,
      authorId,
      title: String(input.title ?? ""),
      content: String(input.content ?? ""),
      pinned: input.pinned === true || input.pinned === "true",
    });
    return {
      announcement: {
        id: created.id,
        title: created.title,
        content: created.content,
        pinned: created.pinned === 1,
        createdAt: created.created_at,
      },
    };
  },
});

export const announcementList = defineCommand({
  name: "announcements.list",
  summary: "List announcements and alerts for an event, ordered with pinned alerts first.",
  method: "GET",
  path: "/api/events/:event/announcements",
  capability: { audience: "public", scope: "event" },
  input: { event: EVENT_REF },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        announcements: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              content: { type: "string" },
              pinned: { type: "boolean" },
              createdAt: { type: "integer" },
            },
            required: ["id", "title", "content", "pinned", "createdAt"],
          },
        },
      },
      required: ["announcements"],
    },
  },
  handler: ({ ctx, event }) => {
    const row = event as EventRow;
    const list = listAnnouncements(ctx.db, row.id);
    return {
      announcements: list.map((a) => ({
        id: a.id,
        title: a.title,
        content: a.content,
        pinned: a.pinned === 1,
        createdAt: a.created_at,
      })),
    };
  },
});

export const announcementDelete = defineCommand({
  name: "announcements.delete",
  summary: "Delete an announcement from an event.",
  method: "POST",
  path: "/api/events/:event/announcements/:announcement/delete",
  capability: { audience: "organizer", scope: "event" },
  input: {
    event: EVENT_REF,
    announcement: { kind: "id", label: "Announcement ID" },
  },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
      },
      required: ["ok"],
    },
  },
  limit: "organize",
  records: ["announcement.deleted"],
  form: {
    title: "Delete Announcement",
    submit: "Delete",
    redirect: ({ input }) => `/events/${encodeURIComponent(String(input.event))}`,
  },
  handler: ({ ctx, event, input }) => {
    const row = event as EventRow;
    deleteAnnouncement(ctx, row.id, String(input.announcement));
    return { ok: true };
  },
});

export const ANNOUNCEMENT_COMMANDS: readonly Command[] = [
  announcementList,
  announcementCreate,
  announcementDelete,
];
