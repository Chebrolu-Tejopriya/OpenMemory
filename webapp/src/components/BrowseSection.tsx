"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { LayoutGrid, List, FolderOpen, Search, X } from "lucide-react";
import SearchResultCard, { SearchResult } from "./SearchResultCard";
import CollectionSourceSelect from "./CollectionSourceSelect";
import XPostFeed from "./XPostFeed";
import { FluidNav } from "./FluidNav";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001";

type BrowseTab = "bookmarks" | "pinterest" | "x";

interface BrowseSectionProps {
  folders: string[];
  boards: string[];
  loading?: boolean;
  constrained?: boolean;
  active?: boolean;
}

export default function BrowseSection({ folders, boards, loading = false, constrained = false, active = true }: BrowseSectionProps) {
  const [activeTab, setActiveTab] = useState<BrowseTab>("bookmarks");
  const [xLayout, setXLayout] = useState<"grid" | "feed">("feed");
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
    const raw = activeTab === "x" ? ["X bookmarks"] : activeTab === "bookmarks" ? folders : boards;
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

  const fetchCards = useCallback(async (item: string, signal: AbortSignal) => {
    if (!item) return;
    setIsLoading(true);
    try {
      const source = activeTab === "x" ? "x" : activeTab === "bookmarks" ? "chrome" : "pinterest";
      const paramKey = activeTab === "bookmarks" ? "folder" : "board";
      const res = await fetch(`${BACKEND_URL}/browse?source=${source}&${paramKey}=${encodeURIComponent(item)}`, { signal });
      if (!res.ok) throw new Error("Browse failed");
      const data = await res.json();
      if (signal.aborted) return;
      setCards(
        data.results.map((r: { title: string; url: string; folder: string | null; source: string; imageUrl: string | null; description?: string; author?: string }, i: number) => ({
          id: `browse-${i}-${r.url}`,
          title: r.title,
          folder: r.folder || item,
          url: r.url,
          source: r.source === "x" ? "x" : r.source.includes("chrome") ? "chrome" : "pinterest",
          imageUrl: r.imageUrl || undefined,
          description: r.description,
          author: r.author,
        }))
      );
    } catch {
      if (!signal.aborted) setCards([]);
    } finally {
      if (!signal.aborted) setIsLoading(false);
    }
  }, [activeTab]);

  // Fetch when selected item or active state changes
  useEffect(() => {
    const controller = new AbortController();
    if (selectedItem && active) fetchCards(selectedItem, controller.signal);
    return () => controller.abort();
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
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: trimmed, limit: "100" });
        params.set("source", activeTab === "x" ? "x" : activeTab === "bookmarks" ? "chrome_bookmarks" : "pinterest");
        const res = await fetch(`${BACKEND_URL}/search?${params.toString()}`, { signal: controller.signal });
        if (!res.ok) throw new Error("Search failed");
        const data = await res.json();
        if (controller.signal.aborted) return;
        setSearchResults(
          data.results.map((r: { title: string; url: string; folder: string | null; source: string; imageUrl: string | null; description?: string; author?: string }, i: number) => ({
            id: `csearch-${i}-${r.url}`,
            title: r.title,
            folder: r.folder || "",
            url: r.url,
            source: r.source === "x" ? "x" : r.source.includes("chrome") ? "chrome" : "pinterest",
            imageUrl: r.imageUrl || undefined,
            description: r.description,
            author: r.author,
          }))
        );
      } catch {
        if (!controller.signal.aborted) setSearchResults([]);
      } finally {
        if (!controller.signal.aborted) setIsSearching(false);
      }
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, activeTab, active]);

  // A new query invalidates whichever result folder was drilled into
  useEffect(() => { setSearchFolder(""); }, [query, activeTab]);

  const list = (activeTab === "x" ? ["X bookmarks"] : activeTab === "bookmarks" ? folders : boards)
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

  function changeSource(value: BrowseTab) {
    setActiveTab(value);
    setQuery("");
    setCards([]);
    setSearchResults(null);
    setSearchFolder("");
  }

  const tabSwitch = <CollectionSourceSelect value={activeTab} onChange={changeSource} />;

  const layoutSwitch = activeTab === "x" && (
    <div className="mb-3 flex justify-end gap-1" role="group" aria-label="X layout">
      {(["feed", "grid"] as const).map(layout => (
        <button key={layout} onClick={() => setXLayout(layout)} aria-pressed={xLayout === layout}
          className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs transition-colors ${xLayout === layout ? "bg-white text-[#303c37] shadow-sm" : "text-[#65746d] hover:bg-white/60"}`}>
          {layout === "feed" ? <List className="h-4 w-4" /> : <LayoutGrid className="h-4 w-4" />}
          {layout === "feed" ? "Feed" : "Grid"}
        </button>
      ))}
    </div>
  );
  function renderCards(results: SearchResult[], mobile = false) {
    // A shared library can contain the same post saved by multiple accounts.
    const seen = new Set<string>();
    const unique = results.filter(card => {
      if (card.source !== "x") return true;
      const key = card.url.match(/\/status\/(\d+)/)?.[1] || card.url;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const feed = activeTab === "x" && xLayout === "feed";
    return <div className={feed ? "mx-auto flex w-full max-w-[600px] flex-col gap-4 pb-12" : `grid ${mobile ? "grid-cols-2 pb-24" : "grid-cols-3 pb-2"} gap-3 items-start`}>
      {unique.map((card, i) => feed ? <XPostFeed key={card.url} result={card} /> : <SearchResultCard key={card.id} result={card} revealDelay={Math.min(i, 5) * 60} />)}
    </div>;
  }

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
        placeholder={activeTab === "x" ? "Search X bookmarks" : activeTab === "bookmarks" ? "Search bookmarks" : "Search pins"}
        aria-label={activeTab === "x" ? "Search X bookmarks" : activeTab === "bookmarks" ? "Search bookmarks" : "Search pins"}
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
          {layoutSwitch}
          {isLoading || !selectedItem ? skeletonCards : cards.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-sm text-[#3a3a3a]/30">No items found</div>
          ) : (
            renderCards(cards, true)
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
          {layoutSwitch}
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
            renderCards(panelCards)
          )}
        </div>
      </div>
    </div>
  );
}
