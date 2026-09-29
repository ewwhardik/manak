/**
 * Event announcements repository.
 *
 * Stores event announcements and pinned broadcasts with append-only audit tracking.
 * Adheres strictly to repository invariants: strict SQLite, audit gate on every mutation.
 */

import type { Ctx } from "../context.ts";
import { RuleError } from "../context.ts";
import type { Db } from "../open.ts";

export type AnnouncementRow = {
  readonly id: string;
  readonly event_id: string;
  readonly author_id: string;
  readonly title: string;
  readonly content: string;
  readonly pinned: number;
  readonly created_at: number;
  readonly updated_at: number;
};

export function createAnnouncement(
  ctx: Ctx,
  params: {
    readonly eventId: string;
    readonly authorId: string;
    readonly title: string;
    readonly content: string;
    readonly pinned?: boolean;
  },
): AnnouncementRow {
  const title = params.title.trim();
  const content = params.content.trim();
  if (!title || title.length > 200) {
    throw new RuleError("announcement.title", "Title must be between 1 and 200 characters.");
  }
  if (!content || content.length > 10000) {
    throw new RuleError("announcement.content", "Content must be between 1 and 10,000 characters.");
  }

  const id = ctx.newId();
  const now = ctx.now();
  const pinned = params.pinned ? 1 : 0;

  ctx.recorded(
    {
      action: "announcement.created",
      eventId: params.eventId,
      subject: id,
      payload: { title, pinned },
    },
    () => {
      ctx.write(
        `insert into event_announcement (id, event_id, author_id, title, content, pinned, created_at, updated_at)
         values (:id, :eventId, :authorId, :title, :content, :pinned, :now, :now)`,
        {
          id,
          eventId: params.eventId,
          authorId: params.authorId,
          title,
          content,
          pinned,
          now,
        },
      );
    },
  );

  return {
    id,
    event_id: params.eventId,
    author_id: params.authorId,
    title,
    content,
    pinned,
    created_at: now,
    updated_at: now,
  };
}

export function listAnnouncements(
  db: Db,
  eventId: string,
): readonly AnnouncementRow[] {
  return db.all<AnnouncementRow>(
    `select id, event_id, author_id, title, content, pinned, created_at, updated_at
     from event_announcement
     where event_id = :e
     order by pinned desc, created_at desc`,
    { e: eventId },
  );
}

export function findAnnouncement(
  db: Db,
  eventId: string,
  announcementId: string,
): AnnouncementRow | null {
  return (
    db.get<AnnouncementRow>(
      `select id, event_id, author_id, title, content, pinned, created_at, updated_at
       from event_announcement
       where event_id = :e and id = :id`,
      { e: eventId, id: announcementId },
    ) ?? null
  );
}

export function deleteAnnouncement(
  ctx: Ctx,
  eventId: string,
  announcementId: string,
): void {
  const existing = findAnnouncement(ctx.db, eventId, announcementId);
  if (!existing) {
    throw new RuleError("announcement.missing", "Announcement not found.");
  }

  ctx.recorded(
    {
      action: "announcement.deleted",
      eventId,
      subject: announcementId,
      payload: { title: existing.title },
    },
    () => {
      ctx.write(
        `delete from event_announcement where event_id = :e and id = :id`,
        { e: eventId, id: announcementId },
      );
    },
  );
}
