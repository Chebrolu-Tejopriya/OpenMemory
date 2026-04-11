"use client";

import Image from "next/image";
import { useState, useEffect, useCallback, useRef } from "react";
import { Search, Volume2, VolumeX, Play, Pause, RefreshCw, LayoutGrid } from "lucide-react";
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

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001";

type ActiveView = "search" | "browse";

export default function Home() {
  const [activeView, setActiveView] = useState<ActiveView>("search");
  const [searchQuery, setSearchQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [isPlaying, setIsPlaying] = useState(true);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [folders, setFolders] = useState<string[]>([]);
  const [boards, setBoards] = useState<string[]>([]);
  const [selectedFolder, setSelectedFolder] = useState("");
  const [selectedBoard, setSelectedBoard] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>(() => getRandomSuggestions(4));
  const [suggestionsVisible, setSuggestionsVisible] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
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

  const toggleMute = () => {
    if (videoRef.current) {
      videoRef.current.muted = !videoRef.current.muted;
      setIsMuted(!isMuted);
    }
  };

  const togglePlayPause = () => {
    if (videoRef.current) {
      if (isPlaying) videoRef.current.pause();
      else videoRef.current.play();
      setIsPlaying(!isPlaying);
    }
  };

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

  // When switching to browse, clear search state
  const handleViewSwitch = (view: ActiveView) => {
    setActiveView(view);
    if (view === "browse") {
      setSearchQuery("");
      setResults([]);
      setHasSearched(false);
    }
  };

  return (
    <div className="relative w-full h-screen overflow-hidden bg-[#ebfdff]">

      {/* Video Background */}
      <video
        ref={videoRef}
        className="absolute inset-0 w-full h-full object-cover md:object-fill"
        autoPlay loop muted playsInline
      >
        <source src="/videos/leaf-animation.mp4" type="video/mp4" />
      </video>

      {/* Top Gradient */}
      <div className="hidden sm:block absolute top-[-36px] left-[-35px] w-[1518px] h-[142px] z-10 pointer-events-none">
        <Image src="/images/top-gradient.png" alt="" fill className="object-cover" priority />
      </div>
      <div className="sm:hidden absolute top-0 left-0 right-0 h-20 bg-gradient-to-b from-[#ebfdff]/80 to-transparent z-10 pointer-events-none" />

      {/* ── Top bar: View toggle (left) + Video controls (right) ── */}
      <div className="absolute top-2 sm:top-4 left-2 sm:left-4 right-2 sm:right-4 flex items-center justify-between z-30">

        {/* Search / Browse toggle */}
        <div className={`flex items-center bg-white/40 backdrop-blur-sm border border-[#5b9888]/20 rounded-full p-0.5 gap-0.5 transition-all duration-300 ${hasSearched ? "opacity-0 pointer-events-none" : "opacity-100"}`}>
          <button
            onClick={() => handleViewSwitch("search")}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-all duration-200 ${
              activeView === "search"
                ? "bg-white shadow-sm text-[#3d7a64]"
                : "text-[#3a3a3a]/50 hover:text-[#3a3a3a]/70"
            }`}
          >
            <Search className="w-3 h-3" />
            <span className="hidden sm:inline">Search</span>
          </button>
          <button
            onClick={() => handleViewSwitch("browse")}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-all duration-200 ${
              activeView === "browse"
                ? "bg-white shadow-sm text-[#3d7a64]"
                : "text-[#3a3a3a]/50 hover:text-[#3a3a3a]/70"
            }`}
          >
            <LayoutGrid className="w-3 h-3" />
            <span className="hidden sm:inline">Collections</span>
          </button>
        </div>

        {/* Video Controls */}
        <div className="flex items-center gap-1.5 sm:gap-2">
          <button onClick={toggleMute} className="p-1.5 sm:p-2 rounded-full bg-white/30 hover:bg-white/50 backdrop-blur-sm transition-colors duration-300" aria-label={isMuted ? "Unmute" : "Mute"}>
            {isMuted ? <VolumeX className="w-4 h-4 sm:w-5 sm:h-5 text-[#3a3a3a]" /> : <Volume2 className="w-4 h-4 sm:w-5 sm:h-5 text-[#3a3a3a]" />}
          </button>
          <button onClick={togglePlayPause} className="p-1.5 sm:p-2 rounded-full bg-white/30 hover:bg-white/50 backdrop-blur-sm transition-colors duration-300" aria-label={isPlaying ? "Pause" : "Play"}>
            {isPlaying ? <Pause className="w-4 h-4 sm:w-5 sm:h-5 text-[#3a3a3a]" /> : <Play className="w-4 h-4 sm:w-5 sm:h-5 text-[#3a3a3a]" />}
          </button>
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
          className={`absolute left-1/2 -translate-x-1/2 z-20 px-4 sm:px-0 transition-all duration-500 ease-[cubic-bezier(0.4,0,0.2,1)] ${
            hasSearched
              ? "top-2 sm:top-[12px] w-full sm:w-[90%] max-w-[928px]"
              : "top-[120px] sm:top-[200px] w-full sm:w-[95%] max-w-[836px]"
          }`}
        >
          <form onSubmit={(e) => { e.preventDefault(); performSearch(searchQuery, sourceFilter, selectedFolder, selectedBoard); }} className="w-full">
            <div className={`w-full flex items-center bg-white/[0.38] border-4 border-solid border-[#5b9888] rounded-[13px] transition-all duration-500 ease-out ${hasSearched ? "px-3 sm:px-[10px] py-1.5 sm:py-[5px]" : "px-3 sm:px-[14px] py-2 sm:py-[8px]"}`}>
              <div className="flex items-center gap-2 sm:gap-[10px] flex-1">
                <Search className="w-4 h-4 text-[#646464] flex-shrink-0" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search your inspirations..."
                  className={`flex-1 bg-transparent outline-none placeholder:text-[#3a3a3a]/60 text-[#3a3a3a] transition-all duration-300 ${hasSearched ? "text-sm sm:text-[14px] leading-5 sm:leading-[20px]" : "text-base sm:text-[16px] leading-6 sm:leading-[24px]"}`}
                  style={{ fontFamily: "var(--font-geist), sans-serif" }}
                />
              </div>
            </div>
          </form>

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
                onSourceChange={(s) => { setSourceFilter(s); if (s !== "chrome") setSelectedFolder(""); if (s !== "pinterest") setSelectedBoard(""); }}
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
          BROWSE VIEW
          ══════════════════════════════════════════ */}
      <div
        className={`absolute inset-0 z-10 transition-all duration-500 ease-[cubic-bezier(0.4,0,0.2,1)] ${
          activeView === "browse" ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
      >
        {/* Frosted glass panel behind browse content */}
        <div className="absolute inset-0 bg-[#ebfdff]/80 backdrop-blur-sm" />

        {/* Browse content — scrollable within the viewport */}
        <div className="relative z-10 h-full flex flex-col pt-14 sm:pt-16 pb-4 px-4 sm:px-6 md:px-8 overflow-hidden">
          <div className="flex-1 min-h-0 w-full max-w-[1200px] mx-auto overflow-y-auto custom-scrollbar">
            <BrowseSection folders={folders} boards={boards} constrained />
          </div>
        </div>
      </div>

    </div>
  );
}
