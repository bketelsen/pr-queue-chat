// Reads the pull request submissions of the joined rooms: the same state event the thread chips
// read, in its thread form and in the room-only form whose thread is null, with the room each
// submission came from so that a summary is read with that room's GitHub access.
import { useEffect, useMemo, useReducer } from 'react';
import {
  ClientEvent,
  RoomEvent,
  RoomStateEvent,
  type MatrixClient,
  type Room,
} from 'matrix-js-sdk';
import { parsePullRequestUrl, type PullRequestRef } from './github';
import { parseThreadPullRequestLink, THREAD_PULL_REQUEST_EVENT_TYPE } from './threadPullRequests';

export type QueuePullRequestLink = {
  /** The thread the backend linked it to, or null for a submission outside a thread. */
  threadId: string | null;
  pullRequest: PullRequestRef;
  setAt: string;
};

/** A submission with the room whose state holds it. */
export type QueueSourceLink = QueuePullRequestLink & { roomId: string };

/** What GitHub's owners and repositories ignore case makes one pull request's stable name. */
export const queueIdentity = (ref: PullRequestRef) =>
  `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;

const refKeyOf = (ref: PullRequestRef) =>
  `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;

function contentOf(
  content: unknown,
  refKey: string
): QueuePullRequestLink['pullRequest'] | undefined {
  if (typeof content !== 'object' || content === null) return undefined;
  const { url } = content as { url?: unknown };
  if (typeof url !== 'string') return undefined;
  let parsed: PullRequestRef | undefined;
  try {
    parsed = parsePullRequestUrl(new URL(url));
  } catch {
    return undefined;
  }
  if (parsed === undefined) return undefined;
  const pullRequest = {
    ...parsed,
    owner: parsed.owner.toLowerCase(),
    repo: parsed.repo.toLowerCase(),
  };
  if (refKeyOf(pullRequest) !== refKey) return undefined;
  return pullRequest;
}

/**
 * The submission one state event records, or undefined for a tombstone or malformed event. Thread
 * links are read by the parser the thread chips use. A room-only link has the same content and the
 * compact key `[null,"owner/repo#number"]`; any other spelling of that key would count twice.
 */
export function parseQueuePullRequestLink(
  stateKey: string,
  content: unknown
): QueuePullRequestLink | undefined {
  let key: unknown;
  try {
    key = JSON.parse(stateKey);
  } catch {
    return undefined;
  }
  if (!Array.isArray(key) || key.length !== 2) return undefined;
  const [threadId, refKey] = key as unknown[];
  if (threadId !== null && typeof threadId !== 'string') return undefined;
  if (typeof refKey !== 'string') return undefined;
  if (JSON.stringify([threadId, refKey]) !== stateKey) return undefined;
  if (typeof threadId === 'string') {
    const link = parseThreadPullRequestLink(stateKey, content);
    return (
      link && {
        threadId: link.threadId,
        pullRequest: link.pullRequest,
        setAt: link.setAt,
      }
    );
  }
  const pullRequest = contentOf(content, refKey);
  if (pullRequest === undefined) return undefined;
  const { set_at: setAt } = content as { set_at?: unknown };
  return {
    threadId: null,
    pullRequest,
    setAt: typeof setAt === 'string' ? setAt : '',
  };
}

/** Every valid submission in the room's state. */
export function roomQueueLinks(room: Room): QueuePullRequestLink[] {
  return room.currentState.getStateEvents(THREAD_PULL_REQUEST_EVENT_TYPE).flatMap((event) => {
    const link = parseQueuePullRequestLink(event.getStateKey() ?? '', event.getContent());
    return link ? [link] : [];
  });
}

const submittedAt = (setAt: string) => {
  const time = Date.parse(setAt);
  return Number.isNaN(time) ? -Infinity : time;
};

/**
 * One stable source for each pull request: a submission in the room the panel opened in, else the
 * newest submission, then the room ID. Links are sorted by canonical identity so that the source
 * chosen for one link does not move another.
 */
export function dedupeQueueLinks(
  links: readonly QueueSourceLink[],
  openedRoomId?: string
): QueueSourceLink[] {
  const preferred = (a: QueueSourceLink, b: QueueSourceLink): QueueSourceLink => {
    const aOpened = a.roomId === openedRoomId;
    const bOpened = b.roomId === openedRoomId;
    if (aOpened !== bOpened) return aOpened ? a : b;
    const aAt = submittedAt(a.setAt);
    const bAt = submittedAt(b.setAt);
    if (aAt !== bAt) return aAt > bAt ? a : b;
    if (a.roomId !== b.roomId) return a.roomId < b.roomId ? a : b;
    return a;
  };
  const chosen = new Map<string, QueueSourceLink>();
  for (const link of links) {
    const identity = queueIdentity(link.pullRequest);
    const current = chosen.get(identity);
    chosen.set(identity, current === undefined ? link : preferred(current, link));
  }
  return [...chosen.values()].sort((a, b) => {
    const identity = queueIdentity(a.pullRequest);
    const other = queueIdentity(b.pullRequest);
    return identity < other ? -1 : identity > other ? 1 : a.roomId < b.roomId ? -1 : 1;
  });
}

/** The rooms the signed-in account is in, leaving out invitations and rooms it left. */
export function joinedRooms(client: Pick<MatrixClient, 'getRooms'>): Room[] {
  return client.getRooms().filter((room) => room.getMyMembership() === 'join');
}

/**
 * The joined rooms, read again when the account joins or leaves one, a room goes, or a room's
 * submission state changes. The client re-emits its rooms' state events.
 */
export function useJoinedRooms(client: MatrixClient): Room[] {
  const [revision, changed] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    const refresh = () => changed();
    const onState = (event: { getType(): string }) => {
      if (event.getType() === THREAD_PULL_REQUEST_EVENT_TYPE) refresh();
    };
    client.on(ClientEvent.Room, refresh);
    client.on(ClientEvent.DeleteRoom, refresh);
    client.on(RoomEvent.MyMembership, refresh);
    client.on(RoomStateEvent.Events, onState);
    return () => {
      client.off(ClientEvent.Room, refresh);
      client.off(ClientEvent.DeleteRoom, refresh);
      client.off(RoomEvent.MyMembership, refresh);
      client.off(RoomStateEvent.Events, onState);
    };
  }, [client]);
  return useMemo(() => joinedRooms(client), [client, revision]);
}
