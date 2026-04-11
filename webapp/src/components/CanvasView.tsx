"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Bookmark, Pin, ChevronDown } from "lucide-react";
import { SearchResult } from "./SearchResultCard";

type CanvasSource = "chrome" | "pinterest";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001";

const CARD_W = 300;
const CARD_H = 340;
const GAP_X = 28;
const GAP_Y = 28;
const COLS = 4;

// Tile 3×3 so the canvas feels infinite — wrap seamlessly when hitting edges
const TILES_X = 3;
const TILES_Y = 3;

const FRICTION = 0.97;       // higher = longer glide
const VEL_SMOOTH = 0.55;     // EMA alpha — lower = smoother velocity
const MIN_VEL = 0.05;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2.5;
const MAX_ITEMS = 180;       // cap total to keep DOM lean

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
      onPointerDown={(e) => e.stopPropagation()}
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

  // ── Filter state ──────────────────────────────────────────────────────────
  const [source, setSource] = useState<CanvasSource>("chrome");
  const [selectedFolder, setSelectedFolder] = useState<string>("");
  const [selectedBoard, setSelectedBoard] = useState<string>("");
  const [folderOpen, setFolderOpen] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);

  // Set default folder/board when folders/boards arrive
  useEffect(() => {
    if (folders.length && !selectedFolder) setSelectedFolder("");
  }, [folders, selectedFolder]);
  useEffect(() => {
    if (boards.length && !selectedBoard) setSelectedBoard("");
  }, [boards, selectedBoard]);

  const containerRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);

  // Pan / zoom — all in refs so RAF never triggers re-render
  const pan = useRef({ x: 0, y: 0 });
  const vel = useRef({ x: 0, y: 0 });
  const zoom = useRef(1);
  const dragging = useRef(false);
  const lastPtr = useRef({ x: 0, y: 0 });
  const raf = useRef<number | null>(null);

  // Grid metrics (derived from items, stored in refs to avoid closure staleness)
  const gridW = useRef(0);
  const gridH = useRef(0);

  // ── Fetch ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!active || hasFetched.current) return;
    hasFetched.current = true;
    setLoading(true);

    (async () => {
      const all: SearchResult[] = [];

      for (const folder of folders) {
        if (all.length >= MAX_ITEMS) break;
        try {
          const r = await fetch(`${BACKEND_URL}/browse?source=chrome&folder=${encodeURIComponent(folder)}`);
          if (!r.ok) continue;
          const d = await r.json();
          (d.results || []).forEach((item: { title: string; url: string; folder: string | null; source: string; imageUrl: string | null }, i: number) => {
            if (all.length < MAX_ITEMS) all.push({ id: `bm-${folder}-${i}`, title: item.title, folder: item.folder || folder, url: item.url, source: "chrome", imageUrl: item.imageUrl || undefined });
          });
        } catch { /* skip */ }
      }

      for (const board of boards) {
        if (all.length >= MAX_ITEMS) break;
        try {
          const r = await fetch(`${BACKEND_URL}/browse?source=pinterest&board=${encodeURIComponent(board)}`);
          if (!r.ok) continue;
          const d = await r.json();
          (d.results || []).forEach((item: { title: string | null; pin_url: string; board_name: string | null; image_url: string | null }, i: number) => {
            if (all.length < MAX_ITEMS) all.push({ id: `pin-${board}-${i}`, title: item.title || "Untitled", folder: item.board_name || board, url: item.pin_url, source: "pinterest", imageUrl: item.image_url || undefined });
          });
        } catch { /* skip */ }
      }

      // Shuffle so bookmarks + pinterest interleave
      all.sort(() => Math.random() - 0.5);
      setItems(all);
      setLoading(false);
    })();
  }, [active, folders, boards]);

  // ── Grid metrics + initial pan ───────────────────────────────────────────
  useEffect(() => {
    if (!items.length || !containerRef.current) return;
    const rows = Math.ceil(items.length / COLS);
    gridW.current = COLS * (CARD_W + GAP_X) - GAP_X;
    gridH.current = rows * (CARD_H + GAP_Y) - GAP_Y;

    const cw = containerRef.current.clientWidth;
    const ch = containerRef.current.clientHeight;

    // Center the middle tile in the viewport
    pan.current = {
      x: cw / 2 - (TILES_X * gridW.current) / 2 - gridW.current / 2 + gridW.current,
      y: ch / 2 - (TILES_Y * gridH.current) / 2 - gridH.current / 2 + gridH.current,
    };
    applyTransform();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  // ── Transform ────────────────────────────────────────────────────────────
  const applyTransform = useCallback(() => {
    if (!layerRef.current) return;
    layerRef.current.style.transform =
      `translate3d(${pan.current.x}px,${pan.current.y}px,0) scale(${zoom.current})`;
  }, []);

  // ── Seamless wrap — keep pan within one tile range ───────────────────────
  const wrapPan = useCallback(() => {
    const gw = gridW.current;
    const gh = gridH.current;
    if (!gw || !gh) return;
    // Wrap X
    if (pan.current.x > gw) pan.current.x -= gw;
    else if (pan.current.x < -gw) pan.current.x += gw;
    // Wrap Y
    if (pan.current.y > gh) pan.current.y -= gh;
    else if (pan.current.y < -gh) pan.current.y += gh;
  }, []);

  // ── Inertia tick ─────────────────────────────────────────────────────────
  const tick = useCallback(() => {
    vel.current.x *= FRICTION;
    vel.current.y *= FRICTION;
    if (Math.abs(vel.current.x) < MIN_VEL && Math.abs(vel.current.y) < MIN_VEL) {
      raf.current = null;
      return;
    }
    pan.current.x += vel.current.x;
    pan.current.y += vel.current.y;
    wrapPan();
    applyTransform();
    raf.current = requestAnimationFrame(tick);
  }, [applyTransform, wrapPan]);

  // ── Pointer ──────────────────────────────────────────────────────────────
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    dragging.current = true;
    lastPtr.current = { x: e.clientX, y: e.clientY };
    vel.current = { x: 0, y: 0 };
    if (raf.current) { cancelAnimationFrame(raf.current); raf.current = null; }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (containerRef.current) containerRef.current.style.cursor = "grabbing";
    if (layerRef.current) layerRef.current.style.pointerEvents = "none";
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const dx = e.clientX - lastPtr.current.x;
    const dy = e.clientY - lastPtr.current.y;
    lastPtr.current = { x: e.clientX, y: e.clientY };
    pan.current.x += dx;
    pan.current.y += dy;
    // EMA smoothing: blend new delta into running velocity to reduce jitter
    vel.current.x = vel.current.x * VEL_SMOOTH + dx * (1 - VEL_SMOOTH);
    vel.current.y = vel.current.y * VEL_SMOOTH + dy * (1 - VEL_SMOOTH);
    wrapPan();
    applyTransform();
  }, [applyTransform, wrapPan]);

  const onPointerUp = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    if (containerRef.current) containerRef.current.style.cursor = "grab";
    if (layerRef.current) layerRef.current.style.pointerEvents = "";
    raf.current = requestAnimationFrame(tick);
  }, [tick]);

  // ── Wheel zoom ───────────────────────────────────────────────────────────
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const prev = zoom.current;
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, prev * (1 - e.deltaY * 0.001)));
    const s = next / prev;
    pan.current.x = mx - s * (mx - pan.current.x);
    pan.current.y = my - s * (my - pan.current.y);
    zoom.current = next;
    applyTransform();
  }, [applyTransform]);

  useEffect(() => () => { if (raf.current) cancelAnimationFrame(raf.current); }, []);

  // ── Filter items by source + folder/board ────────────────────────────────
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

  // ── Build tiled positions ─────────────────────────────────────────────────
  const rows = Math.ceil(filteredItems.length / COLS);
  const tileW = COLS * (CARD_W + GAP_X);
  const tileH = rows * (CARD_H + GAP_Y);
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
    <div
      ref={containerRef}
      className="absolute inset-0 overflow-hidden"
      style={{ cursor: "grab", touchAction: "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      onWheel={onWheel}
    >
      {/* Background */}
      <div className="absolute inset-0 bg-[#ebfdff]/85 backdrop-blur-sm" />

      {/* ── Top-right filter bar ── */}
      <div
        className="absolute top-3 right-3 z-30 flex items-center gap-2 pointer-events-auto"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* Source tab switch */}
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

        {/* Folder / Board dropdown */}
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
              <div className="absolute top-full right-0 mt-1.5 w-52 bg-white/90 backdrop-blur-md border border-[#5b9888]/15 rounded-xl shadow-lg overflow-hidden z-40 max-h-64 overflow-y-auto custom-scrollbar">
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
          <p className="text-[10px] text-[#3a3a3a]/25 tracking-widest uppercase">Drag to explore · scroll to zoom</p>
        </div>
      )}

      {/* Pan layer — tiled 3×3 */}
      <div
        ref={layerRef}
        className="absolute top-0 left-0"
        style={{ width: totalW, height: totalH, transformOrigin: "0 0", willChange: "transform" }}
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
  );
}
