/**
 * Shared projects between friends (docs/design/FRIENDS.md, "Shared projects
 * as built"). A project's name, its GitHub repository, notes, the memories
 * the owner picks and the chats each member chooses, kept in step hub to hub
 * through the peer outbox as signed, sealed messages. Each hub keeps its own
 * copy. Each item has one author, and only its author edits or deletes it.
 * Code never goes hub to hub: it syncs through GitHub.
 *
 * Server: packages/server/src/peer/projects.ts. Only type declarations live
 * here (see client/index.ts).
 */
import type { ShareSummary } from './friends';

export type SharedProjectRole = 'owner' | 'member';

/** A member as the owner's hub lists them. invited: asked, no answer yet; removed: by the owner. */
export type SharedMemberState = 'invited' | 'active' | 'declined' | 'left' | 'removed';

/**
 * The project on this hub. invited: an invite waits in the Inbox; active;
 * declined; left: this hub left it (a read only copy stays); removed: the
 * owner took this hub out (a read only copy stays); ended: the owner ended it.
 */
export type SharedProjectState = 'invited' | 'active' | 'declined' | 'left' | 'removed' | 'ended';

/** note: text a member wrote; memory: a memory its author picked; chat: a chat or session shared through the project. */
export type SharedItemKind = 'note' | 'memory' | 'chat';

export interface SharedMemberDto {
  /** The member's hub key fingerprint: their identity. */
  fingerprint: string;
  name: string;
  role: SharedProjectRole;
  state: SharedMemberState;
  /** This hub. */
  you: boolean;
  /** Their friend id here, when they are a friend of this hub. */
  friendId?: string;
  /** Their GitHub login, when their hub shares it: their branches and pull requests. */
  github?: string;
}

export interface SharedItemDto {
  id: string;
  kind: SharedItemKind;
  /** The author's hub fingerprint. */
  author: string;
  authorName: string;
  /** Written on this hub: only then can it be edited or deleted here. */
  mine: boolean;
  version: number;
  title?: string;
  /** The text of a note or memory, secrets taken out. Empty for a chat. */
  text: string;
  /**
   * A chat or session, shared with the members through a share (phases 2
   * and 3). receivedId: the share on this hub, when it came here; sessionId:
   * the session it was sent from, on the author's hub.
   */
  chat?: { shareId: string; kind: 'chat' | 'session'; summary: ShareSummary; receivedId?: string; sessionId?: string };
  /** Deleted by its author: the history stays. */
  deleted?: boolean;
  /** The author's clock. */
  createdAt: number;
  updatedAt: number;
  /** When this hub got this version. */
  receivedAt: number;
  /** From another member, after the project's read mark. */
  unread: boolean;
}

export interface SharedProjectDto {
  /** The same id on every member's hub (a ULID the owner's hub made). */
  id: string;
  name: string;
  description?: string;
  /** owner/name on GitHub. Code syncs there, never hub to hub. */
  repo?: string;
  /** This hub's role. */
  role: SharedProjectRole;
  state: SharedProjectState;
  owner: { fingerprint: string; name: string; you: boolean; friendId?: string };
  members: SharedMemberDto[];
  counts: { notes: number; memories: number; chats: number };
  /** Items from others not read yet; a waiting invite counts one. */
  unread: number;
  /** One line for lists and the Inbox. */
  line: string;
  /** A project of this hub (folders across devices) it is linked to. */
  localProjectId?: string;
  /** Share this hub's new sessions in the project with the members. Off by default. */
  shareNewSessions: boolean;
  createdAt: number;
  updatedAt: number;
  /** The read mark (this hub's clock). */
  readAt?: number;
}

/** GET /api/shared-projects/:id: the project with its items, newest first. */
export interface SharedProjectView extends SharedProjectDto {
  items: SharedItemDto[];
}

/** POST /api/shared-projects. */
export interface CreateSharedProjectInput {
  name: string;
  description?: string;
  /** owner/name on GitHub. */
  repo?: string;
  /** A project of this hub to link (Group by Project, Devices, Folders). */
  localProjectId?: string;
  /** Friend ids or fingerprints to invite. */
  members?: string[];
  /** The first note: the project doc. */
  notes?: string;
  /** Memories to share, picked one by one. None by default. */
  memoryIds?: string[];
  /** Chats and sessions to share with the members. */
  sessionIds?: string[];
  shareNewSessions?: boolean;
}

/** PATCH /api/shared-projects/:id. name, description and repo: the owner only. */
export interface UpdateSharedProjectInput {
  name?: string;
  description?: string;
  repo?: string | null;
  localProjectId?: string | null;
  shareNewSessions?: boolean;
}

export interface SharedNoteInput {
  title?: string;
  text: string;
}

/** A note, memory or chat written here. redacted: secrets taken out before it left the hub. */
export interface SharedWriteResult {
  item: SharedItemDto;
  redacted: number;
}

/** A memory that could be shared: the project's own memories on this hub. */
export interface SharedMemoryCandidate {
  id: string;
  content: string;
  kind: string;
  scopeKey?: string;
  /** Shared in this project already. */
  shared: boolean;
}

/** One version of an item. Every edit keeps the one before. */
export interface SharedItemVersionDto {
  version: number;
  title?: string;
  text: string;
  deleted?: boolean;
  updatedAt: number;
  receivedAt: number;
}

export interface SharedPullDto {
  number: number;
  title: string;
  url: string;
  /** The GitHub login that opened it. */
  author: string;
  branch: string;
  draft: boolean;
  updatedAt?: number;
}

/** GET /api/shared-projects/:id/code: the repository on GitHub, each member's open branches and pull requests. */
export interface SharedProjectCodeDto {
  repo?: string;
  url?: string;
  /** This hub's GitHub token can read the repository. */
  connected: boolean;
  /** Why not, in words. */
  reason?: string;
  defaultBranch?: string;
  private?: boolean;
  members: Array<{ fingerprint: string; name: string; you: boolean; github?: string; pulls: SharedPullDto[]; branches: string[] }>;
  /** Open pull requests from people who are not members, or members whose login is not known. */
  others: SharedPullDto[];
  /** Branches no open pull request comes from. */
  branches: string[];
}

/** The friend.project event: a project changed on this hub. */
export type SharedProjectChange = 'invited' | 'updated' | 'item' | 'members' | 'removed' | 'ended' | 'left' | 'forgotten';
