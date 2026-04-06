import Image from "next/image";

export interface SearchResult {
  id: string;
  title: string;
  folder: string;
  imageUrl?: string;
  url: string;
  source: "chrome" | "pinterest";
}

interface SearchResultCardProps {
  result: SearchResult;
}

export default function SearchResultCard({ result }: SearchResultCardProps) {
  return (
    <a
      href={result.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex flex-col gap-[15px] p-2 rounded-[6px] border border-[#f3f4f6] bg-[#f9fafb] overflow-hidden hover:border-[#5b9888] transition-colors cursor-pointer"
    >
      {/* Folder label */}
      <p className="text-[14px] leading-[20px] text-[#4d5761] text-center font-normal truncate">
        {result.folder}
      </p>

      {/* Thumbnail */}
      <div className="flex-1 px-[40px] min-h-[120px]">
        <div className="relative w-full h-full min-h-[120px] rounded-[10px] overflow-hidden bg-gray-100">
          {result.imageUrl ? (
            <Image
              src={result.imageUrl}
              alt={result.title}
              fill
              className="object-cover"
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-gray-400">
              <svg
                className="w-12 h-12"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                />
              </svg>
            </div>
          )}
        </div>
      </div>

      {/* Title */}
      <p className="text-[14px] leading-[20px] text-[#111927] text-center font-medium truncate">
        {result.title}
      </p>
    </a>
  );
}
