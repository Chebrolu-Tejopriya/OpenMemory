"use client";

import Image from "next/image";
import { useState, useEffect, useCallback, useRef } from "react";
import { Search, Volume2, VolumeX, Play, Pause } from "lucide-react";
import SearchResults from "@/components/SearchResults";
import SearchFilters, { SourceFilter } from "@/components/SearchFilters";
import { SearchResult } from "@/components/SearchResultCard";
import LeafIcon from "@/components/icons/LeafIcon";

const BACKEND_URL = "http://localhost:3001";

export default function Home() {
  const [searchQuery, setSearchQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [isPlaying, setIsPlaying] = useState(true);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const videoRef = useRef<HTMLVideoElement>(null);
  const userName = "TEJA";

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
    async (query: string, source: SourceFilter) => {
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
          limit: "30",
          offset: "0",
        });

        if (source !== "all") {
          const sourceValue = source === "chrome" ? "chrome_bookmarks" : source;
          params.set("source", sourceValue);
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
        performSearch(searchQuery, sourceFilter);
      } else {
        setResults([]);
        setHasSearched(false);
      }
    }, 350);

    return () => clearTimeout(timer);
  }, [searchQuery, sourceFilter, performSearch]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    performSearch(searchQuery, sourceFilter);
  };

  const handleSourceChange = (source: SourceFilter) => {
    setSourceFilter(source);
  };

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-[#ebfdff]">
      {/* Video Background */}
      <video
        ref={videoRef}
        className="absolute inset-0 w-full h-full object-fill"
        autoPlay
        loop
        muted
        playsInline
      >
        <source src="/videos/leaf-animation.mp4" type="video/mp4" />
      </video>

      {/* Video Controls - Top Right */}
      <div className="absolute top-4 right-4 flex items-center gap-2 z-30">
        <button
          onClick={toggleMute}
          className="p-2 rounded-full bg-white/30 hover:bg-white/50 backdrop-blur-sm transition-colors duration-300"
          aria-label={isMuted ? "Unmute" : "Mute"}
        >
          {isMuted ? (
            <VolumeX className="w-5 h-5 text-[#3a3a3a]" />
          ) : (
            <Volume2 className="w-5 h-5 text-[#3a3a3a]" />
          )}
        </button>
        <button
          onClick={togglePlayPause}
          className="p-2 rounded-full bg-white/30 hover:bg-white/50 backdrop-blur-sm transition-colors duration-300"
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? (
            <Pause className="w-5 h-5 text-[#3a3a3a]" />
          ) : (
            <Play className="w-5 h-5 text-[#3a3a3a]" />
          )}
        </button>
      </div>

      {/* Top Gradient Frame */}
      <div className="absolute top-[-36px] left-[-35px] w-[1518px] h-[142px] z-10 pointer-events-none">
        <Image
          src="/images/top-gradient.png"
          alt=""
          fill
          className="object-cover"
          priority
        />
      </div>

      {/* Greeting - HI, TEJA (fades out when searching) */}
      <p
        className={`absolute top-[7px] left-1/2 -translate-x-1/2 font-semibold text-[33px] tracking-[6.27px] whitespace-nowrap text-center z-20 transition-all duration-500 ease-out ${
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
        className={`absolute left-1/2 -translate-x-1/2 z-20 transition-all duration-500 ease-[cubic-bezier(0.4,0,0.2,1)] ${
          hasSearched
            ? "top-[12px] w-[90%] max-w-[600px]"
            : "top-[200px] w-[95%] max-w-[700px]"
        }`}
      >
        <form onSubmit={handleSearch} className="w-full">
          <div
            className={`w-full flex items-center rounded-[13px] border-4 border-solid transition-all duration-500 ease-out ${
              hasSearched ? "px-[12px] py-[6px]" : "px-[14px] py-[8px]"
            }`}
            style={{
              backgroundColor: hasSearched
                ? "rgba(255, 255, 255, 0.85)"
                : "rgba(255, 255, 255, 0.38)",
              borderColor: "#5b9888",
              boxShadow: hasSearched
                ? "0 4px 20px rgba(91, 152, 136, 0.15)"
                : "none",
            }}
          >
            <div className="flex items-center gap-[10px] flex-1">
              <div className="flex items-center py-[4px]">
                <Search
                  className={`transition-all duration-300 ${
                    hasSearched
                      ? "w-4 h-4 text-[#5b9888]"
                      : "w-4 h-4 text-[#646464]"
                  }`}
                />
              </div>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search your inspirations..."
                className={`flex-1 bg-transparent outline-none placeholder:text-[#3a3a3a]/60 text-[#3a3a3a] transition-all duration-300 ${
                  hasSearched
                    ? "text-[14px] leading-[20px]"
                    : "text-[16px] leading-[24px]"
                }`}
                style={{ fontFamily: "var(--font-geist), sans-serif" }}
              />
            </div>
          </div>
        </form>
      </div>

      {/* Headline - Fades out when searching */}
      <div
        className={`absolute left-1/2 -translate-x-1/2 top-[130px] flex flex-col items-center justify-center p-[10px] z-10 transition-all duration-500 ease-out ${
          hasSearched
            ? "opacity-0 -translate-y-8 pointer-events-none"
            : "opacity-100 translate-y-0"
        }`}
      >
        <div className="flex items-center justify-center gap-[10px]">
          <h1
            className="gradient-text font-semibold text-[36px] text-center whitespace-nowrap"
            style={{ fontFamily: "var(--font-baloo-2), sans-serif" }}
          >
            Find what inspires you
          </h1>
          <LeafIcon className="w-[30px] h-[30px]" />
        </div>
      </div>

      {/* Results Section - Slides up smoothly */}
      <div
        className={`absolute left-1/2 -translate-x-1/2 w-[95%] max-w-[1200px] z-10 transition-all duration-500 ease-[cubic-bezier(0.4,0,0.2,1)] ${
          hasSearched
            ? "top-[70px] opacity-100 translate-y-0"
            : "top-[300px] opacity-0 translate-y-8 pointer-events-none"
        }`}
      >
        <div className="w-full flex flex-col gap-4">
          {/* Filters */}
          <SearchFilters
            activeSource={sourceFilter}
            onSourceChange={handleSourceChange}
            resultCount={results.length}
          />

          {/* Scrollable Results Container */}
          <div
            className="w-full overflow-y-auto pr-2 custom-scrollbar"
            style={{ maxHeight: "calc(100vh - 140px)" }}
          >
            <SearchResults results={results} isLoading={isLoading} />
          </div>
        </div>
      </div>
    </div>
  );
}
