// The PR Queue side panel: every pull request submitted to a joined room, by the state events the
// thread chips read, with each summary read through the access of the room that submitted it.
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { usePluginTranslation, usePanelFrame } from '@mindroom/client-sdk/core';
import { useMatrixClient } from '@mindroom/client-sdk/matrix';
import { pullRequestUrl, type PullRequest } from './github';
import {
  RelativeTime,
  resolvePullRequestState,
  type PullRequestStatePresentation,
} from './presentation';
import {
  dedupeQueueLinks,
  queueIdentity,
  roomQueueLinks,
  useJoinedRooms,
  type QueueSourceLink,
} from './prQueue';
import { answerOf, BACKGROUND_READ, unlessRefused, usePullRequests } from './queries';
import { pluginRootStyle } from './theme';
import { RoomGitHub, useGitHubAccess } from './token';
import './prQueue.css';

// The banner's button reads again at this interval while a pull request is still open or closed;
// a merged one is settled and is not asked again.
const QUEUE_REFETCH_MS = 5 * 60_000;

// A merged pull request stays in Done for twelve hours from the time GitHub confirmed the merge.
export const DONE_RETENTION_MS = 12 * 60 * 60_000;

// The label GitHub carries on a pull request an agent has left for a person to review.
const READY_FOR_HUMAN_LABEL = 'ready-for-human';

type QueueAnswer = {
  pr: PullRequest | undefined;
  loading: boolean;
};

const LOADING: QueueAnswer = { pr: undefined, loading: true };

const answerKey = (roomId: string, identity: string) => `${roomId}\u0000${identity}`;

/** The moment a merged pull request leaves the queue, or undefined without a valid merge time. */
export function queueDoneAt(pr: PullRequest | undefined): number | undefined {
  if (pr?.state !== 'merged' || !pr.mergedAt) return undefined;
  const mergedAt = Date.parse(pr.mergedAt);
  return Number.isNaN(mergedAt) ? undefined : mergedAt + DONE_RETENTION_MS;
}

/**
 * How often a summary is read again: only while the panel shows and only with a token or MindRoom's
 * connection, an anonymous overview asking only when it opens and when a stale one is shown again.
 * A valid merge is settled; an optimistic merge without its timestamp is not.
 */
export function queuePollInterval(
  pr: PullRequest | undefined,
  visible: boolean,
  automatic: boolean
): number | false {
  if (!visible || !automatic) return false;
  return queueDoneAt(pr) === undefined ? QUEUE_REFETCH_MS : false;
}

/** Whether the page, and the panel in it, is shown rather than folded or in a hidden tab. */
function usePanelVisible(): boolean {
  const frame = usePanelFrame();
  const [pageVisible, setPageVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
  );
  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState !== 'hidden');
    const focus = () => setPageVisible(true);
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', focus);
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', focus);
    };
  }, []);
  return pageVisible && (frame === undefined || frame.layout !== 'folded');
}

/**
 * The current time, moved on with one timer to the next Done expiry. Read now, on a return to the
 * page, and at each expiry, so a row leaves without another GitHub request.
 */
function useQueueNow(expiries: readonly number[], visible: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  const next = expiries.reduce<number | undefined>(
    (soonest, expiry) =>
      expiry > now && (soonest === undefined || expiry < soonest) ? expiry : soonest,
    undefined
  );
  useEffect(() => {
    if (!visible || next === undefined) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()));
    return () => clearTimeout(timer);
  }, [next, visible]);
  useEffect(() => {
    if (visible) setNow(Date.now());
  }, [visible]);
  // A submission that arrives late can already be past its expiry: the real time decides now.
  return Math.max(now, Date.now());
}

/**
 * One room's summaries, read with that room's GitHub access. It renders nothing: the rows are
 * drawn together so that one Done holds the merged pull requests of every room.
 */
function QueueObserver({
  roomId,
  links,
  visible,
  onAnswers,
}: {
  roomId: string;
  links: readonly QueueSourceLink[];
  visible: boolean;
  onAnswers(roomId: string, answers: readonly { identity: string; answer: QueueAnswer }[]): void;
}) {
  const access = useGitHubAccess();
  const queries = usePullRequests(
    links.map((link) => link.pullRequest),
    {
      ...BACKGROUND_READ,
      // Folded, nothing is read by itself; showing the panel again reads a stale answer anew.
      enabled: visible ? unlessRefused : false,
      refetchOnMount: unlessRefused,
      retryOnMount: unlessRefused,
      refetchOnReconnect: unlessRefused,
      refetchOnWindowFocus: unlessRefused,
      refetchInterval: (query) =>
        unlessRefused(query)
          ? queuePollInterval(
              query.state.data as PullRequest | undefined,
              visible,
              access.via !== undefined
            )
          : false,
      refetchIntervalInBackground: false,
    }
  );
  const answers = queries.map((query): QueueAnswer => {
    const pr = answerOf(query);
    return { pr, loading: query.isPending };
  });
  const latest = useRef(answers);
  latest.current = answers;
  // The query state tells when an answer or a refusal changed, without reading titles here.
  const signature = JSON.stringify([
    access.key,
    ...queries.map((query) => [
      query.dataUpdatedAt,
      query.errorUpdatedAt,
      query.status,
      query.fetchStatus,
    ]),
  ]);
  useLayoutEffect(() => {
    onAnswers(
      roomId,
      links.map((link, index) => ({
        identity: queueIdentity(link.pullRequest),
        answer: latest.current[index] as QueueAnswer,
      }))
    );
    return () => onAnswers(roomId, []);
  }, [links, onAnswers, roomId, signature]);
  return null;
}

function QueueRow({ link, answer }: { link: QueueSourceLink; answer: QueueAnswer }) {
  const t = usePluginTranslation('pull-requests');
  const { pullRequest } = link;
  const repository = `${pullRequest.owner}/${pullRequest.repo}`;
  const state = answer.pr ? resolvePullRequestState(answer.pr) : undefined;
  const readyForHuman = answer.pr?.labels?.some(({ name }) => name === READY_FOR_HUMAN_LABEL);
  return (
    <li className="mrpr-queue-row">
      <div className="mrpr-queue-row-head">
        <a
          className="mrpr-queue-link"
          href={pullRequestUrl(pullRequest)}
          target="_blank"
          rel="noreferrer"
        >
          <span className="mrpr-truncate">{repository}</span>{' '}
          <span className="mrpr-shrink-0">#{pullRequest.number}</span>
        </a>
        {state ? <QueueState state={state} /> : null}
      </div>
      {readyForHuman ? (
        <p className="mrpr-queue-ready">
          <span className="mrpr-badge mrpr-badge-success">{t('queue.readyForHuman')}</span>
        </p>
      ) : null}
      {answer.pr ? (
        <p className="mrpr-queue-title">{answer.pr.title}</p>
      ) : (
        <p className="mrpr-queue-note">
          {answer.loading ? t('loading') : t('queue.statusUnavailable')}
        </p>
      )}
      {answer.pr?.state === 'merged' && answer.pr.mergedAt ? (
        <p className="mrpr-queue-note">
          <RelativeTime
            timestamp={answer.pr.mergedAt}
            label={(time) => t('queue.merged', { time })}
          />
        </p>
      ) : null}
    </li>
  );
}

function QueueState({ state }: { state: PullRequestStatePresentation }) {
  const t = usePluginTranslation('pull-requests');
  return (
    <span className="mrpr-queue-state mrpr-state">
      <state.Icon aria-hidden className={`mrpr-icon ${state.toneClassName}`} />
      {t(`state.${state.key}`)}
    </span>
  );
}

type QueueEntry = { link: QueueSourceLink; answer: QueueAnswer; doneAt?: number };

const rankOf = (entry: QueueEntry) => {
  const pr = entry.answer.pr;
  if (!pr) return 4;
  if (pr.state === 'open') return pr.draft ? 1 : 0;
  if (pr.state === 'closed') return 2;
  return 3;
};

export function PullRequestQueue({ roomId }: { roomId: string }) {
  const t = usePluginTranslation('pull-requests');
  const client = useMatrixClient();
  const rooms = useJoinedRooms(client);
  const visible = usePanelVisible();
  const headingId = useId();

  const links = useMemo(
    () =>
      rooms.flatMap((room) =>
        roomQueueLinks(room).map((link) => ({ ...link, roomId: room.roomId }))
      ),
    [rooms]
  );
  const selected = useMemo(() => dedupeQueueLinks(links, roomId), [links, roomId]);
  const groups = useMemo(() => {
    const byRoom = new Map<string, QueueSourceLink[]>();
    for (const link of selected) {
      const group = byRoom.get(link.roomId);
      if (group) group.push(link);
      else byRoom.set(link.roomId, [link]);
    }
    return [...byRoom.entries()].sort(([a], [b]) =>
      a === roomId ? -1 : b === roomId ? 1 : a < b ? -1 : 1
    );
  }, [roomId, selected]);

  const [answers, setAnswers] = useState<ReadonlyMap<string, QueueAnswer>>(new Map());
  const onAnswers = useCallback(
    (sourceRoomId: string, next: readonly { identity: string; answer: QueueAnswer }[]) => {
      setAnswers((previous) => {
        const prefix = `${sourceRoomId}\u0000`;
        const current = new Set(next.map(({ identity }) => `${prefix}${identity}`));
        let changed = false;
        const updated = new Map(previous);
        // A link that left the room, or the room itself, leaves no answer behind to replay.
        for (const key of previous.keys()) {
          if (key.startsWith(prefix) && !current.has(key)) {
            updated.delete(key);
            changed = true;
          }
        }
        for (const { identity, answer } of next) {
          const key = `${prefix}${identity}`;
          const old = previous.get(key);
          if (old?.pr !== answer.pr || old?.loading !== answer.loading) {
            updated.set(key, answer);
            changed = true;
          }
        }
        return changed ? updated : previous;
      });
    },
    []
  );

  const entries: QueueEntry[] = selected.map((link) => {
    const answer = answers.get(answerKey(link.roomId, queueIdentity(link.pullRequest))) ?? LOADING;
    return { link, answer, doneAt: queueDoneAt(answer.pr) };
  });
  const now = useQueueNow(
    entries.flatMap((entry) => (entry.doneAt === undefined ? [] : [entry.doneAt])),
    visible
  );
  const shown = entries.filter((entry) => entry.doneAt === undefined || now < entry.doneAt);
  const active = shown
    .filter((entry) => entry.doneAt === undefined)
    .sort(
      (a, b) =>
        rankOf(a) - rankOf(b) ||
        queueIdentity(a.link.pullRequest).localeCompare(queueIdentity(b.link.pullRequest))
    );
  const done = shown
    .filter((entry) => entry.doneAt !== undefined)
    .sort(
      (a, b) =>
        (b.answer.pr?.mergedAt ?? '').localeCompare(a.answer.pr?.mergedAt ?? '') ||
        queueIdentity(a.link.pullRequest).localeCompare(queueIdentity(b.link.pullRequest))
    );

  const observers: ReactNode = groups.map(([sourceRoomId, group]) => (
    <RoomGitHub key={sourceRoomId} roomId={sourceRoomId}>
      <QueueObserver roomId={sourceRoomId} links={group} visible={visible} onAnswers={onAnswers} />
    </RoomGitHub>
  ));

  return (
    <div className="mrpr-root mrpr-queue" style={pluginRootStyle()}>
      {shown.length === 0 ? <p className="mrpr-queue-note">{t('queue.empty')}</p> : null}
      {active.length > 0 ? (
        <section
          className="mrpr-queue-section"
          data-testid="pr-queue-active"
          aria-labelledby={headingId}
        >
          <h2 id={headingId} className="mrpr-queue-heading">
            {t('queue.active')}
          </h2>
          <ul className="mrpr-queue-list">
            {active.map((entry) => (
              <QueueRow
                key={`${entry.link.roomId}\u0000${queueIdentity(entry.link.pullRequest)}`}
                link={entry.link}
                answer={entry.answer}
              />
            ))}
          </ul>
        </section>
      ) : null}
      {done.length > 0 ? (
        <details className="mrpr-queue-done" data-testid="pr-queue-done">
          <summary className="mrpr-queue-done-summary">
            {t('queue.done', { count: done.length })}
          </summary>
          <ul className="mrpr-queue-list">
            {done.map((entry) => (
              <QueueRow
                key={`${entry.link.roomId}\u0000${queueIdentity(entry.link.pullRequest)}`}
                link={entry.link}
                answer={entry.answer}
              />
            ))}
          </ul>
        </details>
      ) : null}
      {observers}
    </div>
  );
}

export default PullRequestQueue;
