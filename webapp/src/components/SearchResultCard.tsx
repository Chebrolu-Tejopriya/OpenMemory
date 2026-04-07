import Image from "next/image";
import { ExternalLink, Bookmark, Pin, Globe } from "lucide-react";

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

function getDomainFromUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace("www.", "");
  } catch {
    return "";
  }
}

export default function SearchResultCard({ result }: SearchResultCardProps) {
  const isPinterest = result.source === "pinterest";
  const domain = getDomainFromUrl(result.url);
  const hasThumbnail = result.imageUrl && !result.imageUrl.includes("favicon");

  return (
    <a
      href={result.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group relative flex flex-col rounded-xl overflow-hidden bg-white border border-gray-100 shadow-[0_2px_8px_rgba(0,0,0,0.04)] hover:shadow-[0_12px_40px_rgba(91,152,136,0.15)] transition-all duration-300 hover:-translate-y-1 hover:border-[#5b9888]/30"
    >
      {/* Thumbnail */}
      <div className="relative w-full aspect-[16/10] bg-gradient-to-br from-gray-50 to-gray-100 overflow-hidden">
        {hasThumbnail ? (
          <Image
            src={result.imageUrl!}
            alt={result.title}
            fill
            className="object-cover group-hover:scale-105 transition-transform duration-500"
            unoptimized
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-[#f0fdf4] to-[#ecfeff]">
            {/* Decorative pattern */}
            <div className="absolute inset-0 opacity-[0.03]">
              <svg className="w-full h-full" xmlns="http://www.w3.org/2000/svg">
                <defs>
                  <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
                    <circle cx="10" cy="10" r="1" fill="currentColor" />
                  </pattern>
                </defs>
                <rect width="100%" height="100%" fill="url(#grid)" />
              </svg>
            </div>

            {/* Icon and favicon */}
            <div className="flex flex-col items-center gap-3">
              {result.imageUrl ? (
                <div className="w-12 h-12 rounded-xl bg-white shadow-sm flex items-center justify-center p-2">
                  <Image
                    src={result.imageUrl}
                    alt=""
                    width={32}
                    height={32}
                    className="object-contain"
                    unoptimized
                  />
                </div>
              ) : (
                <div
                  className={`w-14 h-14 rounded-2xl flex items-center justify-center ${
                    isPinterest
                      ? "bg-gradient-to-br from-[#E60023]/10 to-[#E60023]/5"
                      : "bg-gradient-to-br from-[#5b9888]/10 to-[#5b9888]/5"
                  }`}
                >
                  {isPinterest ? (
                    <Pin className="w-6 h-6 text-[#E60023]/70" />
                  ) : (
                    <Bookmark className="w-6 h-6 text-[#5b9888]/70" />
                  )}
                </div>
              )}
              {domain && (
                <span className="text-[10px] text-gray-400 font-medium tracking-wide">
                  {domain}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Source badge */}
        <div
          className={`absolute top-2.5 left-2.5 px-2 py-1 rounded-md text-[9px] font-bold uppercase tracking-wider backdrop-blur-md shadow-sm flex items-center gap-1 ${
            isPinterest
              ? "bg-[#E60023] text-white"
              : "bg-white/95 text-[#5b9888] border border-gray-100"
          }`}
        >
          {isPinterest ? (
            <Pin className="w-2.5 h-2.5" />
          ) : (
            <Bookmark className="w-2.5 h-2.5" />
          )}
          {isPinterest ? "Pin" : "Bookmark"}
        </div>

        {/* Hover overlay with gradient */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-end justify-center pb-3">
          <span className="flex items-center gap-1.5 text-white text-xs font-medium bg-white/20 backdrop-blur-sm px-3 py-1.5 rounded-full">
            <ExternalLink className="w-3 h-3" />
            Open
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-col gap-2 p-3.5">
        {/* Title */}
        <h3 className="text-[13px] font-semibold text-gray-800 leading-snug line-clamp-2 group-hover:text-[#5b9888] transition-colors duration-200">
          {result.title}
        </h3>

        {/* Meta info */}
        <div className="flex items-center gap-2 text-[11px] text-gray-400">
          <Globe className="w-3 h-3 flex-shrink-0" />
          <span className="truncate">{result.folder || domain}</span>
        </div>
      </div>

      {/* Subtle hover border glow */}
      <div className="absolute inset-0 rounded-xl border-2 border-transparent group-hover:border-[#5b9888]/20 transition-colors duration-300 pointer-events-none" />
    </a>
  );
}
