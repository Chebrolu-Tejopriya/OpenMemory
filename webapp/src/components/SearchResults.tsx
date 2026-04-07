import SearchResultCard, { SearchResult } from "./SearchResultCard";
import { Search, Sparkles } from "lucide-react";

interface SearchResultsProps {
  results: SearchResult[];
  isLoading?: boolean;
}

export default function SearchResults({
  results,
  isLoading,
}: SearchResultsProps) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {[...Array(8)].map((_, i) => (
          <div
            key={i}
            className="rounded-xl bg-white border border-gray-100 overflow-hidden animate-pulse"
          >
            <div className="aspect-[16/10] bg-gradient-to-br from-gray-100 to-gray-50">
              <div className="w-full h-full flex items-center justify-center">
                <div className="w-10 h-10 rounded-xl bg-gray-200/60" />
              </div>
            </div>
            <div className="p-3.5 space-y-2.5">
              <div className="h-4 bg-gray-100 rounded-md w-full" />
              <div className="h-3 bg-gray-100 rounded-md w-2/3" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="w-24 h-24 rounded-full bg-gradient-to-br from-[#5b9888]/10 to-[#5b9888]/5 flex items-center justify-center mb-5 relative">
          <Search className="w-10 h-10 text-[#5b9888]/40" />
          <Sparkles className="w-5 h-5 text-[#5b9888]/60 absolute -top-1 -right-1" />
        </div>
        <h3 className="text-gray-700 font-semibold text-lg mb-2">
          No results found
        </h3>
        <p className="text-gray-400 text-sm max-w-xs">
          Try different keywords or adjust your filters to find what you&apos;re
          looking for
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
      {results.map((result) => (
        <SearchResultCard key={result.id} result={result} />
      ))}
    </div>
  );
}
