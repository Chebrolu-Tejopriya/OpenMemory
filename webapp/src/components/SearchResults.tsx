import SearchResultCard, { SearchResult } from "./SearchResultCard";

interface SearchResultsProps {
  results: SearchResult[];
  isLoading?: boolean;
}

export default function SearchResults({ results, isLoading }: SearchResultsProps) {
  if (isLoading) {
    return (
      <div className="w-full flex flex-col gap-2 p-2">
        {[0, 1].map((row) => (
          <div key={row} className="flex gap-2 w-full">
            {[0, 1, 2].map((col) => (
              <div
                key={col}
                className="flex-1 h-[229px] rounded-[6px] bg-gray-100 animate-pulse"
              />
            ))}
          </div>
        ))}
      </div>
    );
  }

  if (results.length === 0) {
    return null;
  }

  // Split results into rows of 3
  const rows: SearchResult[][] = [];
  for (let i = 0; i < results.length; i += 3) {
    rows.push(results.slice(i, i + 3));
  }

  return (
    <div className="w-full flex flex-col gap-2 p-2">
      {rows.map((row, rowIndex) => (
        <div key={rowIndex} className="flex gap-2 w-full">
          {row.map((result) => (
            <div key={result.id} className="flex-1 min-w-0">
              <SearchResultCard result={result} />
            </div>
          ))}
          {/* Fill empty slots to maintain grid */}
          {row.length < 3 &&
            Array(3 - row.length)
              .fill(null)
              .map((_, i) => <div key={`empty-${i}`} className="flex-1" />)}
        </div>
      ))}
    </div>
  );
}
