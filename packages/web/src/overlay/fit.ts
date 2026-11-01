/*
 * Window fits its content, and the panel sticks to the bottom only when the
 * owner was there.
 *
 * Ported from Pickle Glass, github.com/SerzhIvanov/glass (a fork of
 * pickle-com/glass) @71bc3dce7c92c31ffd0e68eb708f55b171f52a96:
 *   src/ui/ask/AskView.js 1407-1439 (adjustWindowHeight, at most once per
 *     animation frame, capped)
 *   src/ui/listen/stt/SttView.js 115-185 (scroll to the bottom after an update
 *     only when the view was within 10 px of the bottom before it)
 * Copyright (C) 2025 Pickle Team. Licensed GPL-3.0-or-later; combined into
 * Conclave (AGPL-3.0-only) under GPLv3 section 13.
 *
 * Changed from the source: a React hook; a ResizeObserver tells when the
 * content changed instead of each render calling in; the cap is the app's
 * (meeting_set_height clamps to the screen), not 700 px.
 */
import { useEffect, type RefObject } from 'react';
import { ipc } from './desktop';

/** Glass's test: within 10 px of the bottom. */
export function atBottom(top: number, client: number, height: number): boolean {
  return top + client >= height - 10;
}

/**
 * `panel` scrolls, `content` is what it holds. Each content change asks the
 * app for a window that fits (one call per frame at most, same height not
 * asked twice) and keeps the bottom in view when the owner had it there.
 */
export function useFitAndStick(panel: RefObject<HTMLElement | null>, content: RefObject<HTMLElement | null>, chrome = 12): void {
  useEffect(() => {
    const p = panel.current;
    const c = content.current;
    if (!p || !c) return;
    let stick = true;
    let frame: number | undefined;
    let asked = 0;
    const onScroll = () => {
      stick = atBottom(p.scrollTop, p.clientHeight, p.scrollHeight);
    };
    const run = () => {
      frame = undefined;
      // around the content: the panel's padding and border, and #root's padding (chrome)
      const cs = getComputedStyle(p);
      const want = Math.ceil(c.getBoundingClientRect().height + (p.offsetHeight - p.clientHeight) + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + chrome);
      if (want !== asked) {
        asked = want;
        void ipc.setHeight(want)?.catch(() => undefined);
      }
      if (stick) p.scrollTop = p.scrollHeight;
    };
    const ro = new ResizeObserver(() => {
      frame ??= requestAnimationFrame(run);
    });
    ro.observe(c);
    p.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      ro.disconnect();
      p.removeEventListener('scroll', onScroll);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [panel, content, chrome]);
}
