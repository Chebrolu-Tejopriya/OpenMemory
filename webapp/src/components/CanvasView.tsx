"use client";

import { useEffect, useRef, useState } from "react";
import { Bookmark, Pin, ChevronDown } from "lucide-react";
import { SearchResult } from "./SearchResultCard";

type CanvasSource = "chrome" | "pinterest";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001";

const CARD_W = 300;
const CARD_H = 340;
const GAP_X = 28;
const GAP_Y = 28;
const COLS = 4;

// 5×5 tiling gives 4 full tile-widths of scroll range before needing to wrap
const TILES_X = 5;
const TILES_Y = 5;

const MAX_ITEMS = 180;

// Mouse-drag inertia (touch/trackpad use native browser inertia)
const FRICTION_PER_MS = 0.998; // time-based — frame-rate independent

// ── helpers ────────────────────────────────────────────────────────────────
function screenshotUrl(url: string) {
  return `https://v1.screenshot.11ty.dev/${encodeURIComponent(url)}/opengraph/`;
}
function faviconUrl(url: string) {
  try { return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=64`; }
  catch { return ""; }
}
function domain(url: string) {
  try { return new URL(url).hostname.replace("www.", ""); } catch { return ""; }
}

// ── Card ───────────────────────────────────────────────────────────────────
function Card({ result, style }: { result: SearchResult; style: React.CSSProperties }) {
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState(false);
  const isPin = result.source === "pinterest";
  const pinImg = isPin && result.imageUrl && !result.imageUrl.includes("favicon");
  const shot = !isPin ? screenshotUrl(result.url) : null;
  const fav = faviconUrl(result.url);
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
      <div className="px-3 pt-2.5 pb-1 flex-shrink-0">
        <span className="text-[9px] font-semibold uppercase tracking-widest text-gray-400 truncate block">{label}</span>
      </div>
      <div className="px-2.5 pb-2 flex-shrink-0">
        <div className="relative w-full rounded-xl overflow-hidden bg-gray-200" style={{ height: CARD_H - 78 }}>
          {pinImg ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={result.imageUrl!} alt={result.title} className="absolute inset-0 w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-300" />
          ) : (
            <>
              <div className={`absolute inset-0 flex items-center justify-center bg-gradient-to-br from-[#f8fffe] to-[#eef7f4] transition-opacity duration-300 ${loaded && !err ? "opacity-0" : "opacity-100"}`}>
                {fav && (
                  <div className="flex flex-col items-center gap-1.5">
                    <div className="w-10 h-10 rounded-xl bg-white shadow-sm flex items-center justify-center p-2">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={fav} alt="" className="w-full h-full object-contain" />
                    </div>
                    <span className="text-[9px] text-gray-400">{dom}</span>
                  </div>
                )}
              </div>
              {shot && !err && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={shot} alt={result.title}
                  className={`absolute inset-0 w-full h-full object-cover group-hover:scale-[1.03] transition-all duration-500 ${loaded ? "opacity-100" : "opacity-0"}`}
                  onLoad={() => setLoaded(true)} onError={() => setErr(true)} />
              )}
            </>
          )}
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/25 group-hover:backdrop-blur-[2px] transition-all duration-300 flex items-center justify-center">
            <span className="opacity-0 group-hover:opacity-100 transition-opacity duration-200 bg-white/90 text-gray-700 text-[11px] font-semibold px-4 py-1.5 rounded-full">Open</span>
          </div>
        </div>
      </div>
      <div className="px-3 pb-2.5 flex-shrink-0">
        <p className="text-[11px] font-semibold text-gray-700 leading-snug line-clamp-2">{result.title}</p>
        <p className="text-[9px] text-gray-400 mt-0.5 truncate">{dom}</p>
      </div>
    </a>
  );
}

// ── CanvasView ─────────────────────────────────────────────────────────────
interface Props { folders: string[]; boards: string[]; active: boolean }

export default function CanvasView({ folders, boards, active }: Props) {
  const [items, setItems] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const hasFetched = useRef(false);

  // ── Filter state ─────────────────────────────────────────────────────────
  const [source, setSource] = useState<CanvasSource>("chrome");
  const [selectedFolder, setSelectedFolder] = useState<string>("");
  const [selectedBoard, setSelectedBoard] = useState<string>("");
  const [folderOpen, setFolderOpen] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const tileWRef = useRef(0);
  const tileHRef = useRef(0);

  // Mouse drag refs
  const dragging = useRef(false);
  const didDrag = useRef(false);   // true once movement > threshold — suppresses link click
  const dragStart = useRef({ x: 0, y: 0 });
  const lastPtr = useRef({ x: 0, y: 0 });
  const vel = useRef({ x: 0, y: 0 });
  const raf = useRef<number | null>(null);
  const ptrHistory = useRef<{ x: number; y: number; t: number }[]>([]);

  // ── Fetch ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!active || hasFetched.current) return;
    hasFetched.current = true;
    setLoading(true);

    (async () => {
      // Cap each source independently so bookmarks can't starve pinterest items
      const CAP = MAX_ITEMS;
      const bookmarks: SearchResult[] = [];
      const pins: SearchResult[] = [];

      for (const folder of folders) {
        if (bookmarks.length >= CAP) break;
        try {
          const r = await fetch(`${BACKEND_URL}/browse?source=chrome&folder=${encodeURIComponent(folder)}`);
          if (!r.ok) continue;
          const d = await r.json();
          (d.results || []).forEach((item: { title: string; url: string; folder: string | null; source: string; imageUrl: string | null }, i: number) => {
            if (bookmarks.length < CAP) bookmarks.push({ id: `bm-${folder}-${i}`, title: item.title, folder: item.folder || folder, url: item.url, source: "chrome", imageUrl: item.imageUrl || undefined });
          });
        } catch { /* skip */ }
      }

      for (const board of boards) {
        if (pins.length >= CAP) break;
        try {
          const r = await fetch(`${BACKEND_URL}/browse?source=pinterest&board=${encodeURIComponent(board)}`);
          if (!r.ok) continue;
          const d = await r.json();
          (d.results || []).forEach((item: { title: string | null; pin_url: string; board_name: string | null; image_url: string | null }, i: number) => {
            if (pins.length < CAP) pins.push({ id: `pin-${board}-${i}`, title: item.title || "Untitled", folder: item.board_name || board, url: item.pin_url, source: "pinterest", imageUrl: item.image_url || undefined });
          });
        } catch { /* skip */ }
      }

      // Combine and shuffle within each source group
      const all = [...bookmarks, ...pins].sort(() => Math.random() - 0.5);
      setItems(all);
      setLoading(false);
    })();
  }, [active, folders, boards]);

  // ── Scroll to center tile when content mounts ────────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !tileWRef.current || !tileHRef.current) return;
    // Start at tile (2,2) — center of 5×5 grid
    el.scrollLeft = tileWRef.current * 2;
    el.scrollTop = tileHRef.current * 2;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, source, selectedFolder, selectedBoard]);

  // ── Infinite wrap: reset scroll to equivalent center-tile position ───────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onScroll = () => {
      const tw = tileWRef.current;
      const th = tileHRef.current;
      if (!tw || !th) return;
      // Keep scrollLeft in the range [tw, tw*3] — if it drifts outside, jump by one tile
      if (el.scrollLeft >= tw * 3) el.scrollLeft -= tw;
      else if (el.scrollLeft < tw) el.scrollLeft += tw;
      if (el.scrollTop >= th * 3) el.scrollTop -= th;
      else if (el.scrollTop < th) el.scrollTop += th;
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // ── Mouse drag (touch/trackpad use native scroll automatically) ──────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onDown = (e: PointerEvent) => {
      // Only handle mouse — touch/pen get native scroll
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      dragging.current = true;
      didDrag.current = false;
      dragStart.current = { x: e.clientX, y: e.clientY };
      lastPtr.current = { x: e.clientX, y: e.clientY };
      vel.current = { x: 0, y: 0 };
      ptrHistory.current = [{ x: e.clientX, y: e.clientY, t: e.timeStamp }];
      if (raf.current) { cancelAnimationFrame(raf.current); raf.current = null; }
      el.setPointerCapture(e.pointerId);
    };

    const onMove = (e: PointerEvent) => {
      if (!dragging.current || e.pointerType !== "mouse") return;
      // Process all coalesced events for sub-frame accuracy
      const events = (e as PointerEvent & { getCoalescedEvents?(): PointerEvent[] }).getCoalescedEvents?.() ?? [e];
      for (const ev of events) {
        const dx = ev.clientX - lastPtr.current.x;
        const dy = ev.clientY - lastPtr.current.y;
        lastPtr.current = { x: ev.clientX, y: ev.clientY };
        el.scrollLeft -= dx;
        el.scrollTop -= dy;
        ptrHistory.current.push({ x: ev.clientX, y: ev.clientY, t: ev.timeStamp });
      }
      // Crossed threshold → this is a real drag
      if (!didDrag.current) {
        const mx = e.clientX - dragStart.current.x;
        const my = e.clientY - dragStart.current.y;
        if (Math.abs(mx) > 4 || Math.abs(my) > 4) {
          didDrag.current = true;
          el.style.cursor = "grabbing";
        }
      }
      const now = e.timeStamp;
      ptrHistory.current = ptrHistory.current.filter(p => now - p.t < 80);
    };

    // Swallow link/button clicks that followed a drag
    const onClickCapture = (e: MouseEvent) => {
      if (didDrag.current) {
        e.preventDefault();
        e.stopPropagation();
        didDrag.current = false;
      }
    };

    const onUp = (e: PointerEvent) => {
      if (!dragging.current || e.pointerType !== "mouse") return;
      dragging.current = false;
      el.style.cursor = "grab";

      // Derive release velocity from 80ms pointer history
      const h = ptrHistory.current;
      if (h.length >= 2) {
        const oldest = h[0];
        const latest = h[h.length - 1];
        const dt = latest.t - oldest.t;
        if (dt > 0) {
          // Negate because scrollLeft decreases when dragging right
          vel.current.x = -((latest.x - oldest.x) / dt) * 16;
          vel.current.y = -((latest.y - oldest.y) / dt) * 16;
        }
      }

      // Inertia: apply decaying velocity to scrollLeft/scrollTop via RAF
      let lastTime = 0;
      const tick = (now: number) => {
        const dt = lastTime ? Math.min(now - lastTime, 64) : 16;
        lastTime = now;
        const decay = Math.pow(FRICTION_PER_MS, dt);
        vel.current.x *= decay;
        vel.current.y *= decay;
        el.scrollLeft += vel.current.x;
        el.scrollTop += vel.current.y;
        if (Math.abs(vel.current.x) > 0.1 || Math.abs(vel.current.y) > 0.1) {
          raf.current = requestAnimationFrame(tick);
        } else {
          raf.current = null;
        }
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

  // ── Filter items ─────────────────────────────────────────────────────────
  const filteredItems = items.filter((item) => {
    if (item.source !== source) return false;
    if (source === "chrome" && selectedFolder) {
      const itemFolder = item.folder?.split("/").pop() || item.folder || "";
      const filterFolder = selectedFolder.split("/").pop() || selectedFolder;
      return itemFolder === filterFolder;
    }
    if (source === "pinterest" && selectedBoard) {
      return item.folder === selectedBoard;
    }
    return true;
  });

  // ── Build tiled grid ──────────────────────────────────────────────────────
  const rows = Math.ceil(filteredItems.length / COLS);
  const tileW = COLS * (CARD_W + GAP_X);
  const tileH = rows * (CARD_H + GAP_Y);
  // Store in refs for the scroll/wrap handlers
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

  const activeList = source === "chrome" ? folders : boards;
  const activeSelected = source === "chrome" ? selectedFolder : selectedBoard;
  const dropdownOpen = source === "chrome" ? folderOpen : boardOpen;
  const setDropdownOpen = source === "chrome" ? setFolderOpen : setBoardOpen;

  function displayName(path: string) {
    return path.split("/").pop() || path;
  }

  return (
    <div className="absolute inset-0">
      {/* Background */}
      <div className="absolute inset-0 bg-[#ebfdff]/85 backdrop-blur-sm pointer-events-none" />

      {/* ── Native scroll canvas ── */}
      <div
        ref={scrollRef}
        className="absolute inset-0 overflow-auto"
        style={{
          cursor: "grab",
          // Hide scrollbars — navigation is via drag/touch
          scrollbarWidth: "none",
          // Disable overscroll bounce so wrap feels seamless
          overscrollBehavior: "none",
        }}
      >
        {/* Hide webkit scrollbar */}
        <style>{`.hide-scrollbar::-webkit-scrollbar{display:none}`}</style>
        <div
          className="hide-scrollbar relative"
          style={{ width: totalW, height: totalH }}
        >
          {tiledCards.map(({ item, x, y, key }) => (
            <Card
              key={key}
              result={item}
              style={{ width: CARD_W, height: CARD_H, left: x, top: y }}
            />
          ))}
        </div>
      </div>

      {/* ── Top-right filter bar — floats above scroll ── */}
      <div
        className="absolute top-3 right-3 z-30 flex items-center gap-2"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center bg-white/40 backdrop-blur-md border border-white/50 rounded-xl p-1 gap-0.5 shadow-sm">
          <button
            onClick={() => { setSource("chrome"); setFolderOpen(false); setBoardOpen(false); }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 ${
              source === "chrome" ? "bg-white shadow-sm text-[#3d7a64]" : "text-[#3a3a3a]/50 hover:text-[#3a3a3a]/70"
            }`}
          >
            <Bookmark className="w-3 h-3" />
            Bookmarks
          </button>
          <button
            onClick={() => { setSource("pinterest"); setFolderOpen(false); setBoardOpen(false); }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 ${
              source === "pinterest" ? "bg-white shadow-sm text-[#3d7a64]" : "text-[#3a3a3a]/50 hover:text-[#3a3a3a]/70"
            }`}
          >
            <Pin className="w-3 h-3" />
            Pinterest
          </button>
        </div>

        {activeList.length > 0 && (
          <div className="relative">
            <button
              onClick={() => setDropdownOpen(!dropdownOpen)}
              className="flex items-center gap-1.5 px-3 py-2 bg-white/40 backdrop-blur-md border border-white/50 rounded-xl text-xs font-medium text-[#3a3a3a]/70 hover:bg-white/60 transition-all duration-200 shadow-sm max-w-[160px]"
            >
              <span className="truncate">{activeSelected ? displayName(activeSelected) : `All ${source === "chrome" ? "Folders" : "Boards"}`}</span>
              <ChevronDown className={`w-3 h-3 flex-shrink-0 transition-transform duration-200 ${dropdownOpen ? "rotate-180" : ""}`} />
            </button>

            {dropdownOpen && (
              <div className="absolute top-full right-0 mt-1.5 w-52 bg-white/90 backdrop-blur-md border border-[#5b9888]/15 rounded-xl shadow-lg overflow-hidden z-40 max-h-64 overflow-y-auto">
                <button
                  onClick={() => { source === "chrome" ? setSelectedFolder("") : setSelectedBoard(""); setDropdownOpen(false); }}
                  className={`w-full text-left px-3 py-2 text-xs transition-colors ${!activeSelected ? "text-[#3d7a64] font-medium bg-[#5b9888]/8" : "text-[#3a3a3a]/60 hover:bg-[#5b9888]/5"}`}
                >
                  All {source === "chrome" ? "Folders" : "Boards"}
                </button>
                {activeList.map((item) => (
                  <button
                    key={item}
                    onClick={() => { source === "chrome" ? setSelectedFolder(item) : setSelectedBoard(item); setDropdownOpen(false); }}
                    className={`w-full text-left px-3 py-2 text-xs truncate transition-colors ${activeSelected === item ? "text-[#3d7a64] font-medium bg-[#5b9888]/8" : "text-[#3a3a3a]/60 hover:bg-[#5b9888]/5"}`}
                  >
                    {displayName(item)}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Loading */}
      {loading && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 pointer-events-none">
          <div className="w-8 h-8 border-2 border-[#5b9888]/30 border-t-[#5b9888] rounded-full animate-spin" />
          <p className="text-xs text-[#3a3a3a]/40 font-medium tracking-wide">Loading canvas...</p>
        </div>
      )}

      {/* Hint */}
      {!loading && filteredItems.length > 0 && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-20 pointer-events-none select-none">
          <p className="text-[10px] text-[#3a3a3a]/25 tracking-widest uppercase">Drag to explore</p>
        </div>
      )}
    </div>
  );
}
