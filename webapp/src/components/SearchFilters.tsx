"use client";

import { Bookmark, Pin, LayoutGrid, SlidersHorizontal } from "lucide-react";

export type SourceFilter = "all" | "chrome" | "pinterest";

interface SearchFiltersProps {
  activeSource: SourceFilter;
  onSourceChange: (source: SourceFilter) => void;
  resultCount?: number;
}

export default function SearchFilters({
  activeSource,
  onSourceChange,
  resultCount,
}: SearchFiltersProps) {
  const filters: { id: SourceFilter; label: string; icon: React.ReactNode; color?: string }[] =
    [
      {
        id: "all",
        label: "All",
        icon: <LayoutGrid className="w-3.5 h-3.5" />,
      },
      {
        id: "chrome",
        label: "Bookmarks",
        icon: <Bookmark className="w-3.5 h-3.5" />,
        color: "#5b9888",
      },
      {
        id: "pinterest",
        label: "Pinterest",
        icon: <Pin className="w-3.5 h-3.5" />,
        color: "#E60023",
      },
    ];

  return (
    <div className="flex items-center justify-between w-full">
      {/* Filter buttons */}
      <div className="flex items-center gap-1.5 p-1 rounded-lg bg-white/60 backdrop-blur-sm border border-white/40 shadow-sm">
        <div className="flex items-center gap-1 px-2 text-gray-400">
          <SlidersHorizontal className="w-3.5 h-3.5" />
        </div>
        {filters.map((filter) => {
          const isActive = activeSource === filter.id;
          return (
            <button
              key={filter.id}
              onClick={() => onSourceChange(filter.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-200 ${
                isActive
                  ? "bg-white shadow-sm border border-gray-100"
                  : "text-gray-500 hover:text-gray-700 hover:bg-white/50"
              }`}
              style={
                isActive && filter.color
                  ? { color: filter.color }
                  : isActive
                  ? { color: "#5b9888" }
                  : undefined
              }
            >
              {filter.icon}
              <span className="hidden sm:inline">{filter.label}</span>
            </button>
          );
        })}
      </div>

      {/* Result count */}
      {typeof resultCount === "number" && (
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/60 backdrop-blur-sm border border-white/40">
          <span className="text-xs text-gray-500 font-medium">
            <span className="text-[#5b9888] font-semibold">{resultCount}</span>{" "}
            {resultCount === 1 ? "result" : "results"}
          </span>
        </div>
      )}
    </div>
  );
}
