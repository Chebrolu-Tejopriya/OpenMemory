"use client";

import { useState, useEffect, useCallback } from "react";
import { Bookmark, Pin, FolderOpen, ChevronRight } from "lucide-react";
import SearchResultCard, { SearchResult } from "./SearchResultCard";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001";

type BrowseTab = "bookmarks" | "pinterest";

interface BrowseSectionProps {
  folders: string[];
  boards: string[];
}

export default function BrowseSection({ folders, boards }: BrowseSectionProps) {
  const [activeTab, setActiveTab] = useState<BrowseTab>("bookmarks");
  const [selectedItem, setSelectedItem] = useState<string>("");
  const [cards, setCards] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Auto-select first item when tab or lists change
  useEffect(() => {
    const list = activeTab === "bookmarks" ? folders : boards;
    if (list.length > 0) {
      setSelectedItem(list[0]);
    } else {
      setSelectedItem("");
      setCards([]);
    }
  }, [activeTab, folders, boards]);

  const fetchCards = useCallback(async (item: string) => {
    if (!item) return;
    setIsLoading(true);
    try {
      const source = activeTab === "bookmarks" ? "chrome" : "pinterest";
      const paramKey = activeTab === "bookmarks" ? "folder" : "board";
      const res = await fetch(
        `${BACKEND_URL}/browse?source=${source}&${paramKey}=${encodeURIComponent(item)}&limit=40`
      );
      if (!res.ok) throw new Error("Browse failed");
      const data = await res.json();
      const mapped: SearchResult[] = data.results.map(
        (r: { title: string; url: string; folder: string | null; source: string; imageUrl: string | null }, i: number) => ({
          id: `browse-${i}-${r.url}`,
          title: r.title,
          folder: r.folder || item,
          url: r.url,
          source: r.source.includes("chrome") ? "chrome" : "pinterest",
          imageUrl: r.imageUrl || undefined,
        })
      );
      setCards(mapped);
    } catch {
      setCards([]);
    } finally {
      setIsLoading(false);
    }
  }, [activeTab]);

  useEffect(() => {
    if (selectedItem) fetchCards(selectedItem);
  }, [selectedItem, fetchCards]);

  const list = activeTab === "bookmarks" ? folders : boards;

  // Shorten folder display names
  function displayName(path: string) {
    const parts = path.split("/");
    return parts[parts.length - 1] || path;
  }

  return (
    <div className="w-full flex flex-col gap-4">
      {/* Section header */}
      <div className="flex items-center gap-2">
        <FolderOpen className="w-4 h-4 text-[#5b9888]/60" />
        <h2
          className="text-sm font-semibold tracking-wide text-[#3a3a3a]/50 uppercase"
          style={{ fontFamily: "var(--font-geist), sans-serif" }}
        >
          Browse
        </h2>
      </div>

      <div className="flex gap-4 min-h-[400px]">
        {/* Left panel */}
        <div className="w-52 flex-shrink-0 flex flex-col gap-2">
          {/* Tab switch */}
          <div className="flex bg-white/60 backdrop-blur-sm border border-[#5b9888]/20 rounded-xl p-1 gap-1">
            <button
              onClick={() => setActiveTab("bookmarks")}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 ${
                activeTab === "bookmarks"
                  ? "bg-white shadow-sm text-[#3a3a3a]"
                  : "text-[#3a3a3a]/50 hover:text-[#3a3a3a]/70"
              }`}
            >
              <Bookmark className="w-3 h-3" />
              Bookmarks
            </button>
            <button
              onClick={() => setActiveTab("pinterest")}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 ${
                activeTab === "pinterest"
                  ? "bg-white shadow-sm text-[#3a3a3a]"
                  : "text-[#3a3a3a]/50 hover:text-[#3a3a3a]/70"
              }`}
            >
              <Pin className="w-3 h-3" />
              Pinterest
            </button>
          </div>

          {/* Folder / board list */}
          <div className="flex flex-col gap-0.5 overflow-y-auto max-h-[500px] pr-1 custom-scrollbar">
            {list.length === 0 ? (
              <p className="text-xs text-[#3a3a3a]/30 px-2 py-3 text-center">
                No {activeTab === "bookmarks" ? "folders" : "boards"} found
              </p>
            ) : (
              list.map((item) => (
                <button
                  key={item}
                  onClick={() => setSelectedItem(item)}
                  title={item}
                  className={`flex items-center justify-between gap-2 w-full text-left px-3 py-2 rounded-lg text-xs transition-all duration-150 ${
                    selectedItem === item
                      ? "bg-white shadow-sm text-[#3d7a64] font-medium"
                      : "text-[#3a3a3a]/60 hover:bg-white/60 hover:text-[#3a3a3a]/80"
                  }`}
                >
                  <span className="truncate">{displayName(item)}</span>
                  {selectedItem === item && (
                    <ChevronRight className="w-3 h-3 flex-shrink-0 text-[#5b9888]/60" />
                  )}
                </button>
              ))
            )}
          </div>
        </div>

        {/* Right panel — cards */}
        <div className="flex-1 min-w-0">
          {isLoading ? (
            <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-4 gap-3">
              {[...Array(8)].map((_, i) => (
                <div
                  key={i}
                  className="rounded-2xl bg-white border border-gray-100 overflow-hidden animate-pulse"
                >
                  <div className="px-3 pt-3 pb-1 h-6 bg-gray-50" />
                  <div className="px-3 pb-3">
                    <div className="aspect-4/3 rounded-xl bg-gray-100" />
                  </div>
                  <div className="px-3 pb-3 space-y-1.5">
                    <div className="h-3.5 bg-gray-100 rounded w-full" />
                    <div className="h-3 bg-gray-100 rounded w-2/3" />
                  </div>
                </div>
              ))}
            </div>
          ) : cards.length === 0 ? (
            <div className="flex items-center justify-center h-48 text-sm text-[#3a3a3a]/30">
              No items found
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-4 gap-3">
              {cards.map((card) => (
                <SearchResultCard key={card.id} result={card} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
