"use client";
import { createContext, useContext } from "react";
import type { Conversation } from "@/lib/types";

/** What Cetus's transcript needs to weave the folder's other sessions into
 *  its timeline. Provided only around the Threads view's Cetus pane, so every
 *  other message list renders exactly as before. */
export interface SessionTimeline {
  /** Sessions to show inline, oldest first: the folder's sessions that
   *  Cetus's own transcript doesn't already record. */
  sessions: Conversation[];
  /** Any session of the folder by id, for the threads Cetus's transcript
   *  records itself (a message sent straight to a runtime). */
  conversation: (id: string) => Conversation | undefined;
  streamingIds: Set<string>;
  unreadCompletedIds: Set<string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const SessionTimelineContext = createContext<SessionTimeline | null>(null);

export const SessionTimelineProvider = SessionTimelineContext.Provider;

export function useSessionTimeline(): SessionTimeline | null {
  return useContext(SessionTimelineContext);
}
