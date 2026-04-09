"use client";

import Image from "next/image";
import { useState, useEffect, useCallback, useRef } from "react";
import { Search, Volume2, VolumeX, Play, Pause, RefreshCw } from "lucide-react";

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
import SearchResults from "@/components/SearchResults";
import SearchFilters, { SourceFilter } from "@/components/SearchFilters";
import { SearchResult } from "@/components/SearchResultCard";
import LeafIcon from "@/components/icons/LeafIcon";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001";

export default function Home() {
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

  // Fetch folders and boards on mount
  useEffect(() => {
    const fetchFilters = async () => {
      try {
        // Fetch folders from Supabase
        const foldersRes = await fetch(`${BACKEND_URL}/folders`);
        if (foldersRes.ok) {
          const data = await foldersRes.json();
          setFolders(data.folders || []);
        }

        // Fetch Pinterest boards from Supabase
        const boardsRes = await fetch(`${BACKEND_URL}/boards`);
        if (boardsRes.ok) {
          const data = await boardsRes.json();
          setBoards(data.boards || []);
        }
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
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        videoRef.current.play();
      }
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
        const params = new URLSearchParams({
          q: query,
          limit: "100",
          offset: "0",
        });

        if (source !== "all") {
          const sourceValue = source === "chrome" ? "chrome_bookmarks" : source;
          params.set("source", sourceValue);
        }

        if (folder) {
          params.set("folder", folder);
        }

        if (board) {
          params.set("board", board);
        }

        const searchResponse = await fetch(
          `${BACKEND_URL}/search?${params.toString()}`
        );

        if (!searchResponse.ok) {
          throw new Error("Search request failed");
        }

        const data = await searchResponse.json();

        const mappedResults: SearchResult[] = data.results.map(
          (
            item: {
              title: string;
              url: string;
              folder: string | null;
              source: string;
              imageUrl: string | null;
            },
            index: number
          ) => ({
            id: `${index}-${item.url}`,
            title: item.title,
            folder: item.folder || "Bookmarks",
            url: item.url,
            source: item.source.includes("chrome") ? "chrome" : "pinterest",
            imageUrl: item.imageUrl || undefined,
          })
        );

        setResults(mappedResults);
      } catch (error) {
        console.error("Search error:", error);
        setResults([]);
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchQuery) {
        performSearch(searchQuery, sourceFilter, selectedFolder, selectedBoard);
      } else {
        setResults([]);
        setHasSearched(false);
      }
    }, 350);

    return () => clearTimeout(timer);
  }, [searchQuery, sourceFilter, selectedFolder, selectedBoard, performSearch]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    performSearch(searchQuery, sourceFilter, selectedFolder, selectedBoard);
  };

  const handleSourceChange = (source: SourceFilter) => {
    setSourceFilter(source);
    // Reset folder/board when changing source
    if (source !== "chrome") setSelectedFolder("");
    if (source !== "pinterest") setSelectedBoard("");
  };

  const handleFolderChange = (folder: string) => {
    setSelectedFolder(folder);
  };

  const handleBoardChange = (board: string) => {
    setSelectedBoard(board);
  };

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-[#ebfdff]">
      {/* Video Background */}
      <video
        ref={videoRef}
        className="absolute inset-0 w-full h-full object-cover md:object-fill"
        autoPlay
        loop
        muted
        playsInline
      >
        <source src="/videos/leaf-animation.mp4" type="video/mp4" />
      </video>

      {/* Video Controls - Top Right */}
      <div className="absolute top-2 right-2 sm:top-4 sm:right-4 flex items-center gap-1.5 sm:gap-2 z-30">
        <button
          onClick={toggleMute}
          className="p-1.5 sm:p-2 rounded-full bg-white/30 hover:bg-white/50 backdrop-blur-sm transition-colors duration-300"
          aria-label={isMuted ? "Unmute" : "Mute"}
        >
          {isMuted ? (
            <VolumeX className="w-4 h-4 sm:w-5 sm:h-5 text-[#3a3a3a]" />
          ) : (
            <Volume2 className="w-4 h-4 sm:w-5 sm:h-5 text-[#3a3a3a]" />
          )}
        </button>
        <button
          onClick={togglePlayPause}
          className="p-1.5 sm:p-2 rounded-full bg-white/30 hover:bg-white/50 backdrop-blur-sm transition-colors duration-300"
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? (
            <Pause className="w-4 h-4 sm:w-5 sm:h-5 text-[#3a3a3a]" />
          ) : (
            <Play className="w-4 h-4 sm:w-5 sm:h-5 text-[#3a3a3a]" />
          )}
        </button>
      </div>

      {/* Top Gradient Frame - Hidden on mobile */}
      <div className="hidden sm:block absolute top-[-36px] left-[-35px] w-[1518px] h-[142px] z-10 pointer-events-none">
        <Image
          src="/images/top-gradient.png"
          alt=""
          fill
          className="object-cover"
          priority
        />
      </div>

      {/* Mobile top gradient overlay */}
      <div className="sm:hidden absolute top-0 left-0 right-0 h-20 bg-gradient-to-b from-[#ebfdff]/80 to-transparent z-10 pointer-events-none" />

      {/* Greeting - HI, TEJA (fades out when searching) */}
      <p
        className={`absolute top-2 sm:top-[7px] left-1/2 -translate-x-1/2 font-semibold text-xl sm:text-[33px] tracking-[4px] sm:tracking-[6.27px] whitespace-nowrap text-center z-20 transition-all duration-500 ease-out ${
          hasSearched
            ? "opacity-0 -translate-y-4 pointer-events-none"
            : "opacity-100 translate-y-0"
        }`}
        style={{
          fontFamily: "var(--font-baloo-bhai-2), sans-serif",
          color: "rgba(44, 127, 87, 0.4)",
        }}
      >
        HI, {userName}
      </p>

      {/* Search Bar - Moves to top when searching */}
      <div
        className={`absolute left-1/2 -translate-x-1/2 z-20 px-4 sm:px-0 transition-all duration-500 ease-[cubic-bezier(0.4,0,0.2,1)] ${
          hasSearched
            ? "top-2 sm:top-[12px] w-full sm:w-[90%] max-w-[600px]"
            : "top-[120px] sm:top-[200px] w-full sm:w-[95%] max-w-[700px]"
        }`}
      >
        <form onSubmit={handleSearch} className="w-full">
          <div
            className={`w-full flex items-center bg-white/[0.38] border-4 border-solid border-[#5b9888] rounded-[13px] transition-all duration-500 ease-out ${
              hasSearched
                ? "px-3 sm:px-[10px] py-1.5 sm:py-[5px]"
                : "px-3 sm:px-[14px] py-2 sm:py-[8px]"
            }`}
          >
            <div className="flex items-center gap-2 sm:gap-[10px] flex-1">
              <Search
                className={`transition-all duration-300 flex-shrink-0 ${
                  hasSearched
                    ? "w-4 h-4 text-[#646464]"
                    : "w-4 h-4 sm:w-[16px] sm:h-[16px] text-[#646464]"
                }`}
              />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search your inspirations..."
                className={`flex-1 bg-transparent outline-none placeholder:text-[#3a3a3a]/60 text-[#3a3a3a] transition-all duration-300 ${
                  hasSearched
                    ? "text-sm sm:text-[14px] leading-5 sm:leading-[20px]"
                    : "text-base sm:text-[16px] leading-6 sm:leading-[24px]"
                }`}
                style={{ fontFamily: "var(--font-geist), sans-serif" }}
              />
            </div>
          </div>
        </form>

        {/* Search Recommendations - shown below search bar when not searching */}
        <div
          className={`flex flex-col items-center gap-2 mt-3 transition-all duration-500 ease-out ${
            hasSearched ? "opacity-0 pointer-events-none" : "opacity-100"
          }`}
        >
          {/* Chips row */}
          <div
            className={`flex items-center justify-center gap-2 flex-wrap transition-all duration-300 ease-in-out ${
              suggestionsVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1"
            }`}
          >
            {suggestions.map((s) => (
              <button
                key={s}
                onClick={() => {
                  setSearchQuery(s);
                  performSearch(s, sourceFilter, selectedFolder, selectedBoard);
                }}
                className="flex items-center px-3 py-1.5 rounded-full bg-white/50 backdrop-blur-sm border border-[#5b9888]/20 text-[11px] sm:text-xs text-[#3a3a3a]/70 hover:bg-white/80 hover:text-[#5b9888] hover:border-[#5b9888]/50 transition-all duration-200 whitespace-nowrap shadow-sm"
              >
                {s}
              </button>
            ))}
          </div>

          {/* Refresh button — centered below chips */}
          <button
            onClick={() => {
              if (isRefreshing) return;
              setIsRefreshing(true);
              setSuggestionsVisible(false);
              setTimeout(() => {
                setSuggestions(getRandomSuggestions(4));
                setSuggestionsVisible(true);
                setIsRefreshing(false);
              }, 300);
            }}
            className="p-1.5 rounded-full bg-white/50 backdrop-blur-sm border border-[#5b9888]/20 text-[#3a3a3a]/40 hover:text-[#5b9888] hover:bg-white/80 hover:border-[#5b9888]/50 transition-all duration-200 shadow-sm"
            title="Refresh suggestions"
          >
            <RefreshCw
              className={`w-3 h-3 sm:w-3.5 sm:h-3.5 transition-transform duration-300 ${
                isRefreshing ? "rotate-180" : "rotate-0"
              }`}
            />
          </button>
        </div>
      </div>

      {/* Headline - Fades out when searching */}
      <div
        className={`absolute left-1/2 -translate-x-1/2 top-[65px] sm:top-[130px] flex flex-col items-center justify-center p-2 sm:p-[10px] z-10 transition-all duration-500 ease-out ${
          hasSearched
            ? "opacity-0 -translate-y-8 pointer-events-none"
            : "opacity-100 translate-y-0"
        }`}
      >
        <div className="flex items-center justify-center gap-2 sm:gap-[10px]">
          <h1
            className="gradient-text font-semibold text-xl sm:text-[36px] text-center whitespace-nowrap"
            style={{ fontFamily: "var(--font-baloo-2), sans-serif" }}
          >
            Find what inspires you
          </h1>
          <LeafIcon className="w-5 h-5 sm:w-[30px] sm:h-[30px]" />
        </div>
      </div>

      {/* Results Section - Slides up smoothly */}
      <div
        className={`absolute left-1/2 -translate-x-1/2 w-full px-3 sm:px-4 md:px-0 md:w-[95%] max-w-[1200px] z-10 transition-all duration-500 ease-[cubic-bezier(0.4,0,0.2,1)] ${
          hasSearched
            ? "top-14 sm:top-[70px] opacity-100 translate-y-0"
            : "top-[300px] opacity-0 translate-y-8 pointer-events-none"
        }`}
      >
        <div className="w-full flex flex-col gap-3 sm:gap-4">
          {/* Filters */}
          <div className="relative z-20">
            <SearchFilters
              activeSource={sourceFilter}
              onSourceChange={handleSourceChange}
              resultCount={results.length}
              folders={folders}
              boards={boards}
              selectedFolder={selectedFolder}
              selectedBoard={selectedBoard}
              onFolderChange={handleFolderChange}
              onBoardChange={handleBoardChange}
            />
          </div>

          {/* Scrollable Results Container */}
          <div
            className="relative z-10 w-full overflow-y-auto custom-scrollbar pb-4"
            style={{ maxHeight: "calc(100vh - 120px)" }}
          >
            <SearchResults results={results} isLoading={isLoading} />
          </div>
        </div>
      </div>
    </div>
  );
}
