import { describe, expect, it } from 'vitest';
import { parsePullRequestUrl } from './github';
import plugin from './index';
import { PullRequestQueue } from './PullRequestQueue';

describe('plugin', () => {
  it("a pull request link opens the pull-request panel with the card's request", () => {
    const sidePanel = plugin.messageLinks?.[0]?.sidePanel;
    expect(sidePanel?.id).toBe('pull-request');
    const url = new URL('https://github.com/mindroom-ai/mindroom-chat/pull/490');
    const request = sidePanel?.request(url);
    // The value PullRequestCard passes to panel.open, so a second click follows the link.
    expect(request).toEqual(parsePullRequestUrl(url));
    expect(JSON.stringify(request)).toBe(JSON.stringify(parsePullRequestUrl(url)));
    expect(request).toEqual({ owner: 'mindroom-ai', repo: 'mindroom-chat', number: 490 });
  });

  it('hides the pull-request side panel from the room header and room menu', () => {
    const panel = plugin.sidePanels?.find(({ id }) => id === 'pull-request');
    expect(panel).toMatchObject({ id: 'pull-request', placement: 'none' });
  });

  it('registers the PR Queue side panel in the room menu, with its label translated', () => {
    const panel = plugin.sidePanels?.find(({ id }) => id === 'pr-queue');
    expect(panel).toMatchObject({
      id: 'pr-queue',
      label: 'queue.panelLabel',
      placement: 'menu',
      Component: PullRequestQueue,
    });
    expect(plugin.translations?.en.queue).toMatchObject({ panelLabel: 'PR Queue' });
  });
});
