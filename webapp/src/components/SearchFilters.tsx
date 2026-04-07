"use client";

import { useState, useRef, useEffect } from "react";
import { Bookmark, Pin, LayoutGrid, ChevronDown } from "lucide-react";

export type SourceFilter = "all" | "chrome" | "pinterest";

interface SearchFiltersProps {
  activeSource: SourceFilter;
  onSourceChange: (source: SourceFilter) => void;
  resultCount?: number;
  folders?: string[];
  boards?: string[];
  selectedFolder?: string;
  selectedBoard?: string;
  onFolderChange?: (folder: string) => void;
  onBoardChange?: (board: string) => void;
}

export default function SearchFilters({
  activeSource,
  onSourceChange,
  resultCount,
  folders = [],
  boards = [],
  selectedFolder = "",
  selectedBoard = "",
  onFolderChange,
  onBoardChange,
}: SearchFiltersProps) {
  const [showFolderDropdown, setShowFolderDropdown] = useState(false);
  const [showBoardDropdown, setShowBoardDropdown] = useState(false);
  const folderRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (folderRef.current && !folderRef.current.contains(event.target as Node)) {
        setShowFolderDropdown(false);
      }
      if (boardRef.current && !boardRef.current.contains(event.target as Node)) {
        setShowBoardDropdown(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const getBookmarkLabel = () => {
    if (selectedFolder) {
      // Show truncated folder name
      const parts = selectedFolder.split("/");
      const lastPart = parts[parts.length - 1];
      return lastPart.length > 12 ? lastPart.slice(0, 12) + "..." : lastPart;
    }
    return "Bookmarks";
  };

  const getPinterestLabel = () => {
    if (selectedBoard) {
      return selectedBoard.length > 12 ? selectedBoard.slice(0, 12) + "..." : selectedBoard;
    }
    return "Pinterest";
  };

  return (
    <div className="flex items-center justify-between w-full gap-2">
      {/* Filter buttons */}
      <div className="flex items-center gap-1 sm:gap-1.5 p-0.5 sm:p-1 rounded-lg bg-white/60 backdrop-blur-sm border border-white/40 shadow-sm">
        {/* All button */}
        <button
          onClick={() => {
            onSourceChange("all");
            setShowFolderDropdown(false);
            setShowBoardDropdown(false);
          }}
          className={`flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1 sm:py-1.5 rounded-md text-[10px] sm:text-xs font-medium transition-all duration-200 ${
            activeSource === "all"
              ? "bg-white shadow-sm border border-gray-100 text-[#5b9888]"
              : "text-gray-500 hover:text-gray-700 hover:bg-white/50"
          }`}
        >
          <LayoutGrid className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
          <span className="hidden sm:inline">All</span>
        </button>

        {/* Bookmarks button with dropdown */}
        <div ref={folderRef} className="relative">
          <button
            onClick={() => {
              if (activeSource === "chrome") {
                // Already active, toggle dropdown
                setShowFolderDropdown(!showFolderDropdown);
                setShowBoardDropdown(false);
              } else {
                // Switch to bookmarks
                onSourceChange("chrome");
                setShowBoardDropdown(false);
              }
            }}
            className={`flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1 sm:py-1.5 rounded-md text-[10px] sm:text-xs font-medium transition-all duration-200 ${
              activeSource === "chrome"
                ? "bg-white shadow-sm border border-gray-100 text-[#5b9888]"
                : "text-gray-500 hover:text-gray-700 hover:bg-white/50"
            }`}
          >
            <Bookmark className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
            <span className="hidden sm:inline">{getBookmarkLabel()}</span>
            {activeSource === "chrome" && folders.length > 0 && (
              <ChevronDown className={`w-3 h-3 transition-transform duration-200 ${showFolderDropdown ? "rotate-180" : ""}`} />
            )}
          </button>

          {/* Folder dropdown */}
          {showFolderDropdown && activeSource === "chrome" && folders.length > 0 && (
            <div className="absolute top-full left-0 mt-1 w-48 sm:w-56 max-h-60 overflow-y-auto bg-white rounded-lg shadow-lg border border-gray-100 z-[100]">
              <button
                onClick={() => {
                  onFolderChange?.("");
                  setShowFolderDropdown(false);
                }}
                className={`w-full text-left px-3 py-2 text-xs hover:bg-gray-50 transition-colors ${
                  !selectedFolder ? "bg-[#5b9888]/10 text-[#5b9888] font-medium" : "text-gray-600"
                }`}
              >
                All Bookmarks
              </button>
              {folders.map((folder) => (
                <button
                  key={folder}
                  onClick={() => {
                    onFolderChange?.(folder);
                    setShowFolderDropdown(false);
                  }}
                  className={`w-full text-left px-3 py-2 text-xs hover:bg-gray-50 transition-colors truncate ${
                    selectedFolder === folder ? "bg-[#5b9888]/10 text-[#5b9888] font-medium" : "text-gray-600"
                  }`}
                >
                  {folder}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Pinterest button with dropdown */}
        <div ref={boardRef} className="relative">
          <button
            onClick={() => {
              if (activeSource === "pinterest") {
                // Already active, toggle dropdown
                setShowBoardDropdown(!showBoardDropdown);
                setShowFolderDropdown(false);
              } else {
                // Switch to pinterest
                onSourceChange("pinterest");
                setShowFolderDropdown(false);
              }
            }}
            className={`flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1 sm:py-1.5 rounded-md text-[10px] sm:text-xs font-medium transition-all duration-200 ${
              activeSource === "pinterest"
                ? "bg-white shadow-sm border border-gray-100 text-[#E60023]"
                : "text-gray-500 hover:text-gray-700 hover:bg-white/50"
            }`}
          >
            <Pin className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
            <span className="hidden sm:inline">{getPinterestLabel()}</span>
            {activeSource === "pinterest" && boards.length > 0 && (
              <ChevronDown className={`w-3 h-3 transition-transform duration-200 ${showBoardDropdown ? "rotate-180" : ""}`} />
            )}
          </button>

          {/* Board dropdown */}
          {showBoardDropdown && activeSource === "pinterest" && boards.length > 0 && (
            <div className="absolute top-full left-0 mt-1 w-48 sm:w-56 max-h-60 overflow-y-auto bg-white rounded-lg shadow-lg border border-gray-100 z-[100]">
              <button
                onClick={() => {
                  onBoardChange?.("");
                  setShowBoardDropdown(false);
                }}
                className={`w-full text-left px-3 py-2 text-xs hover:bg-gray-50 transition-colors ${
                  !selectedBoard ? "bg-[#E60023]/10 text-[#E60023] font-medium" : "text-gray-600"
                }`}
              >
                All Boards
              </button>
              {boards.map((board) => (
                <button
                  key={board}
                  onClick={() => {
                    onBoardChange?.(board);
                    setShowBoardDropdown(false);
                  }}
                  className={`w-full text-left px-3 py-2 text-xs hover:bg-gray-50 transition-colors truncate ${
                    selectedBoard === board ? "bg-[#E60023]/10 text-[#E60023] font-medium" : "text-gray-600"
                  }`}
                >
                  {board}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Result count */}
      {typeof resultCount === "number" && (
        <div className="flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1 sm:py-1.5 rounded-lg bg-white/60 backdrop-blur-sm border border-white/40">
          <span className="text-[10px] sm:text-xs text-gray-500 font-medium whitespace-nowrap">
            <span className="text-[#5b9888] font-semibold">{resultCount}</span>{" "}
            <span className="hidden sm:inline">{resultCount === 1 ? "result" : "results"}</span>
          </span>
        </div>
      )}
    </div>
  );
}
