// @vitest-environment jsdom
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  notifyManager,
} from '@tanstack/react-query';
import type { PanelFrame } from '@mindroom/client-sdk/core';
import {
  ClientEvent,
  RoomEvent,
  RoomStateEvent,
  type MatrixClient,
  type Room,
} from 'matrix-js-sdk';
import { act } from './testing/act';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import plugin from './index';
import { PullRequestQueue } from './PullRequestQueue';
import { pullRequestKey } from './queries';
import { browserTokenAccessKey } from './token';
import { THREAD_PULL_REQUEST_EVENT_TYPE } from './threadPullRequests';
import { githubServer } from './testing/mindroomServer';
import type { PullRequest } from './github';

const OPENED_ROOM = '!opened:example.org';
const OTHER_ROOM = '!other:example.org';

type Membership = 'join' | 'invite' | 'leave';
type LinkSpec = {
  number: number;
  thread?: string | null;
  repo?: string;
  setAt?: string;
};
type TestRoom = {
  room: Room;
  membership: (value: Membership) => void;
  add: (spec: LinkSpec) => { getType(): string };
};

const linkEvent = ({ number, thread = null, repo = 'mindroom-chat', setAt }: LinkSpec) => {
  const url = `https://github.com/mindroom-ai/${repo}/pull/${number}`;
  return {
    getType: () => THREAD_PULL_REQUEST_EVENT_TYPE,
    getStateKey: () => JSON.stringify([thread, `mindroom-ai/${repo}#${number}`]),
    getContent: () => ({
      url,
      set_by: '@agent:example.org',
      set_at: setAt ?? '2026-11-20T10:00:00Z',
    }),
  };
};

const testRoom = (roomId: string, links: LinkSpec[] = []): TestRoom => {
  let membership: Membership = 'join';
  let events = links.map(linkEvent);
  return {
    room: {
      roomId,
      getMyMembership: () => membership,
      currentState: {
        getStateEvents: (type: string) => (type === THREAD_PULL_REQUEST_EVENT_TYPE ? events : []),
      },
    } as unknown as Room,
    membership: (value) => {
      membership = value;
    },
    add: (spec) => {
      const event = linkEvent(spec);
      events = [...events, event];
      return event;
    },
  };
};

type Listener = (...args: unknown[]) => void;

class FakeClient {
  readonly rooms: Room[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  getRooms = () => this.rooms;

  getSafeUserId = () => '@plugin-tester:example.org';

  getHomeserverUrl = () => 'https://example.org';

  on = (event: string, listener: Listener) => {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  };

  off = (event: string, listener: Listener) => {
    this.listeners.get(event)?.delete(listener);
    return this;
  };

  emit = (event: string, ...args: unknown[]) => {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
    return true;
  };

  add = (room: Room) => {
    this.rooms.push(room);
    this.emit(ClientEvent.Room, room);
  };

  remove = (room: Room) => {
    this.rooms.splice(this.rooms.indexOf(room), 1);
    this.emit(ClientEvent.DeleteRoom, room.roomId);
  };
}

const client = new FakeClient();
const matrix = client as unknown as MatrixClient;

const roomServer = vi.hoisted(() => ({
  current: undefined as unknown,
  byRoom: new Map<string, unknown>(),
}));
vi.mock('@mindroom/client-sdk/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mindroom/client-sdk/server')>()),
  useMindroomServerStatus: (roomId: string) => ({
    server: roomServer.byRoom.get(roomId) ?? roomServer.current,
    pending: false,
  }),
}));

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const pullRequests = () =>
  fetchMock.mock.calls
    .map(([url]) => /\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(url)?.[1])
    .filter((number): number is string => number !== undefined)
    .map(Number);

const pull = (state: string, over: Record<string, unknown> = {}) => ({
  title: 'Store sessions in Redis',
  state: state === 'merged' ? 'closed' : state,
  draft: false,
  merged_at: state === 'merged' ? '2026-11-20T01:00:00Z' : null,
  closed_at: state === 'closed' ? '2026-11-20T01:00:00Z' : null,
  head: { sha: 'abc123', ref: 'redis-sessions', repo: { full_name: 'mindroom-ai/mindroom-chat' } },
  base: { ref: 'main', repo: { full_name: 'mindroom-ai/mindroom-chat' } },
  user: { login: 'acme-builder' },
  updated_at: '2026-11-20T01:00:00Z',
  ...over,
});
const serve = (pulls: Record<number, unknown>) =>
  fetchMock.mockImplementation(async (url) => {
    const number = Number(/\/pulls\/(\d+)$/.exec(url)?.[1]);
    const body = pulls[number];
    return body === undefined ? respond({ message: 'Not Found' }, 404) : respond(body);
  });

const TOKEN_KEY = 'mindroom.plugin:%40plugin-tester%3Aexample.org/pull-requests/githubToken';

const show = async (
  roomId = OPENED_ROOM,
  frame?: PanelFrame,
  prepare?: (queryClient: QueryClient) => void
) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  prepare?.(queryClient);
  const ui = () => (
    <QueryClientProvider client={queryClient}>
      <PullRequestQueue roomId={roomId} />
    </QueryClientProvider>
  );
  const view = await renderPluginComponent(ui(), {
    id: 'pull-requests',
    plugin,
    client: matrix,
    frame,
  });
  return { view, queryClient, ui };
};
type View = Awaited<ReturnType<typeof show>>['view'];

const active = (view: View) => view.getByTestId('pr-queue-active');
const done = (view: View) => view.getByTestId('pr-queue-done') as HTMLDetailsElement;
const linkNames = (element: HTMLElement) =>
  [...element.querySelectorAll('a')].map((link) => link.textContent);
const allLinkNames = (view: View) =>
  [...view.baseElement.querySelectorAll('a')].map((link) => link.textContent);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  client.rooms.length = 0;
  roomServer.current = undefined;
  roomServer.byRoom.clear();
  localStorage.removeItem(TOKEN_KEY);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => respond({ message: 'Not Found' }, 404));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  notifyManager.setScheduler((callback) => setTimeout(callback, 0));
  vi.useRealTimers();
  focusManager.setFocused(undefined);
  vi.unstubAllGlobals();
});

describe('PullRequestQueue', () => {
  it('shows the active pull requests of joined rooms, including room-only submissions', async () => {
    const opened = testRoom(OPENED_ROOM, [
      { number: 1, thread: '$thread' },
      { number: 2, thread: null },
    ]);
    const invited = testRoom(OTHER_ROOM, [{ number: 3 }]);
    invited.membership('invite');
    client.add(opened.room);
    client.add(invited.room);
    serve({ 1: pull('open'), 2: pull('open') });

    const { view } = await show();
    await vi.waitFor(() => expect(linkNames(active(view))).toHaveLength(2));
    await vi.waitFor(() => expect(active(view).textContent).toContain('Store sessions in Redis'));
    expect(linkNames(active(view))).toEqual([
      'mindroom-ai/mindroom-chat #1',
      'mindroom-ai/mindroom-chat #2',
    ]);
    expect(view.queryByText('mindroom-ai/mindroom-chat #3')).toBeNull();
    expect(active(view).textContent).toContain('Store sessions in Redis');
    expect(active(view).textContent).toContain('Open');
  });

  it('moves a merged pull request into a collapsed Done, and keeps closed and unavailable ones outside it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-20T00:30:00Z'));
    const opened = testRoom(OPENED_ROOM, [
      { number: 1, thread: null },
      { number: 2, thread: null },
      { number: 3, thread: null },
      { number: 4, thread: null },
    ]);
    client.add(opened.room);
    serve({
      1: pull('open'),
      2: pull('closed'),
      3: pull('merged'),
      4: undefined,
    });

    const { view } = await show();
    await vi.waitFor(() => expect(view.queryByTestId('pr-queue-done')).toBeTruthy());
    expect(done(view).open).toBe(false);
    expect(done(view).textContent).toContain('Done (1)');
    expect(linkNames(done(view))).toEqual(['mindroom-ai/mindroom-chat #3']);

    await vi.waitFor(() =>
      expect(linkNames(active(view))).toContain('mindroom-ai/mindroom-chat #4')
    );
    expect(active(view).textContent).toContain('Status unavailable');
    expect(linkNames(active(view))).toEqual([
      'mindroom-ai/mindroom-chat #1',
      'mindroom-ai/mindroom-chat #2',
      'mindroom-ai/mindroom-chat #4',
    ]);
    expect(active(view).textContent).toContain('Closed');
    expect(active(view).textContent).toContain('Open');
  });

  it('takes a row out when its room is left and adds one when a room is joined or links change', async () => {
    const opened = testRoom(OPENED_ROOM, [{ number: 1 }]);
    client.add(opened.room);
    serve({ 1: pull('open'), 2: pull('open') });

    const { view } = await show();
    await vi.waitFor(() =>
      expect(linkNames(active(view))).toContain('mindroom-ai/mindroom-chat #1')
    );

    opened.membership('leave');
    await act(async () => {
      client.emit(RoomEvent.MyMembership, opened.room, 'leave', 'join');
    });
    await vi.waitFor(() =>
      expect(allLinkNames(view)).not.toContain('mindroom-ai/mindroom-chat #1')
    );

    const other = testRoom(OTHER_ROOM, []);
    client.add(other.room);
    const event = other.add({ number: 2 });
    await act(async () => {
      client.emit(RoomStateEvent.Events, event);
    });
    await vi.waitFor(() =>
      expect(linkNames(active(view))).toContain('mindroom-ai/mindroom-chat #2')
    );

    client.remove(other.room);
    await vi.waitFor(() =>
      expect(allLinkNames(view)).not.toContain('mindroom-ai/mindroom-chat #2')
    );
  });

  it('keeps the target room of a duplicate, not the other room', async () => {
    const opened = testRoom(OPENED_ROOM, [{ number: 1, setAt: '2026-11-20T09:00:00Z' }]);
    const other = testRoom(OTHER_ROOM, [{ number: 1, setAt: '2026-11-20T11:00:00Z' }]);
    client.add(opened.room);
    client.add(other.room);
    serve({ 1: pull('open') });

    const { view } = await show();
    await vi.waitFor(() =>
      expect(linkNames(active(view))).toContain('mindroom-ai/mindroom-chat #1')
    );
    expect(linkNames(active(view))).toEqual(['mindroom-ai/mindroom-chat #1']);
    expect(pullRequests()).toEqual([1]);
  });

  it('reads a duplicate through the access of the room the panel opened in', async () => {
    const openedServer = githubServer(
      async () => respond(pull('open', { title: 'Read from the opened room' })),
      undefined,
      'https://opened.example.org'
    );
    const otherServer = githubServer(
      async () => respond(pull('open', { title: 'Read from the other room' })),
      undefined,
      'https://other.example.org'
    );
    roomServer.byRoom.set(OPENED_ROOM, openedServer.server);
    roomServer.byRoom.set(OTHER_ROOM, otherServer.server);
    client.add(testRoom(OPENED_ROOM, [{ number: 1 }]).room);
    client.add(testRoom(OTHER_ROOM, [{ number: 1 }]).room);

    const { view } = await show();
    await vi.waitFor(() => expect(active(view).textContent).toContain('Read from the opened room'));
    expect(view.queryByText('Read from the other room')).toBeNull();
    expect(openedServer.githubRequests()).toHaveLength(1);
    expect(otherServer.githubRequests()).toHaveLength(0);
  });

  it('clears the answers of a room left and rejoined, so another server never replays them', async () => {
    const firstServer = githubServer(async () =>
      respond(pull('open', { title: 'From the first server' }))
    );
    roomServer.byRoom.set(OPENED_ROOM, firstServer.server);
    const opened = testRoom(OPENED_ROOM, [{ number: 1 }]);
    client.add(opened.room);

    const { view } = await show();
    await vi.waitFor(() => expect(active(view).textContent).toContain('From the first server'));

    opened.membership('leave');
    await act(async () => {
      client.emit(RoomEvent.MyMembership, opened.room, 'leave', 'join');
    });
    await vi.waitFor(() => expect(allLinkNames(view)).toEqual([]));

    let release = () => {};
    const held = new Promise<Response>(
      (resolve) => (release = () => resolve(respond(pull('open'))))
    );
    const secondServer = githubServer(() => held, undefined, 'https://second.example.org');
    roomServer.byRoom.set(OPENED_ROOM, secondServer.server);
    opened.membership('join');
    await act(async () => {
      client.emit(RoomEvent.MyMembership, opened.room, 'join', 'leave');
    });

    // The old server's title is gone before the new server answered.
    expect(view.queryByText('From the first server')).toBeNull();
    await act(async () => release());
    await vi.waitFor(() => expect(active(view).textContent).toContain('Store sessions in Redis'));
    expect(firstServer.githubRequests()).toHaveLength(1);
    expect(secondServer.githubRequests()).toHaveLength(1);
  });

  it('reclassifies a closed pull request as soon as a read says it is open again', async () => {
    const opened = testRoom(OPENED_ROOM, [{ number: 1 }]);
    client.add(opened.room);
    serve({ 1: pull('closed') });

    const { view, queryClient } = await show();
    await vi.waitFor(() => expect(active(view).textContent).toContain('Closed'));

    serve({ 1: pull('open') });
    await act(async () => queryClient.invalidateQueries());
    await vi.waitFor(() => expect(active(view).textContent).toContain('Open'));
    expect(view.queryByTestId('pr-queue-done')).toBeNull();
  });

  it('drops a title GitHub refused but keeps the link outside Done', async () => {
    const opened = testRoom(OPENED_ROOM, [{ number: 1 }]);
    client.add(opened.room);
    serve({ 1: pull('open', { title: 'Private work' }) });

    const { view, queryClient } = await show();
    await vi.waitFor(() => expect(active(view).textContent).toContain('Private work'));

    serve({});
    await act(async () => queryClient.invalidateQueries());
    await vi.waitFor(() => expect(active(view).textContent).toContain('Status unavailable'));
    expect(view.queryByText('Private work')).toBeNull();
    expect(linkNames(active(view))).toEqual(['mindroom-ai/mindroom-chat #1']);
    expect(view.queryByTestId('pr-queue-done')).toBeNull();
  });

  it('drops a cached private title when GitHub answers a plain 403', async () => {
    localStorage.setItem(TOKEN_KEY, 'ghp_private');
    const opened = testRoom(OPENED_ROOM, [{ number: 1 }]);
    client.add(opened.room);
    serve({ 1: pull('open', { title: 'Private work' }) });

    const { view, queryClient } = await show();
    await vi.waitFor(() => expect(active(view).textContent).toContain('Private work'));

    fetchMock.mockImplementation(async () => respond({ message: 'Forbidden' }, 403));
    await act(async () => queryClient.invalidateQueries());
    await vi.waitFor(() => expect(active(view).textContent).toContain('Status unavailable'));
    expect(view.queryByText('Private work')).toBeNull();
    expect(linkNames(active(view))).toEqual(['mindroom-ai/mindroom-chat #1']);
  });

  it('reads with a token every five minutes while visible, and a valid merge no more', async () => {
    localStorage.setItem(TOKEN_KEY, 'ghp_test');
    focusManager.setFocused(true);
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-11-20T00:30:00Z'));
    const opened = testRoom(OPENED_ROOM, [{ number: 1 }, { number: 2 }]);
    client.add(opened.room);
    serve({ 1: pull('open'), 2: pull('merged') });

    const { view } = await show();
    await vi.waitFor(() => expect(view.queryByTestId('pr-queue-done')).toBeTruthy());
    await vi.waitFor(() => expect(active(view).textContent).toContain('Open'));
    expect(pullRequests().sort()).toEqual([1, 2]);
    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
    await vi.waitFor(() => expect(pullRequests()).toHaveLength(3));
    expect(pullRequests().filter((number) => number === 1)).toHaveLength(2);
    expect(pullRequests().filter((number) => number === 2)).toHaveLength(1);
  });

  it('keeps polling an optimistic merge with no merge timestamp', async () => {
    localStorage.setItem(TOKEN_KEY, 'ghp_test');
    focusManager.setFocused(true);
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-11-20T00:30:00Z'));
    const opened = testRoom(OPENED_ROOM, [{ number: 1 }]);
    client.add(opened.room);
    serve({ 1: pull('open') });

    const { view } = await show(OPENED_ROOM, undefined, (queryClient) => {
      queryClient.setQueryData(
        [
          ...pullRequestKey({ owner: 'mindroom-ai', repo: 'mindroom-chat', number: 1 }),
          browserTokenAccessKey(queryClient),
        ],
        {
          title: 'Optimistically merged',
          state: 'merged',
          draft: false,
          mergedAt: null,
        } as PullRequest
      );
    });
    expect(active(view).textContent).toContain('Optimistically merged');
    expect(view.queryByTestId('pr-queue-done')).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
    await vi.waitFor(() => expect(pullRequests()).toEqual([1]));
  });

  it('does not poll anonymously, but reads the public view and a stale one when shown again', async () => {
    focusManager.setFocused(true);
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const opened = testRoom(OPENED_ROOM, [{ number: 1 }]);
    client.add(opened.room);
    serve({ 1: pull('open') });

    const { view } = await show();
    await vi.waitFor(() => expect(active(view).textContent).toContain('Store sessions in Redis'));
    expect(pullRequests()).toEqual([1]);

    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(pullRequests()).toEqual([1]);

    serve({ 1: pull('open', { title: 'Updated in public' }) });
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await vi.waitFor(() => expect(pullRequests()).toEqual([1, 1]));
    await vi.waitFor(() => expect(active(view).textContent).toContain('Updated in public'));
  });

  it('does not read while folded, and reads a stale answer when revealed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const frame: PanelFrame = {
      label: 'PR Queue',
      layout: 'folded',
      setLayout: vi.fn(),
    };
    const opened = testRoom(OPENED_ROOM, [{ number: 1 }]);
    client.add(opened.room);
    serve({ 1: pull('open') });

    const { view, ui } = await show(OPENED_ROOM, frame);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(pullRequests()).toEqual([]);

    frame.layout = 'beside';
    await act(async () => view.rerender(ui()));
    await vi.waitFor(() => expect(pullRequests()).toEqual([1]));
    await vi.waitFor(() => expect(active(view).textContent).toContain('Store sessions in Redis'));

    frame.layout = 'folded';
    await act(async () => view.rerender(ui()));
    vi.setSystemTime(Date.now() + 121_000);
    serve({ 1: pull('open', { title: 'Updated when revealed' }) });
    frame.layout = 'beside';
    await act(async () => view.rerender(ui()));
    await vi.waitFor(() => expect(pullRequests()).toEqual([1, 1]));
    await vi.waitFor(() => expect(active(view).textContent).toContain('Updated when revealed'));
  });

  it('drops an already-expired merge submitted after the panel opened, by the real time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-20T00:00:00Z'));
    const opened = testRoom(OPENED_ROOM, []);
    client.add(opened.room);

    const { view } = await show();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    vi.setSystemTime(new Date('2026-11-20T01:00:00Z'));
    serve({ 1: pull('merged', { merged_at: '2026-11-19T12:30:00Z' }) });
    const event = opened.add({ number: 1 });
    await act(async () => {
      client.emit(RoomStateEvent.Events, event);
    });

    await vi.waitFor(() => expect(pullRequests()).toEqual([1]));
    await vi.waitFor(() => expect(allLinkNames(view)).toEqual([]));
    expect(view.queryByTestId('pr-queue-done')).toBeNull();
  });

  it('removes a Done row at exactly twelve hours, with a timer and no further read', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2026-11-20T00:00:00Z'));
    notifyManager.setScheduler(queueMicrotask);
    const opened = testRoom(OPENED_ROOM, [{ number: 1 }]);
    client.add(opened.room);
    serve({ 1: pull('merged', { merged_at: '2026-11-20T01:00:00Z' }) });

    const { view } = await show();
    await vi.waitFor(() => expect(view.queryByTestId('pr-queue-done')).toBeTruthy());
    expect(linkNames(done(view))).toEqual(['mindroom-ai/mindroom-chat #1']);
    expect(pullRequests()).toEqual([1]);

    await act(() => vi.advanceTimersByTimeAsync(12 * 60 * 60_000));
    expect(linkNames(done(view))).toEqual(['mindroom-ai/mindroom-chat #1']);

    await act(() => vi.advanceTimersByTimeAsync(60 * 60_000));
    expect(view.queryByTestId('pr-queue-done')).toBeNull();
    expect(allLinkNames(view)).not.toContain('mindroom-ai/mindroom-chat #1');
    expect(pullRequests()).toEqual([1]);
  });
});
