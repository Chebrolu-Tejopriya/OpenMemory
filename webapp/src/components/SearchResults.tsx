import SearchResultCard, { SearchResult } from "./SearchResultCard";
import { Search, Sparkles } from "lucide-react";

interface SearchResultsProps {
  results: SearchResult[];
  isLoading?: boolean;
}

export default function SearchResults({ results, isLoading }: SearchResultsProps) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 gap-3 md:gap-4">
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
  }

  if (results.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 sm:py-20 text-center px-4">
        <div className="w-16 h-16 sm:w-24 sm:h-24 rounded-full bg-gradient-to-br from-[#5b9888]/10 to-[#5b9888]/5 flex items-center justify-center mb-4 sm:mb-5 relative">
          <Search className="w-7 h-7 sm:w-10 sm:h-10 text-[#5b9888]/40" />
          <Sparkles className="w-4 h-4 sm:w-5 sm:h-5 text-[#5b9888]/60 absolute -top-0.5 -right-0.5 sm:-top-1 sm:-right-1" />
        </div>
        <h3 className="text-gray-700 font-semibold text-base sm:text-lg mb-1.5 sm:mb-2">
          No results found
        </h3>
        <p className="text-gray-400 text-xs sm:text-sm max-w-xs">
          Try different keywords or adjust your filters to find what you&apos;re looking for
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 gap-3 md:gap-4">
      {results.map((result) => (
        <SearchResultCard key={result.id} result={result} />
      ))}
    </div>
  );
}
