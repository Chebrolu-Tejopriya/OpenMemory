"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { SearchResult } from "./SearchResultCard";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001";

// Card dimensions on the canvas
const CARD_W = 220;
const CARD_H = 260;
const GAP_X = 28;
const GAP_Y = 28;
const COLS = 6;

// Inertia / zoom config
const FRICTION = 0.88;
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 2.2;
const ZOOM_SPEED = 0.001;

function getScreenshotUrl(url: string) {
  return `https://v1.screenshot.11ty.dev/${encodeURIComponent(url)}/opengraph/`;
}

function getFaviconUrl(url: string) {
  try {
    return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=64`;
  } catch { return ""; }
}

function getDomain(url: string) {
  try { return new URL(url).hostname.replace("www.", ""); } catch { return ""; }
}

// ── Single card rendered on the canvas ──────────────────────────────────────
function CanvasCard({ result, style }: { result: SearchResult; style: React.CSSProperties }) {
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError, setImgError] = useState(false);
  const isPinterest = result.source === "pinterest";
  const hasPinImg = isPinterest && result.imageUrl && !result.imageUrl.includes("favicon");
  const screenshotUrl = !isPinterest ? getScreenshotUrl(result.url) : null;
  const faviconUrl = getFaviconUrl(result.url);
  const domain = getDomain(result.url);
  const category = result.folder && result.folder !== "Bookmarks"
    ? result.folder.split("/").pop() || result.folder
    : domain;

  return (
    <a
      href={result.url}
      target="_blank"
      rel="noopener noreferrer"
      style={style}
      className="absolute group flex flex-col bg-[#f4f4f4] rounded-2xl overflow-hidden transition-shadow duration-200 hover:shadow-xl"
      // Stop pointer events from bubbling to the pan layer during drag
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* Category */}
      <div className="px-3 pt-2.5 pb-1 flex-shrink-0">
        <span className="text-[9px] font-semibold uppercase tracking-widest text-gray-400 truncate block">
          {category}
        </span>
      </div>

      {/* Image */}
      <div className="px-2.5 pb-2 flex-shrink-0">
        <div className="relative w-full rounded-xl overflow-hidden bg-gray-200" style={{ height: CARD_H - 80 }}>
          {hasPinImg ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={result.imageUrl!} alt={result.title} className="absolute inset-0 w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-300" />
          ) : (
            <>
              <div className={`absolute inset-0 flex items-center justify-center bg-gradient-to-br from-[#f8fffe] to-[#eef7f4] transition-opacity duration-300 ${imgLoaded && !imgError ? "opacity-0" : "opacity-100"}`}>
                {faviconUrl && (
                  <div className="flex flex-col items-center gap-1.5">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <div className="w-10 h-10 rounded-xl bg-white shadow-sm flex items-center justify-center p-2">
                      <img src={faviconUrl} alt="" className="w-full h-full object-contain" />
                    </div>
                    <span className="text-[9px] text-gray-400">{domain}</span>
                  </div>
                )}
              </div>
              {screenshotUrl && !imgError && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={screenshotUrl}
                  alt={result.title}
                  className={`absolute inset-0 w-full h-full object-cover group-hover:scale-[1.03] transition-all duration-500 ${imgLoaded ? "opacity-100" : "opacity-0"}`}
                  onLoad={() => setImgLoaded(true)}
                  onError={() => setImgError(true)}
                />
              )}
            </>
          )}

          {/* Hover overlay */}
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/25 group-hover:backdrop-blur-[2px] transition-all duration-300 flex items-center justify-center">
            <span className="opacity-0 group-hover:opacity-100 transition-opacity duration-200 bg-white/90 text-gray-700 text-[11px] font-semibold px-4 py-1.5 rounded-full shadow-sm">
              Open
            </span>
          </div>
        </div>
      </div>

      {/* Title */}
      <div className="px-3 pb-2.5 flex-shrink-0">
        <p className="text-[11px] font-semibold text-gray-700 leading-snug line-clamp-2">{result.title}</p>
        <p className="text-[9px] text-gray-400 mt-0.5 truncate">{domain}</p>
      </div>
    </a>
  );
}

// ── Main CanvasView ──────────────────────────────────────────────────────────
interface CanvasViewProps {
  folders: string[];
  boards: string[];
  active: boolean;
}

export default function CanvasView({ folders, boards, active }: CanvasViewProps) {
  const [items, setItems] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Pan / zoom state — stored in refs so RAF loop doesn't need re-renders
  const panRef = useRef({ x: 0, y: 0 });
  const velRef = useRef({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  const isDragging = useRef(false);
  const lastPointer = useRef({ x: 0, y: 0 });
  const rafId = useRef<number | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hasFetched = useRef(false);

  // ── Fetch all items once when first activated ──────────────────────────────
  useEffect(() => {
    if (!active || hasFetched.current) return;
    hasFetched.current = true;

    const fetchAll = async () => {
      setIsLoading(true);
      const all: SearchResult[] = [];
      try {
        // Bookmarks
        for (const folder of folders.slice(0, 20)) {
          const res = await fetch(`${BACKEND_URL}/browse?source=chrome&folder=${encodeURIComponent(folder)}`);
          if (!res.ok) continue;
          const data = await res.json();
          all.push(...(data.results || []).map((r: { title: string; url: string; folder: string | null; source: string; imageUrl: string | null }, i: number) => ({
            id: `canvas-bm-${folder}-${i}`,
            title: r.title,
            folder: r.folder || folder,
            url: r.url,
            source: "chrome" as const,
            imageUrl: r.imageUrl || undefined,
          })));
        }
        // Pinterest
        for (const board of boards.slice(0, 20)) {
          const res = await fetch(`${BACKEND_URL}/browse?source=pinterest&board=${encodeURIComponent(board)}`);
          if (!res.ok) continue;
          const data = await res.json();
          all.push(...(data.results || []).map((r: { title: string | null; pin_url: string; board_name: string | null; source: string; image_url: string | null }, i: number) => ({
            id: `canvas-pin-${board}-${i}`,
            title: r.title || "Untitled",
            folder: r.board_name || board,
            url: r.pin_url,
            source: "pinterest" as const,
            imageUrl: r.image_url || undefined,
          })));
        }
      } catch (e) {
        console.error("[CanvasView] fetch error", e);
      }
      // Shuffle so bookmarks + pinterest are interleaved
      all.sort(() => Math.random() - 0.5);
      setItems(all);
      setIsLoading(false);
    };

    fetchAll();
  }, [active, folders, boards]);

  // ── Center canvas on mount ─────────────────────────────────────────────────
  useEffect(() => {
    if (!active || !containerRef.current) return;
    const { width, height } = containerRef.current.getBoundingClientRect();
    const totalW = COLS * (CARD_W + GAP_X);
    const rows = Math.ceil(items.length / COLS);
    const totalH = rows * (CARD_H + GAP_Y);
    panRef.current = {
      x: (width - totalW) / 2,
      y: (height - totalH) / 2,
    };
    applyTransform();
  }, [active, items.length]);

  // ── Apply CSS transform ────────────────────────────────────────────────────
  const applyTransform = useCallback(() => {
    if (!layerRef.current) return;
    const { x, y } = panRef.current;
    const z = zoomRef.current;
    layerRef.current.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${z})`;
  }, []);

  // ── Inertia loop ───────────────────────────────────────────────────────────
  const tick = useCallback(() => {
    const vel = velRef.current;
    if (Math.abs(vel.x) < 0.1 && Math.abs(vel.y) < 0.1) {
      rafId.current = null;
      return;
    }
    panRef.current.x += vel.x;
    panRef.current.y += vel.y;
    vel.x *= FRICTION;
    vel.y *= FRICTION;
    applyTransform();
    rafId.current = requestAnimationFrame(tick);
  }, [applyTransform]);

  // ── Pointer handlers ───────────────────────────────────────────────────────
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    isDragging.current = true;
    lastPointer.current = { x: e.clientX, y: e.clientY };
    velRef.current = { x: 0, y: 0 };
    if (rafId.current) { cancelAnimationFrame(rafId.current); rafId.current = null; }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging.current) return;
    const dx = e.clientX - lastPointer.current.x;
    const dy = e.clientY - lastPointer.current.y;
    lastPointer.current = { x: e.clientX, y: e.clientY };
    panRef.current.x += dx;
    panRef.current.y += dy;
    velRef.current = { x: dx, y: dy };
    applyTransform();
  }, [applyTransform]);

  const onPointerUp = useCallback(() => {
    if (!isDragging.current) return;
    isDragging.current = false;
    rafId.current = requestAnimationFrame(tick);
  }, [tick]);

  // ── Wheel zoom ─────────────────────────────────────────────────────────────
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const prevZoom = zoomRef.current;
    const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, prevZoom * (1 - e.deltaY * ZOOM_SPEED * 10)));
    const scale = newZoom / prevZoom;

    // Zoom toward cursor
    panRef.current.x = mouseX - scale * (mouseX - panRef.current.x);
    panRef.current.y = mouseY - scale * (mouseY - panRef.current.y);
    zoomRef.current = newZoom;
    applyTransform();
  }, [applyTransform]);

  // Cleanup RAF on unmount
  useEffect(() => () => { if (rafId.current) cancelAnimationFrame(rafId.current); }, []);

  // ── Card positions ─────────────────────────────────────────────────────────
  const cardPositions = items.map((_, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    return {
      left: col * (CARD_W + GAP_X),
      top: row * (CARD_H + GAP_Y),
    };
  });

  const canvasW = COLS * (CARD_W + GAP_X) - GAP_X;
  const canvasH = Math.ceil(items.length / COLS) * (CARD_H + GAP_Y) - GAP_Y;

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 overflow-hidden"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      onWheel={onWheel}
      style={{ cursor: isDragging.current ? "grabbing" : "grab", touchAction: "none" }}
    >
      {/* Frosted background */}
      <div className="absolute inset-0 bg-[#ebfdff]/85 backdrop-blur-sm" />

      {/* Loading */}
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center z-20 pointer-events-none">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-[#5b9888]/30 border-t-[#5b9888] rounded-full animate-spin" />
            <p className="text-xs text-[#3a3a3a]/50 font-medium">Loading your canvas...</p>
          </div>
        </div>
      )}

      {/* Hint */}
      {!isLoading && items.length > 0 && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
          <p className="text-[10px] text-[#3a3a3a]/30 tracking-wide">Drag to explore · scroll to zoom</p>
        </div>
      )}

      {/* Pan layer */}
      <div
        ref={layerRef}
        className="absolute"
        style={{
          width: canvasW,
          height: canvasH,
          transformOrigin: "0 0",
          willChange: "transform",
        }}
      >
        {items.map((item, i) => (
          <CanvasCard
            key={item.id}
            result={item}
            style={{
              width: CARD_W,
              height: CARD_H,
              left: cardPositions[i].left,
              top: cardPositions[i].top,
            }}
          />
        ))}
      </div>
    </div>
  );
}
