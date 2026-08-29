"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Bookmark, Pin, FolderOpen, Search, X } from "lucide-react";
import SearchResultCard, { SearchResult } from "./SearchResultCard";
import { FluidNav } from "./FluidNav";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001";

type BrowseTab = "bookmarks" | "pinterest";

interface BrowseSectionProps {
  folders: string[];
  boards: string[];
  loading?: boolean;
  constrained?: boolean;
  active?: boolean;
}

export default function BrowseSection({ folders, boards, loading = false, constrained = false, active = true }: BrowseSectionProps) {
  const [activeTab, setActiveTab] = useState<BrowseTab>("bookmarks");
  const [selectedItem, setSelectedItem] = useState<string>("");
  const [cards, setCards] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  // Which result folder the user drilled into, "" = show every match
  const [searchFolder, setSearchFolder] = useState("");
  const chipRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    const raw = activeTab === "bookmarks" ? folders : boards;
    const sorted = raw.slice().sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    setQuery("");
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

  // Fetch when selected item or active state changes
  useEffect(() => {
    if (selectedItem && active) fetchCards(selectedItem);
  }, [selectedItem, fetchCards, active]);

  // Content search across every collection in the active tab. The sidebar then
  // narrows to just the folders that produced matches.
  useEffect(() => {
    const trimmed = query.trim();
    if (!active || trimmed.length < 2) {
      setSearchResults(null);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: trimmed, limit: "100" });
        params.set("source", activeTab === "bookmarks" ? "chrome_bookmarks" : "pinterest");
        const res = await fetch(`${BACKEND_URL}/search?${params.toString()}`);
        if (!res.ok) throw new Error("Search failed");
        const data = await res.json();
        setSearchResults(
          data.results.map((r: { title: string; url: string; folder: string | null; source: string; imageUrl: string | null }, i: number) => ({
            id: `csearch-${i}-${r.url}`,
            title: r.title,
            folder: r.folder || "",
            url: r.url,
            source: r.source.includes("chrome") ? "chrome" : "pinterest",
            imageUrl: r.imageUrl || undefined,
          }))
        );
      } catch {
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [query, activeTab, active]);

  // A new query invalidates whichever result folder was drilled into
  useEffect(() => { setSearchFolder(""); }, [query, activeTab]);

  const list = (activeTab === "bookmarks" ? folders : boards)
    .slice()
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  function displayName(path: string) {
    const parts = path.split("/");
    return parts[parts.length - 1] || path;
  }

  const skeletonChips = (
    <div className="flex gap-2">
      {[80, 64, 96, 72].map((w, i) => (
        <div key={i} className={`h-7 rounded-full bg-black/[0.07] animate-pulse shrink-0`} style={{ width: w }} />
      ))}
    </div>
  );

  const skeletonList = (
    <div className="flex flex-col gap-1 px-1">
      {["w-full", "w-4/5", "w-full", "w-3/4", "w-5/6"].map((w, i) => (
        <div key={i} className={`h-8 rounded-lg bg-black/6 animate-pulse ${w}`} />
      ))}
    </div>
  );

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

  const tabItems = [
    { key: "bookmarks", label: "Bookmarks", icon: <Bookmark className="w-3 h-3" /> },
    { key: "pinterest", label: "Pinterest", icon: <Pin className="w-3 h-3" /> },
  ];

  const tabSwitch = (
    <div className="bg-white/60 backdrop-blur-sm border border-[#5b9888]/20 rounded-xl p-1">
      <FluidNav
        items={tabItems}
        selectedKey={activeTab}
        onSelect={(key) => setActiveTab(key as BrowseTab)}
        orientation="horizontal"
        selectedColor="#3a3a3a"
        selectedBg="bg-white shadow-sm"
        hoverBg="bg-black/[0.04]"
        className="gap-1"
        itemClassName="flex-1 justify-center py-1.5 px-2 text-xs font-medium"
      />
    </div>
  );

  // >= 2 chars puts the panel into search mode; below that it browses.
  const isSearchMode = query.trim().length >= 2;
  const searchLoading = isSearching || searchResults === null;

  // Folders that actually produced matches — this is the sidebar during a search
  const resultFolders = !isSearchMode || !searchResults
    ? []
    : Array.from(new Set(searchResults.map((r) => r.folder).filter(Boolean)))
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  const visibleResults = !searchResults
    ? []
    : searchFolder
      ? searchResults.filter((r) => r.folder === searchFolder)
      : searchResults;

  // While searching, "" is a real row ("All results") so there is a way back
  // to the full match set without clearing the query.
  const navItems = isSearchMode
    ? [
        { key: "", label: `All results (${searchResults?.length ?? 0})` },
        ...resultFolders.map((f) => ({ key: f, label: displayName(f) })),
      ]
    : list.map((item) => ({ key: item, label: displayName(item) }));
  const sidebarSelected = isSearchMode ? searchFolder : selectedItem;
  const sidebarLoading = loading || (isSearchMode && searchLoading);
  const onSidebarSelect = isSearchMode ? setSearchFolder : setSelectedItem;

  const panelCards = isSearchMode ? visibleResults : cards;
  const panelLoading = isSearchMode ? searchLoading : isLoading || !selectedItem;

  const searchBox = (
    <div className="relative">
      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 z-10 w-3.5 h-3.5 text-[#3a3a3a]/45 pointer-events-none" />
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") setQuery(""); }}
        placeholder={activeTab === "bookmarks" ? "Search bookmarks" : "Search pins"}
        aria-label={activeTab === "bookmarks" ? "Search bookmarks" : "Search pins"}
        className="w-full bg-white/60 backdrop-blur-sm border border-[#5b9888]/20 rounded-xl pl-8 pr-7 py-1.5 text-xs text-[#3a3a3a] placeholder:text-[#3a3a3a]/30 outline-none transition-colors focus:border-[#5b9888]/45 focus:bg-white/80"
      />
      {query && (
        <button
          onClick={() => setQuery("")}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 z-10 text-[#3a3a3a]/45 hover:text-[#3a3a3a]/75 transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
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
          {loading ? skeletonChips : list.length === 0 ? (
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
          {isLoading || !selectedItem ? skeletonCards : cards.length === 0 ? (
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
          {searchBox}

          {/* Folder/board list */}
          <div className={`overflow-y-auto custom-scrollbar pr-1 ${constrained ? "flex-1" : "max-h-[70vh]"}`}>
            {sidebarLoading ? skeletonList : navItems.length === 0 ? (
              <p className="text-xs text-[#3a3a3a]/30 px-2 py-3 text-center break-words">
                {isSearchMode
                  ? `No matches for "${query.trim()}"`
                  : `No ${activeTab === "bookmarks" ? "folders" : "boards"} found`}
              </p>
            ) : (
              <FluidNav
                items={navItems}
                selectedKey={sidebarSelected}
                onSelect={onSidebarSelect}
                orientation="vertical"
                selectedColor="#3d7a64"
                selectedBg="bg-white shadow-sm"
                hoverBg="bg-white/60"
                itemClassName="w-full px-3 py-2 text-xs"
              />
            )}
          </div>
        </div>

        {/* Right panel — cards */}
        <div className={`flex-1 min-w-0 ${constrained ? "overflow-y-auto custom-scrollbar" : ""}`}>
          {isSearchMode && !panelLoading && panelCards.length > 0 && (
            <p className="text-xs text-[#3a3a3a]/40 px-1 pb-2">
              {panelCards.length} {panelCards.length === 1 ? "result" : "results"}
              {searchFolder ? (
                <> in <span className="text-[#3d7a64]/70 font-medium">{displayName(searchFolder)}</span></>
              ) : (
                <> across {resultFolders.length} {resultFolders.length === 1 ? (activeTab === "bookmarks" ? "folder" : "board") : (activeTab === "bookmarks" ? "folders" : "boards")}</>
              )}
            </p>
          )}
          {panelLoading ? skeletonCards : panelCards.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-sm text-[#3a3a3a]/30">
              {isSearchMode ? `No results for "${query.trim()}"` : "No items found"}
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-3 pb-2 items-start">
              {panelCards.map((card, i) => <SearchResultCard key={card.id} result={card} revealDelay={Math.min(i, 5) * 60} />)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
