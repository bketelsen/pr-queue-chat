import { describe, expect, it } from 'vitest';
import type { Room } from 'matrix-js-sdk';
import { THREAD_PULL_REQUEST_EVENT_TYPE } from './threadPullRequests';
import {
  dedupeQueueLinks,
  joinedRooms,
  parseQueuePullRequestLink,
  roomQueueLinks,
  type QueueSourceLink,
} from './prQueue';

const linkContent = (over: Record<string, unknown> = {}) => ({
  url: 'https://github.com/mindroom-ai/mindroom-chat/pull/7',
  set_by: '@agent:example.org',
  set_at: '2026-11-20T10:00:00Z',
  ...over,
});

describe('the queue wire contract', () => {
  it('reads a thread link as the existing parser does', () => {
    expect(
      parseQueuePullRequestLink(
        JSON.stringify(['$thread', 'mindroom-ai/mindroom-chat#7']),
        linkContent()
      )
    ).toEqual({
      threadId: '$thread',
      pullRequest: { owner: 'mindroom-ai', repo: 'mindroom-chat', number: 7 },
      setAt: '2026-11-20T10:00:00Z',
    });
  });

  it('reads a canonical room-only link whose thread is null', () => {
    expect(
      parseQueuePullRequestLink(JSON.stringify([null, 'acme/repo#12']), {
        url: 'https://github.com/Acme/Repo/pull/12',
        set_by: '@agent:example.org',
        set_at: '2026-11-20T10:00:00Z',
      })
    ).toEqual({
      threadId: null,
      pullRequest: { owner: 'acme', repo: 'repo', number: 12 },
      setAt: '2026-11-20T10:00:00Z',
    });
  });

  it('takes a link without a submitted time with an empty one', () => {
    expect(
      parseQueuePullRequestLink(JSON.stringify([null, 'acme/repo#12']), {
        url: 'https://github.com/acme/repo/pull/12',
      })
    ).toMatchObject({ setAt: '' });
  });

  it.each([
    ['a key with a non-canonical space', '[null, "acme/repo#12"]', linkContent()],
    ['a key with another form of the same JSON', '["$thread","acme/repo#12"]', linkContent()],
    ['a key that is not JSON', 'not json', linkContent()],
    ['a key with one part', JSON.stringify(['$thread']), linkContent()],
    ['a key with three parts', JSON.stringify(['$thread', 'acme/repo#12', 'extra']), linkContent()],
    ['a key with a numeric thread', JSON.stringify([7, 'acme/repo#12']), linkContent()],
    ['a key with an object thread', JSON.stringify([{}, 'acme/repo#12']), linkContent()],
    ['a key with a numeric reference', JSON.stringify([null, 12]), linkContent()],
    ['an empty content, the tombstone', JSON.stringify([null, 'acme/repo#12']), {}],
    ['a null content', JSON.stringify([null, 'acme/repo#12']), null],
    ['content without a URL', JSON.stringify([null, 'acme/repo#12']), { set_at: 'now' }],
    [
      'a URL that is no GitHub pull request',
      JSON.stringify([null, 'acme/repo#12']),
      linkContent({ url: 'https://example.org/acme/repo/pull/12' }),
    ],
    [
      'a URL of another pull request',
      JSON.stringify([null, 'acme/repo#12']),
      linkContent({ url: 'https://github.com/acme/repo/pull/13' }),
    ],
    ['a reference that is not canonical', JSON.stringify([null, 'Acme/Repo#12']), linkContent()],
  ])('refuses %s', (_name, stateKey, content) => {
    expect(parseQueuePullRequestLink(stateKey, content)).toBeUndefined();
  });
});

describe('a room of the queue', () => {
  const event = (stateKey: string, content: unknown) => ({
    getType: () => THREAD_PULL_REQUEST_EVENT_TYPE,
    getStateKey: () => stateKey,
    getContent: () => content,
  });
  const room = (events: unknown[]) =>
    ({
      roomId: '!room:example.org',
      getMyMembership: () => 'join',
      currentState: {
        getStateEvents: (type: string) => (type === THREAD_PULL_REQUEST_EVENT_TYPE ? events : []),
      },
    }) as unknown as Room;

  it('collects both thread and room-only links and leaves out tombstones', () => {
    const events = [
      event(
        JSON.stringify(['$thread', 'acme/repo#1']),
        linkContent({
          url: 'https://github.com/acme/repo/pull/1',
        })
      ),
      event(
        JSON.stringify([null, 'acme/repo#2']),
        linkContent({
          url: 'https://github.com/acme/repo/pull/2',
        })
      ),
      event(JSON.stringify([null, 'acme/repo#3']), {}),
    ];
    expect(
      roomQueueLinks(room(events)).map((link) => [link.threadId, link.pullRequest.number])
    ).toEqual([
      ['$thread', 1],
      [null, 2],
    ]);
  });

  it('takes only joined rooms from the client', () => {
    const joined = room([]);
    const invited = { ...joined, getMyMembership: () => 'invite' };
    const client = { getRooms: () => [joined, invited] };
    expect(joinedRooms(client as never)).toEqual([joined]);
  });
});

describe('deduplicating the links of joined rooms', () => {
  const source = (
    roomId: string,
    number: number,
    setAt: string,
    repo = 'repo'
  ): QueueSourceLink => ({
    roomId,
    threadId: null,
    pullRequest: { owner: 'acme', repo, number },
    setAt,
  });

  it('keeps one link for each canonical identity, whatever the owner and repo case', () => {
    const selected = dedupeQueueLinks([
      source('!a:example.org', 1, '2026-11-20T10:00:00Z'),
      {
        ...source('!b:example.org', 1, '2026-11-20T11:00:00Z'),
        pullRequest: { owner: 'Acme', repo: 'Repo', number: 1 },
      },
    ]);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.pullRequest).toEqual({ owner: 'Acme', repo: 'Repo', number: 1 });
  });

  it('prefers the room the panel opened in, even over a newer link elsewhere', () => {
    const selected = dedupeQueueLinks(
      [
        source('!elsewhere:example.org', 1, '2026-11-20T12:00:00Z'),
        source('!opened:example.org', 1, '2026-11-20T10:00:00Z'),
      ],
      '!opened:example.org'
    );
    expect(selected[0]?.roomId).toBe('!opened:example.org');
  });

  it('takes the newest submission when the panel opened in neither room', () => {
    const selected = dedupeQueueLinks(
      [
        source('!a:example.org', 1, '2026-11-20T10:00:00Z'),
        source('!b:example.org', 1, '2026-11-20T12:00:00Z'),
        source('!c:example.org', 1, '2026-11-20T11:00:00Z'),
      ],
      '!opened:example.org'
    );
    expect(selected[0]?.roomId).toBe('!b:example.org');
  });

  it('breaks a tie in submission time by room ID, and keeps distinct identities', () => {
    const selected = dedupeQueueLinks([
      source('!b:example.org', 1, '2026-11-20T10:00:00Z'),
      source('!a:example.org', 1, '2026-11-20T10:00:00Z'),
      source('!a:example.org', 2, '2026-11-20T10:00:00Z'),
    ]);
    expect(selected.map((link) => [link.roomId, link.pullRequest.number])).toEqual([
      ['!a:example.org', 1],
      ['!a:example.org', 2],
    ]);
  });

  it('keeps links with no submitted time after those with one', () => {
    const selected = dedupeQueueLinks(
      [source('!a:example.org', 1, ''), source('!b:example.org', 1, '2026-11-20T10:00:00Z')],
      undefined
    );
    expect(selected[0]?.roomId).toBe('!b:example.org');
  });
});
