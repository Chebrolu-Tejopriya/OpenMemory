"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Bookmark, Pin, FolderOpen } from "lucide-react";
import SearchResultCard, { SearchResult } from "./SearchResultCard";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001";

type BrowseTab = "bookmarks" | "pinterest";

interface BrowseSectionProps {
  folders: string[];
  boards: string[];
  constrained?: boolean;
  active?: boolean;
}

export default function BrowseSection({ folders, boards, constrained = false, active = true }: BrowseSectionProps) {
  const [activeTab, setActiveTab] = useState<BrowseTab>("bookmarks");
  const [selectedItem, setSelectedItem] = useState<string>("");
  const [cards, setCards] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const chipRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    const raw = activeTab === "bookmarks" ? folders : boards;
    const sorted = raw.slice().sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    if (sorted.length > 0) setSelectedItem(sorted[0]);
    else { setSelectedItem(""); setCards([]); }
  }, [activeTab, folders, boards]);

  // Scroll active chip into view on mobile
  useEffect(() => {
    if (selectedItem && chipRefs.current[selectedItem]) {
      chipRefs.current[selectedItem]?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
  }, [selectedItem]);

  const fetchCards = useCallback(async (item: string) => {
    if (!item) return;
    setIsLoading(true);
    try {
      const source = activeTab === "bookmarks" ? "chrome" : "pinterest";
      const paramKey = activeTab === "bookmarks" ? "folder" : "board";
      const res = await fetch(`${BACKEND_URL}/browse?source=${source}&${paramKey}=${encodeURIComponent(item)}`);
      if (!res.ok) throw new Error("Browse failed");
      const data = await res.json();
      setCards(
        data.results.map((r: { title: string; url: string; folder: string | null; source: string; imageUrl: string | null }, i: number) => ({
          id: `browse-${i}-${r.url}`,
          title: r.title,
          folder: r.folder || item,
          url: r.url,
          source: r.source.includes("chrome") ? "chrome" : "pinterest",
          imageUrl: r.imageUrl || undefined,
        }))
      );
    } catch {
      setCards([]);
    } finally {
      setIsLoading(false);
    }
  }, [activeTab]);

  // Fetch when selected item changes (user clicks a different folder/board)
  useEffect(() => {
    if (selectedItem) fetchCards(selectedItem);
  }, [selectedItem, fetchCards]);

  // Re-fetch when Collections tab is opened (active toggled true)
  useEffect(() => {
    if (active && selectedItem) fetchCards(selectedItem);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const list = (activeTab === "bookmarks" ? folders : boards)
    .slice()
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  function displayName(path: string) {
    const parts = path.split("/");
    return parts[parts.length - 1] || path;
  }

  const skeletonCards = (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
      {[...Array(6)].map((_, i) => (
        <div key={i} className="flex flex-col bg-[#f4f4f4] rounded-2xl overflow-hidden animate-pulse">
          <div className="px-3 pt-3 pb-1 h-7 flex items-center">
            <div className="h-2.5 w-20 bg-gray-300/60 rounded-full" />
          </div>
          <div className="px-3 pb-2">
            <div className="w-full aspect-square rounded-xl bg-gray-300/50" />
          </div>
          <div className="px-3 pb-3 space-y-1.5">
            <div className="h-3 bg-gray-300/50 rounded w-full" />
            <div className="h-2.5 bg-gray-300/40 rounded w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );

  const tabSwitch = (
    <div className="flex bg-white/60 backdrop-blur-sm border border-[#5b9888]/20 rounded-xl p-1 gap-1">
      {(["bookmarks", "pinterest"] as BrowseTab[]).map((tab) => (
        <button
          key={tab}
          onClick={() => setActiveTab(tab)}
          className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 ${
            activeTab === tab ? "bg-white shadow-sm text-[#3a3a3a]" : "text-[#3a3a3a]/50 hover:text-[#3a3a3a]/70"
          }`}
        >
          {tab === "bookmarks" ? <Bookmark className="w-3 h-3" /> : <Pin className="w-3 h-3" />}
          {tab === "bookmarks" ? "Bookmarks" : "Pinterest"}
        </button>
      ))}
    </div>
  );

  return (
    <div className={`flex flex-col gap-4 ${constrained ? "h-full" : ""}`}>
      {/* Section header */}
      <div className="flex items-center gap-2">
        <FolderOpen className="w-4 h-4 text-[#5b9888]/60" />
        <h2 className="text-sm font-semibold tracking-wide text-[#3a3a3a]/50 uppercase" style={{ fontFamily: "var(--font-geist), sans-serif" }}>
          Collections
        </h2>
      </div>

      {/* ── MOBILE layout (< md) ── */}
      <div className="md:hidden">
        {/* Sticky tab switch — stays visible while scrolling */}
        <div className="sticky top-0 z-10 -mx-4 px-4 pt-1 pb-3 bg-[#ebfdff]/95 backdrop-blur-sm">
          {tabSwitch}
        </div>

        {/* Horizontally scrollable folder/board chips — scrolls naturally */}
        <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar mt-1">
          {list.length === 0 ? (
            <p className="text-xs text-[#3a3a3a]/30 px-2 py-2">No {activeTab === "bookmarks" ? "folders" : "boards"} found</p>
          ) : list.map((item) => (
            <button
              key={item}
              ref={(el) => { chipRefs.current[item] = el; }}
              onClick={() => setSelectedItem(item)}
              className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-150 whitespace-nowrap ${
                selectedItem === item
                  ? "bg-[#5b9888] text-white shadow-sm"
                  : "bg-white/70 text-[#3a3a3a]/60 border border-[#5b9888]/15 hover:bg-white hover:text-[#3a3a3a]/80"
              }`}
            >
              {displayName(item)}
            </button>
          ))}
        </div>

        {/* Cards */}
        <div className="mt-3">
          {isLoading ? skeletonCards : cards.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-sm text-[#3a3a3a]/30">No items found</div>
          ) : (
            <div className="grid grid-cols-2 gap-3 pb-24 items-start">
              {cards.map((card, i) => <SearchResultCard key={card.id} result={card} revealDelay={Math.min(i, 5) * 60} />)}
            </div>
          )}
        </div>
      </div>

      {/* ── DESKTOP layout (≥ md) ── */}
      <div className={`hidden md:flex gap-6 ${constrained ? "flex-1 min-h-0" : ""}`}>
        {/* Left panel — sticky when not constrained, flex when constrained */}
        <div className={`w-52 shrink-0 flex flex-col gap-2 ${constrained ? "self-stretch" : "sticky top-6 self-start"}`}>
          {tabSwitch}

          {/* Folder/board list */}
          <div className={`flex flex-col gap-0.5 overflow-y-auto custom-scrollbar pr-1 ${constrained ? "flex-1" : "max-h-[70vh]"}`}>
            {list.length === 0 ? (
              <p className="text-xs text-[#3a3a3a]/30 px-2 py-3 text-center">
                No {activeTab === "bookmarks" ? "folders" : "boards"} found
              </p>
            ) : list.map((item) => (
              <button
                key={item}
                onClick={() => setSelectedItem(item)}
                title={item}
                className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-all duration-150 ${
                  selectedItem === item
                    ? "bg-white shadow-sm text-[#3d7a64] font-medium"
                    : "text-[#3a3a3a]/60 hover:bg-white/60 hover:text-[#3a3a3a]/80"
                }`}
              >
                <span className="truncate block">{displayName(item)}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Right panel — cards */}
        <div className={`flex-1 min-w-0 ${constrained ? "overflow-y-auto custom-scrollbar" : ""}`}>
          {isLoading ? skeletonCards : cards.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-sm text-[#3a3a3a]/30">No items found</div>
          ) : (
            <div className="grid grid-cols-3 gap-3 pb-2 items-start">
              {cards.map((card, i) => <SearchResultCard key={card.id} result={card} revealDelay={Math.min(i, 5) * 60} />)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
