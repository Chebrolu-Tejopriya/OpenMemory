"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bookmark, Pin } from "lucide-react";
import { SearchResult } from "./SearchResultCard";

type CanvasSource = "chrome" | "pinterest";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001";
const CANVAS_LIMIT = 500;

const CARD_W = 220;
const CARD_H = 180;
const GAP_X = 20;
const GAP_Y = 20;
const COLS = 6;
const TILES_X = 5;
const TILES_Y = 5;
const FRICTION_PER_MS = 0.998;

// ── helpers ────────────────────────────────────────────────────────────────
function screenshotUrl(url: string) {
  return `https://v1.screenshot.11ty.dev/${encodeURIComponent(url)}/opengraph/`;
}
function domain(url: string) {
  try { return new URL(url).hostname.replace("www.", ""); } catch { return ""; }
}
function getImageUrl(item: SearchResult): string | null {
  if (item.source === "pinterest") {
    return item.imageUrl && !item.imageUrl.includes("favicon") ? item.imageUrl : null;
  }
  return screenshotUrl(item.url);
}

// ── Card — only rendered once image is confirmed loaded ────────────────────
function Card({ result, style }: { result: SearchResult; style: React.CSSProperties }) {
  const isPin = result.source === "pinterest";
  const displayTitle = isPin
    ? result.title.replace(/^this may contain:?\s*/i, "").trim()
    : result.title;
  const imgSrc = getImageUrl(result);
  const dom = domain(result.url);
  const label = result.folder && result.folder !== "Bookmarks"
    ? result.folder.split("/").pop() || result.folder : dom;

  return (
    <a
      href={result.url}
      target="_blank"
      rel="noopener noreferrer"
      style={style}
      className="absolute group flex flex-col bg-[#f4f4f4] rounded-2xl overflow-hidden hover:shadow-xl transition-shadow duration-200"
    >
      <div className="px-2.5 pt-2.5 pb-0 shrink-0">
        <div className="relative w-full aspect-video rounded-xl overflow-hidden bg-[#e8e8e8]">
          {imgSrc && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imgSrc}
              alt={result.title}
              className={`absolute inset-0 w-full h-full group-hover:scale-[1.03] transition-transform duration-300 ${isPin ? "object-contain" : "object-cover"}`}
            />
          )}
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/25 group-hover:backdrop-blur-[2px] transition-all duration-300 flex items-center justify-center">
            <span className="opacity-0 group-hover:opacity-100 transition-opacity duration-200 bg-white/90 text-gray-700 text-[11px] font-semibold px-4 py-1.5 rounded-full">Open</span>
          </div>
        </div>
      </div>
      <div className="px-2.5 pt-2 pb-2.5 shrink-0 flex flex-col gap-0.5">
        <p className="text-[11px] font-semibold text-gray-700 leading-snug truncate">{displayTitle}</p>
        <div className="flex items-center justify-between gap-1">
          {!isPin && <span className="text-[9px] text-gray-400 truncate">{dom}</span>}
          {isPin && <span className="w-1.5 h-1.5 rounded-full bg-[#E60023]/40 shrink-0" />}
          <span className="text-[9px] font-medium text-gray-400/70 uppercase tracking-wider truncate text-right flex-1">{label}</span>
        </div>
      </div>
    </a>
  );
}

// ── CanvasView ─────────────────────────────────────────────────────────────
interface Props { folders: string[]; boards: string[]; active: boolean }

export default function CanvasView({ folders: _folders, boards: _boards, active: _active }: Props) {
  const [items, setItems] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  // preloadedIds: images confirmed loaded — only these show in the canvas
  const [preloadedIds, setPreloadedIds] = useState<Set<string>>(new Set());
  // failedIds: images that errored — excluded permanently
  const [failedIds, setFailedIds] = useState<Set<string>>(new Set());
  const hasFetched = useRef(false);
  const [source, setSource] = useState<CanvasSource>("chrome");

  const handleLoad = useCallback((id: string) => {
    setPreloadedIds(prev => new Set(prev).add(id));
  }, []);
  const handleError = useCallback((id: string) => {
    setFailedIds(prev => new Set(prev).add(id));
  }, []);

  const scrollRef = useRef<HTMLDivElement>(null);
  const tileWRef = useRef(0);
  const tileHRef = useRef(0);

  const dragging = useRef(false);
  const didDrag = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const lastPtr = useRef({ x: 0, y: 0 });
  const vel = useRef({ x: 0, y: 0 });
  const raf = useRef<number | null>(null);
  const ptrHistory = useRef<{ x: number; y: number; t: number }[]>([]);

  // ── Fetch ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (hasFetched.current) return;
    hasFetched.current = true;
    setLoading(true);
    (async () => {
      const [bmRes, pinRes] = await Promise.allSettled([
        fetch(`${BACKEND_URL}/browse?source=chrome&limit=${CANVAS_LIMIT}`),
        fetch(`${BACKEND_URL}/browse?source=pinterest&limit=${CANVAS_LIMIT}`),
      ]);
      const bookmarks: SearchResult[] = [];
      const pins: SearchResult[] = [];
      if (bmRes.status === "fulfilled" && bmRes.value.ok) {
        const d = await bmRes.value.json();
        (d.results || []).forEach((item: { title: string; url: string; folder: string | null; imageUrl?: string | null }, i: number) => {
          bookmarks.push({ id: `bm-${i}`, title: item.title, folder: item.folder || "", url: item.url, source: "chrome", imageUrl: item.imageUrl || undefined });
        });
      }
      if (pinRes.status === "fulfilled" && pinRes.value.ok) {
        const d = await pinRes.value.json();
        (d.results || []).forEach((item: { title: string | null; url: string; folder: string | null; imageUrl?: string | null }, i: number) => {
          pins.push({ id: `pin-${i}`, title: item.title || "Untitled", folder: item.folder || "", url: item.url, source: "pinterest", imageUrl: item.imageUrl || undefined });
        });
      }
      setItems([...bookmarks, ...pins]);
      setLoading(false);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Scroll to center tile ─────────────────────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !tileWRef.current || !tileHRef.current) return;
    el.scrollLeft = tileWRef.current * 2;
    el.scrollTop = tileHRef.current * 2;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  // ── Infinite wrap ─────────────────────────────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const tw = tileWRef.current;
      const th = tileHRef.current;
      if (!tw || !th) return;
      if (el.scrollLeft >= tw * 3) el.scrollLeft -= tw;
      else if (el.scrollLeft < tw) el.scrollLeft += tw;
      if (el.scrollTop >= th * 3) el.scrollTop -= th;
      else if (el.scrollTop < th) el.scrollTop += th;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // ── Mouse drag + inertia ──────────────────────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      dragging.current = true; didDrag.current = false;
      dragStart.current = { x: e.clientX, y: e.clientY };
      lastPtr.current = { x: e.clientX, y: e.clientY };
      vel.current = { x: 0, y: 0 };
      ptrHistory.current = [{ x: e.clientX, y: e.clientY, t: e.timeStamp }];
      if (raf.current) { cancelAnimationFrame(raf.current); raf.current = null; }
      el.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging.current || e.pointerType !== "mouse") return;
      const events = (e as PointerEvent & { getCoalescedEvents?(): PointerEvent[] }).getCoalescedEvents?.() ?? [e];
      for (const ev of events) {
        const dx = ev.clientX - lastPtr.current.x;
        const dy = ev.clientY - lastPtr.current.y;
        lastPtr.current = { x: ev.clientX, y: ev.clientY };
        el.scrollLeft -= dx; el.scrollTop -= dy;
        ptrHistory.current.push({ x: ev.clientX, y: ev.clientY, t: ev.timeStamp });
      }
      if (!didDrag.current) {
        if (Math.abs(e.clientX - dragStart.current.x) > 4 || Math.abs(e.clientY - dragStart.current.y) > 4) {
          didDrag.current = true; el.style.cursor = "grabbing";
        }
      }
      ptrHistory.current = ptrHistory.current.filter(p => e.timeStamp - p.t < 80);
    };
    const onClickCapture = (e: MouseEvent) => {
      if (didDrag.current) { e.preventDefault(); e.stopPropagation(); didDrag.current = false; }
    };
    const onUp = (e: PointerEvent) => {
      if (!dragging.current || e.pointerType !== "mouse") return;
      dragging.current = false; el.style.cursor = "grab";
      const h = ptrHistory.current;
      if (h.length >= 2) {
        const oldest = h[0], latest = h[h.length - 1];
        const dt = latest.t - oldest.t;
        if (dt > 0) {
          vel.current.x = -((latest.x - oldest.x) / dt) * 16;
          vel.current.y = -((latest.y - oldest.y) / dt) * 16;
        }
      }
      let lastTime = 0;
      const tick = (now: number) => {
        const dt = lastTime ? Math.min(now - lastTime, 64) : 16;
        lastTime = now;
        const decay = Math.pow(FRICTION_PER_MS, dt);
        vel.current.x *= decay; vel.current.y *= decay;
        el.scrollLeft += vel.current.x; el.scrollTop += vel.current.y;
        if (Math.abs(vel.current.x) > 0.1 || Math.abs(vel.current.y) > 0.1) {
          raf.current = requestAnimationFrame(tick);
        } else { raf.current = null; }
      };
      raf.current = requestAnimationFrame(tick);
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove, { passive: true });
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("click", onClickCapture, { capture: true });
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("click", onClickCapture, { capture: true });
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, []);

  // Items for current source that have an image URL and haven't been resolved yet
  const pendingItems = items.filter(item =>
    item.source === source &&
    getImageUrl(item) !== null &&
    !preloadedIds.has(item.id) &&
    !failedIds.has(item.id)
  );

  // Only confirmed-loaded items appear in the canvas — zero loading placeholders
  const filteredItems = items.filter(item =>
    item.source === source && preloadedIds.has(item.id)
  );

  // ── Build tiled grid ──────────────────────────────────────────────────────
  const rows = Math.ceil(filteredItems.length / COLS);
  const tileW = COLS * (CARD_W + GAP_X);
  const tileH = rows * (CARD_H + GAP_Y);
  tileWRef.current = tileW;
  tileHRef.current = tileH;
  const totalW = TILES_X * tileW;
  const totalH = TILES_Y * tileH;

  const tiledCards: { item: SearchResult; x: number; y: number; key: string }[] = [];
  for (let ty = 0; ty < TILES_Y; ty++) {
    for (let tx = 0; tx < TILES_X; tx++) {
      filteredItems.forEach((item, i) => {
        const col = i % COLS;
        const row = Math.floor(i / COLS);
        tiledCards.push({
          item,
          x: tx * tileW + col * (CARD_W + GAP_X),
          y: ty * tileH + row * (CARD_H + GAP_Y),
          key: `${item.id}-${tx}-${ty}`,
        });
      });
    }
  }

  const loadedCount = filteredItems.length;
  const totalCount = items.filter(i => i.source === source && getImageUrl(i) !== null).length;

  return (
    <div className="absolute inset-0">
      <div className="absolute inset-0 bg-[#ebfdff]/85 backdrop-blur-sm pointer-events-none" />

      {/* Hidden preloader — images load here first, canvas only shows confirmed ones */}
      <div className="hidden">
        {pendingItems.map(item => {
          const src = getImageUrl(item)!;
          return (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={item.id} src={src}
              onLoad={() => handleLoad(item.id)}
              onError={() => handleError(item.id)}
            />
          );
        })}
      </div>

      {/* Infinite scroll canvas */}
      <div
        ref={scrollRef}
        className="absolute inset-0 overflow-auto"
        style={{ cursor: "grab", scrollbarWidth: "none", overscrollBehavior: "none" }}
      >
        <style>{`.canvas-wrap::-webkit-scrollbar{display:none}`}</style>
        <div className="canvas-wrap relative" style={{ width: totalW, height: totalH }}>
          {tiledCards.map(({ item, x, y, key }) => (
            <Card key={key} result={item} style={{ width: CARD_W, height: CARD_H, left: x, top: y }} />
          ))}
        </div>
      </div>

      {/* Tab switch */}
      <div className="absolute top-3 right-3 z-30" onPointerDown={(e) => e.stopPropagation()}>
        <div className="flex items-center bg-white/40 backdrop-blur-md border border-white/50 rounded-xl p-1 gap-0.5 shadow-sm">
          <button onClick={() => setSource("chrome")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 ${source === "chrome" ? "bg-white shadow-sm text-[#3d7a64]" : "text-[#3a3a3a]/50 hover:text-[#3a3a3a]/70"}`}>
            <Bookmark className="w-3 h-3" /> Bookmarks
          </button>
          <button onClick={() => setSource("pinterest")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 ${source === "pinterest" ? "bg-white shadow-sm text-[#3d7a64]" : "text-[#3a3a3a]/50 hover:text-[#3a3a3a]/70"}`}>
            <Pin className="w-3 h-3" /> Pinterest
          </button>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 pointer-events-none">
          <div className="w-8 h-8 border-2 border-[#5b9888]/30 border-t-[#5b9888] rounded-full animate-spin" />
          <p className="text-xs text-[#3a3a3a]/40 font-medium tracking-wide">Loading canvas...</p>
        </div>
      )}

      {/* Preloading progress */}
      {!loading && loadedCount < totalCount && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-20 pointer-events-none select-none">
          <p className="text-[10px] text-[#3a3a3a]/25 tracking-widest uppercase">
            Loading {loadedCount} / {totalCount}
          </p>
        </div>
      )}

      {!loading && loadedCount >= totalCount && loadedCount > 0 && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-20 pointer-events-none select-none">
          <p className="text-[10px] text-[#3a3a3a]/25 tracking-widest uppercase">Scroll to explore</p>
        </div>
      )}
    </div>
  );
}
