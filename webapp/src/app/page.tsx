"use client";

import Image from "next/image";
import { useState, useEffect, useCallback, useRef } from "react";
import { Search, RefreshCw, LayoutGrid, X, Bookmark, Hash } from "lucide-react";
import SearchResults from "@/components/SearchResults";
import SearchFilters, { SourceFilter } from "@/components/SearchFilters";
import { SearchResult } from "@/components/SearchResultCard";
import LeafIcon from "@/components/icons/LeafIcon";
import BrowseSection from "@/components/BrowseSection";

const ALL_SUGGESTIONS = [
  "Dashboard UI", "Landing Page", "Login Form", "Contact Form",
  "Pricing Table", "Hero Section", "Navigation Menu", "Card Design",
  "Dark Mode", "Mobile App", "Onboarding Flow", "Settings Page",
  "Finance App", "Fintech", "E-commerce", "Portfolio",
  "SaaS Product", "Analytics", "Minimal Design", "Typography",
  "Color Palette", "Icon Set", "Illustration", "Data Table",
  "Search UI", "Profile Page", "Checkout Flow", "Empty State",
  "Error Page", "Loading State", "Notification", "Modal",
];

function getRandomSuggestions(count = 4): string[] {
  const shuffled = [...ALL_SUGGESTIONS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

function displayName(path: string) {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001";

type ThemeMedia = { type: "video"; src: string } | { type: "image"; src: string };

const THEMES: ThemeMedia[] = [
  { type: "video", src: "/videos/leaf-animation.mp4" },
  { type: "image", src: "/videos/desktop-18.png" },
];

type ActiveView = "search" | "browse";
type MentionType = "folder" | "board" | null;
interface ActiveScope { type: "folder" | "board"; value: string }

export default function Home() {
  const [activeView, setActiveView] = useState<ActiveView>("search");
  const [searchQuery, setSearchQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [themeIndex, setThemeIndex] = useState(0);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [folders, setFolders] = useState<string[]>([]);
  const [boards, setBoards] = useState<string[]>([]);
  const [selectedFolder, setSelectedFolder] = useState("");
  const [selectedBoard, setSelectedBoard] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>(() => getRandomSuggestions(4));
  const [suggestionsVisible, setSuggestionsVisible] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Mention / scope state
  const [mentionType, setMentionType] = useState<MentionType>(null);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionOpen, setMentionOpen] = useState(false);
  const [activeScope, setActiveScope] = useState<ActiveScope | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mentionContainerRef = useRef<HTMLDivElement>(null);
  const userName = "TEJA";

  useEffect(() => {
    const fetchFilters = async () => {
      try {
        const foldersRes = await fetch(`${BACKEND_URL}/folders`);
        if (foldersRes.ok) setFolders((await foldersRes.json()).folders || []);
        const boardsRes = await fetch(`${BACKEND_URL}/boards`);
        if (boardsRes.ok) setBoards((await boardsRes.json()).boards || []);
      } catch (error) {
        console.error("Error fetching filters:", error);
      }
    };
    fetchFilters();
  }, []);

  // Close mention dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (mentionContainerRef.current && !mentionContainerRef.current.contains(e.target as Node)) {
        setMentionOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const switchTheme = (idx: number) => {
    setThemeIndex(idx);
    if (THEMES[idx].type === "video") {
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.load();
          videoRef.current.play();
        }
      }, 0);
    }
  };

  // Detect @ or # trigger in current cursor word
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSearchQuery(value);

    const cursor = e.target.selectionStart ?? value.length;
    const before = value.slice(0, cursor);

    const atMatch = before.match(/@(\S*)$/);
    const hashMatch = before.match(/#(\S*)$/);

    if (atMatch) {
      setMentionType("folder");
      setMentionQuery(atMatch[1]);
      setMentionOpen(true);
    } else if (hashMatch) {
      setMentionType("board");
      setMentionQuery(hashMatch[1]);
      setMentionOpen(true);
    } else {
      setMentionOpen(false);
      setMentionType(null);
      setMentionQuery("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setMentionOpen(false);
    }
  };

  // User picks a folder or board from the dropdown
  const handleScopeSelect = (item: string) => {
    // Strip the @... or #... trigger from the query
    const trigger = mentionType === "folder" ? "@" : "#";
    const cleaned = searchQuery.replace(new RegExp(`${trigger}\\S*`), "").trim();
    setSearchQuery(cleaned);

    const type = mentionType!;
    if (type === "folder") {
      setSelectedFolder(item);
      setSelectedBoard("");
      setSourceFilter("chrome");
    } else {
      setSelectedBoard(item);
      setSelectedFolder("");
      setSourceFilter("pinterest");
    }
    setActiveScope({ type, value: item });
    setMentionOpen(false);
    setMentionType(null);
    setMentionQuery("");
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  // Clear the active scope chip
  const clearScope = () => {
    setActiveScope(null);
    setSelectedFolder("");
    setSelectedBoard("");
    setSourceFilter("all");
    inputRef.current?.focus();
  };

  // Filtered mention list
  const mentionList = mentionType === "folder"
    ? folders.filter(f => displayName(f).toLowerCase().includes(mentionQuery.toLowerCase()))
    : boards.filter(b => b.toLowerCase().includes(mentionQuery.toLowerCase()));

  const performSearch = useCallback(
    async (query: string, source: SourceFilter, folder?: string, board?: string) => {
      if (query.length < 2) {
        setResults([]);
        setHasSearched(false);
        return;
      }
      setIsLoading(true);
      setHasSearched(true);
      try {
        const params = new URLSearchParams({ q: query, limit: "100", offset: "0" });
        if (source !== "all") params.set("source", source === "chrome" ? "chrome_bookmarks" : source);
        if (folder) params.set("folder", folder);
        if (board) params.set("board", board);
        const res = await fetch(`${BACKEND_URL}/search?${params.toString()}`);
        if (!res.ok) throw new Error("Search failed");
        const data = await res.json();
        setResults(
          data.results.map(
            (item: { title: string; url: string; folder: string | null; source: string; imageUrl: string | null }, i: number) => ({
              id: `${i}-${item.url}`,
              title: item.title,
              folder: item.folder || "Bookmarks",
              url: item.url,
              source: item.source.includes("chrome") ? "chrome" : "pinterest",
              imageUrl: item.imageUrl || undefined,
            })
          )
        );
      } catch {
        setResults([]);
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchQuery) performSearch(searchQuery, sourceFilter, selectedFolder, selectedBoard);
      else { setResults([]); setHasSearched(false); }
    }, 350);
    return () => clearTimeout(timer);
  }, [searchQuery, sourceFilter, selectedFolder, selectedBoard, performSearch]);

  // When switching to collections, clear search state
  const handleViewSwitch = (view: ActiveView) => {
    setActiveView(view);
    if (view === "browse") {
      setSearchQuery("");
      setResults([]);
      setHasSearched(false);
      setMentionOpen(false);
    }
  };

  return (
    <div className="relative w-full h-screen overflow-hidden bg-[#ebfdff]">

      {/* Background — video or image depending on active theme */}
      {THEMES[themeIndex].type === "video" ? (
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover md:object-fill"
          autoPlay loop muted playsInline
        >
          <source src={THEMES[themeIndex].src} type="video/mp4" />
        </video>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={THEMES[themeIndex].src}
          alt=""
          className="absolute inset-0 w-full h-full object-cover md:object-fill"
        />
      )}

      {/* Top Gradient */}
      <div className="hidden sm:block absolute top-[-36px] left-[-35px] w-[1518px] h-[142px] z-10 pointer-events-none">
        <Image src="/images/top-gradient.png" alt="" fill className="object-cover" priority />
      </div>
      <div className="sm:hidden absolute top-0 left-0 right-0 h-20 bg-gradient-to-b from-[#ebfdff]/80 to-transparent z-10 pointer-events-none" />

      {/* ── Theme toggle (top-right) ── */}
      <div className="absolute top-3 sm:top-4 right-3 sm:right-4 z-30 pointer-events-auto">
        <div className="flex items-center gap-1 p-1 bg-white/30 backdrop-blur-md border border-white/40 rounded-full shadow-sm">
          {THEMES.map((_, idx) => (
            <button
              key={idx}
              onClick={() => switchTheme(idx)}
              aria-label={`Theme ${idx + 1}`}
              className={`w-6 h-6 rounded-full flex items-center justify-center transition-all duration-200 ${
                themeIndex === idx
                  ? "bg-[#3d7a64] shadow-sm shadow-[#3d7a64]/30"
                  : "hover:bg-white/50"
              }`}
            >
              <span
                className={`block rounded-full transition-all duration-200 ${
                  videoIndex === idx ? "w-2 h-2 bg-white" : "w-1.5 h-1.5 bg-[#3a3a3a]/30"
                }`}
              />
            </button>
          ))}
        </div>
      </div>

      {/* ══════════════════════════════════════════
          SEARCH VIEW
          ══════════════════════════════════════════ */}
      <div
        className={`absolute inset-0 transition-all duration-500 ease-[cubic-bezier(0.4,0,0.2,1)] ${
          activeView === "search" ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
      >
        {/* Greeting */}
        <p
          className={`absolute top-2 sm:top-[7px] left-1/2 -translate-x-1/2 font-semibold text-xl sm:text-[33px] tracking-[4px] sm:tracking-[6.27px] whitespace-nowrap text-center z-20 transition-all duration-500 ease-out ${
            hasSearched ? "opacity-0 -translate-y-4 pointer-events-none" : "opacity-100 translate-y-0"
          }`}
          style={{ fontFamily: "var(--font-baloo-bhai-2), sans-serif", color: "rgba(44, 127, 87, 0.4)" }}
        >
          HI, {userName}
        </p>

        {/* Headline */}
        <div
          className={`absolute left-1/2 -translate-x-1/2 top-[65px] sm:top-[130px] flex flex-col items-center justify-center p-2 sm:p-[10px] z-10 transition-all duration-500 ease-out ${
            hasSearched ? "opacity-0 -translate-y-8 pointer-events-none" : "opacity-100 translate-y-0"
          }`}
        >
          <div className="flex items-center justify-center gap-2 sm:gap-[10px]">
            <h1 className="gradient-text font-semibold text-xl sm:text-[36px] text-center whitespace-nowrap" style={{ fontFamily: "var(--font-baloo-2), sans-serif" }}>
              Find what inspires you
            </h1>
            <LeafIcon className="w-5 h-5 sm:w-[30px] sm:h-[30px]" />
          </div>
        </div>

        {/* Search Bar */}
        <div
          ref={mentionContainerRef}
          className={`absolute left-1/2 -translate-x-1/2 z-20 px-4 sm:px-0 transition-all duration-500 ease-[cubic-bezier(0.4,0,0.2,1)] ${
            hasSearched
              ? "top-2 sm:top-[12px] w-full sm:w-[90%] max-w-[928px]"
              : "top-[120px] sm:top-[200px] w-full sm:w-[95%] max-w-[836px]"
          }`}
        >
          <form onSubmit={(e) => { e.preventDefault(); performSearch(searchQuery, sourceFilter, selectedFolder, selectedBoard); }} className="w-full">
            <div className={`w-full flex items-center bg-white/[0.38] border-4 border-solid border-[#5b9888] rounded-[13px] transition-all duration-500 ease-out ${hasSearched ? "px-3 sm:px-[10px] py-1.5 sm:py-[5px]" : "px-3 sm:px-[14px] py-2 sm:py-[8px]"}`}>
              <div className="flex items-center gap-2 sm:gap-[10px] flex-1 min-w-0">
                <Search className="w-4 h-4 text-[#646464] flex-shrink-0" />

                {/* Active scope chip — folder or board */}
                {activeScope && (
                  <div className="flex items-center gap-1 bg-[#5b9888]/15 border border-[#5b9888]/30 rounded-full px-2 py-0.5 flex-shrink-0">
                    {activeScope.type === "folder"
                      ? <Bookmark className="w-2.5 h-2.5 text-[#3d7a64]" />
                      : <Hash className="w-2.5 h-2.5 text-[#3d7a64]" />
                    }
                    <span className="text-[11px] font-medium text-[#3d7a64] max-w-[120px] truncate">
                      {displayName(activeScope.value)}
                    </span>
                    <button
                      type="button"
                      onClick={clearScope}
                      className="text-[#3d7a64]/60 hover:text-[#3d7a64] transition-colors"
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </div>
                )}

                <input
                  ref={inputRef}
                  type="text"
                  value={searchQuery}
                  onChange={handleInputChange}
                  onKeyDown={handleKeyDown}
                  placeholder={activeScope ? "Search within..." : "Search... or @ folders, # boards"}
                  className={`flex-1 min-w-0 bg-transparent outline-none placeholder:text-[#3a3a3a]/60 text-[#3a3a3a] transition-all duration-300 ${hasSearched ? "text-sm sm:text-[14px] leading-5 sm:leading-[20px]" : "text-base sm:text-[16px] leading-6 sm:leading-[24px]"}`}
                  style={{ fontFamily: "var(--font-geist), sans-serif" }}
                />
              </div>
            </div>
          </form>

          {/* Mention dropdown */}
          {mentionOpen && mentionList.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-2 bg-white/90 backdrop-blur-md rounded-xl shadow-lg border border-[#5b9888]/20 overflow-hidden z-30 max-h-52 overflow-y-auto custom-scrollbar">
              <div className="px-3 py-1.5 border-b border-[#5b9888]/10">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-[#3a3a3a]/40">
                  {mentionType === "folder" ? "Bookmark Folders" : "Pinterest Boards"}
                </p>
              </div>
              {mentionList.map((item) => (
                <button
                  key={item}
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); handleScopeSelect(item); }}
                  className="w-full text-left px-3 py-2 flex items-center gap-2.5 hover:bg-[#5b9888]/8 transition-colors duration-100 group"
                >
                  {mentionType === "folder"
                    ? <Bookmark className="w-3 h-3 text-[#5b9888]/50 group-hover:text-[#5b9888] flex-shrink-0 transition-colors" />
                    : <Hash className="w-3 h-3 text-[#5b9888]/50 group-hover:text-[#5b9888] flex-shrink-0 transition-colors" />
                  }
                  <span className="text-sm text-[#3a3a3a]/80 group-hover:text-[#3a3a3a] truncate transition-colors">
                    {displayName(item)}
                  </span>
                  {item !== displayName(item) && (
                    <span className="text-[10px] text-[#3a3a3a]/30 truncate ml-auto flex-shrink-0">
                      {item}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* No matches hint */}
          {mentionOpen && mentionList.length === 0 && mentionQuery.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-2 bg-white/90 backdrop-blur-md rounded-xl shadow-lg border border-[#5b9888]/20 z-30 px-4 py-3">
              <p className="text-xs text-[#3a3a3a]/40">
                No {mentionType === "folder" ? "folders" : "boards"} matching &quot;{mentionQuery}&quot;
              </p>
            </div>
          )}

          {/* Suggestion chips */}
          <div className={`flex flex-col items-center gap-2 mt-3 transition-all duration-500 ease-out ${hasSearched ? "opacity-0 pointer-events-none" : "opacity-100"}`}>
            <div className={`flex items-center justify-center gap-2 flex-wrap transition-all duration-300 ease-in-out ${suggestionsVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1"}`}>
              {suggestions.map((s) => (
                <button key={s} onClick={() => { setSearchQuery(s); performSearch(s, sourceFilter, selectedFolder, selectedBoard); }}
                  className="flex items-center px-3 py-1.5 rounded-full bg-white/50 backdrop-blur-sm border border-[#5b9888]/20 text-[11px] sm:text-xs text-[#3a3a3a]/70 hover:bg-white/80 hover:text-[#5b9888] hover:border-[#5b9888]/50 transition-all duration-200 whitespace-nowrap shadow-sm">
                  {s}
                </button>
              ))}
              <button
                onClick={() => {
                  if (isRefreshing) return;
                  setIsRefreshing(true); setSuggestionsVisible(false);
                  setTimeout(() => { setSuggestions(getRandomSuggestions(4)); setSuggestionsVisible(true); setIsRefreshing(false); }, 300);
                }}
                className="p-1.5 rounded-full bg-white/50 backdrop-blur-sm border border-[#5b9888]/20 text-[#3a3a3a]/40 hover:text-[#5b9888] hover:bg-white/80 hover:border-[#5b9888]/50 transition-all duration-200 shadow-sm"
              >
                <RefreshCw className={`w-3 h-3 sm:w-3.5 sm:h-3.5 transition-transform duration-300 ${isRefreshing ? "rotate-180" : "rotate-0"}`} />
              </button>
            </div>
          </div>
        </div>

        {/* Search Results overlay */}
        <div
          className={`absolute inset-x-0 bottom-0 z-20 px-3 sm:px-4 md:px-0 transition-all duration-500 ease-[cubic-bezier(0.4,0,0.2,1)] ${
            hasSearched ? "top-[56px] sm:top-[60px] opacity-100 translate-y-0" : "top-full opacity-0 pointer-events-none"
          }`}
        >
          <div className="w-full md:w-[95%] max-w-[1200px] mx-auto flex flex-col gap-3 sm:gap-4 h-full">
            <div className="relative z-20 flex-shrink-0">
              <SearchFilters
                activeSource={sourceFilter}
                onSourceChange={(s) => { setSourceFilter(s); if (s !== "chrome") { setSelectedFolder(""); if (activeScope?.type === "folder") setActiveScope(null); } if (s !== "pinterest") { setSelectedBoard(""); if (activeScope?.type === "board") setActiveScope(null); } }}
                resultCount={results.length}
                folders={folders}
                boards={boards}
                selectedFolder={selectedFolder}
                selectedBoard={selectedBoard}
                onFolderChange={setSelectedFolder}
                onBoardChange={setSelectedBoard}
              />
            </div>
            <div className="relative z-10 flex-1 overflow-y-auto custom-scrollbar pb-4">
              <SearchResults results={results} isLoading={isLoading} />
            </div>
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════
          COLLECTIONS VIEW
          ══════════════════════════════════════════ */}
      <div
        className={`absolute inset-0 z-10 transition-all duration-500 ease-[cubic-bezier(0.4,0,0.2,1)] ${
          activeView === "browse" ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
      >
        {/* Frosted glass panel */}
        <div className="absolute inset-0 bg-[#ebfdff]/80 backdrop-blur-sm" />

        {/* Collections content */}
        <div className="relative z-10 h-full flex flex-col pt-14 sm:pt-16 pb-4 px-4 sm:px-6 md:px-8 overflow-hidden">
          <div className="flex-1 min-h-0 w-full max-w-[1200px] mx-auto overflow-y-auto custom-scrollbar">
            <BrowseSection folders={folders} boards={boards} constrained />
          </div>
        </div>
      </div>

      {/* ── Bottom dock — Search / Collections tab switch ── */}
      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-40 pointer-events-auto">
        <div className="flex items-center gap-2 p-1.5 bg-white/30 backdrop-blur-md border border-white/40 rounded-2xl shadow-lg shadow-black/10">
          <button
            onClick={() => handleViewSwitch("search")}
            aria-label="Search"
            className={`p-3 rounded-xl transition-all duration-200 ${
              activeView === "search"
                ? "bg-[#3d7a64] text-white shadow-md shadow-[#3d7a64]/30"
                : "text-[#3a3a3a]/40 hover:text-[#3d7a64] hover:bg-white/60"
            }`}
          >
            <Search className="w-5 h-5" />
          </button>
          <button
            onClick={() => handleViewSwitch("browse")}
            aria-label="Collections"
            className={`p-3 rounded-xl transition-all duration-200 ${
              activeView === "browse"
                ? "bg-[#3d7a64] text-white shadow-md shadow-[#3d7a64]/30"
                : "text-[#3a3a3a]/40 hover:text-[#3d7a64] hover:bg-white/60"
            }`}
          >
            <LayoutGrid className="w-5 h-5" />
          </button>
        </div>
      </div>

    </div>
  );
}
