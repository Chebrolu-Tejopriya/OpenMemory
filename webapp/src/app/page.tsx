"use client";

import Image from "next/image";
import { useState, useEffect, useCallback, useRef } from "react";
import { Search, Volume2, VolumeX, Play, Pause } from "lucide-react";
import SearchResults from "@/components/SearchResults";
import { SearchResult } from "@/components/SearchResultCard";
import LeafIcon from "@/components/icons/LeafIcon";

const BACKEND_URL = "http://localhost:3000";

export default function Home() {
  const [searchQuery, setSearchQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [isPlaying, setIsPlaying] = useState(true);
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

  const performSearch = useCallback(async (query: string) => {
    if (query.length < 2) {
      setResults([]);
      setHasSearched(false);
      return;
    }

    setIsLoading(true);
    setHasSearched(true);

    try {
      const searchResponse = await fetch(
        `${BACKEND_URL}/search?q=${encodeURIComponent(query)}&limit=20&offset=0`
      );

      if (!searchResponse.ok) {
        throw new Error("Search request failed");
      }

      const data = await searchResponse.json();

      // Map backend results to our SearchResult interface
      const mappedResults: SearchResult[] = data.results.map(
        (item: { title: string; url: string; folder: string | null; source: string }, index: number) => ({
          id: `${index}-${item.url}`,
          title: item.title,
          folder: item.folder || "Bookmarks",
          url: item.url,
          source: item.source === "chrome" ? "chrome" : "pinterest",
        })
      );

      setResults(mappedResults);
    } catch (error) {
      console.error("Search error:", error);
      setResults([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchQuery) {
        performSearch(searchQuery);
      } else {
        setResults([]);
        setHasSearched(false);
      }
    }, 350);

    return () => clearTimeout(timer);
  }, [searchQuery, performSearch]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    performSearch(searchQuery);
  };

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-[#ebfdff]">
      {/* Video Background - Full Container */}
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
          className="p-2 rounded-full bg-white/30 hover:bg-white/50 backdrop-blur-sm transition-colors"
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
          className="p-2 rounded-full bg-white/30 hover:bg-white/50 backdrop-blur-sm transition-colors"
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? (
            <Pause className="w-5 h-5 text-[#3a3a3a]" />
          ) : (
            <Play className="w-5 h-5 text-[#3a3a3a]" />
          )}
        </button>
      </div>

      {/* Top Gradient Frame from Figma */}
      <div className="absolute top-[-36px] left-[-35px] w-[1518px] h-[142px] z-10 pointer-events-none">
        <Image
          src="/images/top-gradient.png"
          alt=""
          fill
          className="object-cover"
          priority
        />
      </div>

      {/* Greeting - HI, TEJA */}
      <p
        className="absolute top-[7px] left-1/2 -translate-x-1/2 font-semibold text-[33px] tracking-[6.27px] whitespace-nowrap text-center z-20"
        style={{
          fontFamily: "var(--font-baloo-bhai-2), sans-serif",
          color: "rgba(44, 127, 87, 0.4)",
        }}
      >
        HI, {userName}
      </p>

      {/* Main content */}
      <div
        className={`absolute left-1/2 -translate-x-1/2 w-[836px] flex flex-col items-center gap-[17px] transition-all duration-300 z-10 ${
          hasSearched ? "top-[100px]" : "top-[140px]"
        }`}
      >
        {/* Headline */}
        <div className="flex flex-col items-center justify-center p-[10px]">
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

        {/* Search input */}
        <form onSubmit={handleSearch} className="w-full">
          <div
            className="w-full flex items-center px-[14px] py-[8px] rounded-[13px] border-4 border-solid"
            style={{
              backgroundColor: "rgba(255, 255, 255, 0.38)",
              borderColor: "#5b9888",
            }}
          >
            <div className="flex items-center gap-[10px] flex-1">
              <div className="flex items-center py-[4px]">
                <Search className="w-4 h-4 text-[#646464]" />
              </div>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Dark theme fintech"
                className="flex-1 text-[16px] leading-[24px] bg-transparent outline-none placeholder:text-[#3a3a3a] text-[#3a3a3a]"
                style={{ fontFamily: "var(--font-geist), sans-serif" }}
              />
            </div>
          </div>
        </form>

        {/* Search Results */}
        {hasSearched && (
          <div className="w-full mt-[24px]">
            <SearchResults results={results} isLoading={isLoading} />
          </div>
        )}
      </div>
    </div>
  );
}
