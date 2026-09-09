import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatVirtualList, type ChatListHandle, type ChatListSnapshot } from '../../src/components/chat/chat-virtual-list';
import { bindChatTailScroll } from '../../src/lib/chat-tail-scroll';
function App() {
  const [rows, setRows] = useState(Array.from({length: 160}, (_, i) => ({id: i, height: 80 + i % 5 * 40})));
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [height, setHeight] = useState(500);
  const follow = useRef(true);
  const binding = useRef<ReturnType<typeof bindChatTailScroll> | null>(null);
  const search = useRef(false);
  const running = useRef(false);
  const restore = useRef<ChatListSnapshot | null>(null);
  const ref = useRef<ChatListHandle | null>(null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!scroller) return;
    const b = bindChatTailScroll(scroller, {
      isFollowing: () => follow.current,
      setFollowing: value => { follow.current = value; },
      isSearching: () => search.current,
      onRelease: () => ref.current?.cancelScroll(),
    });
    binding.current = b;
    return () => { binding.current = null; b.dispose(); };
  }, [scroller]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (running.current) setRows(rows => rows.map((r, i) => i === rows.length - 1 ? {...r, height: r.height + 7} : r));
    }, 16);
    return () => clearInterval(timer);
  }, []);
  const status = () => ({ top: scroller?.scrollTop ?? 0, distance: scroller ? scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop : Infinity, following: follow.current, rendered: scroller?.querySelectorAll('[data-index]').length ?? 0 });
  (window as any).harness = {
    status, start: () => running.current = true, stop: () => running.current = false,
    shrink: () => setHeight(300), grow: () => setHeight(500),
    resizeRow: (index: number, delta: number) => setRows(rows => rows.map((row, i) => i === index ? {...row, height: Math.max(20, row.height + delta)} : row)),
    seek: (index: number) => { follow.current = false; ref.current?.scrollToIndex({index, align: 'start'}); },
    append: () => setRows(rows => [...rows, {id: rows.length, height: 150}]),
    resume: () => { follow.current = true; ref.current?.scrollToIndex({index: 'LAST', align: 'end'}); },
    restore: () => ref.current?.getState(snapshot => { restore.current = snapshot; follow.current = false; setGeneration(n => n + 1); }),
  };
  return <div style={{height, width: 700, display: 'flex'}}><ChatVirtualList key={generation} ref={ref} scrollerRef={setScroller} className="list" data={rows}
    initialState={restore.current ?? undefined} itemKey={(i, row) => String(row.id)}
    onHeightChange={() => binding.current?.schedule()} onRangeChange={() => {}} onBottomChange={() => {}}
    itemContent={(i, row) => <div style={{height: row.height, background: i % 2 ? '#eee' : '#ddd'}}>Message {i}</div>}
  /></div>;
}
createRoot(document.getElementById('root')).render(<App/>);
