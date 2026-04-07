import Image from "next/image";
import { ExternalLink, Bookmark, Pin, Globe } from "lucide-react";
import { useState } from "react";

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

function getScreenshotUrl(url: string): string {
  return `https://v1.screenshot.11ty.dev/${encodeURIComponent(url)}/opengraph/`;
}

function getFaviconUrl(url: string): string {
  try {
    const domain = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
  } catch {
    return "";
  }
}

export default function SearchResultCard({ result }: SearchResultCardProps) {
  const isPinterest = result.source === "pinterest";
  const domain = getDomainFromUrl(result.url);
  const [screenshotLoaded, setScreenshotLoaded] = useState(false);
  const [screenshotError, setScreenshotError] = useState(false);

  // For Pinterest, use the provided image. For bookmarks, use screenshot service
  const hasPinterestImage = isPinterest && result.imageUrl && !result.imageUrl.includes("favicon");
  const screenshotUrl = !isPinterest ? getScreenshotUrl(result.url) : null;
  const faviconUrl = getFaviconUrl(result.url);

  return (
    <a
      href={result.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group relative flex flex-col rounded-lg sm:rounded-xl overflow-hidden bg-white border border-gray-100 shadow-[0_2px_8px_rgba(0,0,0,0.04)] hover:shadow-[0_8px_24px_rgba(91,152,136,0.12)] sm:hover:shadow-[0_12px_40px_rgba(91,152,136,0.15)] transition-all duration-300 hover:-translate-y-0.5 sm:hover:-translate-y-1 hover:border-[#5b9888]/30"
    >
      {/* Thumbnail */}
      <div className="relative w-full aspect-[4/3] sm:aspect-[16/10] bg-gradient-to-br from-gray-50 to-gray-100 overflow-hidden">
        {/* Pinterest with image */}
        {hasPinterestImage ? (
          <Image
            src={result.imageUrl!}
            alt={result.title}
            fill
            className="object-cover group-hover:scale-105 transition-transform duration-500"
            unoptimized
          />
        ) : (
          <>
            {/* Placeholder shown while screenshot loads or on error */}
            <div
              className={`absolute inset-0 flex items-center justify-center bg-gradient-to-br from-[#f0fdf4] to-[#ecfeff] transition-opacity duration-300 ${
                screenshotLoaded && !screenshotError ? "opacity-0" : "opacity-100"
              }`}
            >
              {/* Decorative pattern */}
              <div className="absolute inset-0 opacity-[0.03]">
                <svg className="w-full h-full" xmlns="http://www.w3.org/2000/svg">
                  <defs>
                    <pattern id={`grid-${result.id}`} width="20" height="20" patternUnits="userSpaceOnUse">
                      <circle cx="10" cy="10" r="1" fill="currentColor" />
                    </pattern>
                  </defs>
                  <rect width="100%" height="100%" fill={`url(#grid-${result.id})`} />
                </svg>
              </div>

              {/* Favicon placeholder for bookmarks */}
              <div className="flex flex-col items-center gap-2 sm:gap-3">
                {faviconUrl ? (
                  <div className="w-14 h-14 sm:w-20 sm:h-20 rounded-xl sm:rounded-2xl bg-white shadow-md flex items-center justify-center p-2 sm:p-3 group-hover:scale-110 transition-transform duration-300">
                    <Image
                      src={faviconUrl}
                      alt=""
                      width={48}
                      height={48}
                      className="object-contain w-auto h-auto max-w-full max-h-full"
                      unoptimized
                    />
                  </div>
                ) : (
                  <div
                    className={`w-14 h-14 sm:w-20 sm:h-20 rounded-xl sm:rounded-2xl flex items-center justify-center shadow-md ${
                      isPinterest
                        ? "bg-gradient-to-br from-[#E60023]/10 to-[#E60023]/5"
                        : "bg-gradient-to-br from-[#5b9888]/10 to-[#5b9888]/5"
                    }`}
                  >
                    {isPinterest ? (
                      <Pin className="w-6 h-6 sm:w-8 sm:h-8 text-[#E60023]/70" />
                    ) : (
                      <Bookmark className="w-6 h-6 sm:w-8 sm:h-8 text-[#5b9888]/70" />
                    )}
                  </div>
                )}
                {domain && (
                  <span className="text-[9px] sm:text-[11px] text-gray-500 font-medium tracking-wide max-w-[85%] truncate bg-white/60 backdrop-blur-sm px-2 py-0.5 rounded-full">
                    {domain}
                  </span>
                )}
              </div>
            </div>

            {/* Screenshot image for bookmarks (loads in background) */}
            {screenshotUrl && !screenshotError && (
              <Image
                src={screenshotUrl}
                alt={result.title}
                fill
                className={`object-cover group-hover:scale-105 transition-all duration-500 ${
                  screenshotLoaded ? "opacity-100" : "opacity-0"
                }`}
                unoptimized
                onLoad={() => setScreenshotLoaded(true)}
                onError={() => setScreenshotError(true)}
              />
            )}
          </>
        )}

        {/* Source badge - icon only */}
        <div
          className={`absolute top-1.5 left-1.5 sm:top-2.5 sm:left-2.5 p-1 sm:p-1.5 rounded sm:rounded-md backdrop-blur-md shadow-sm flex items-center justify-center ${
            isPinterest
              ? "bg-[#E60023] text-white"
              : "bg-white/95 text-[#5b9888] border border-gray-100"
          }`}
        >
          {isPinterest ? (
            <Pin className="w-2.5 h-2.5 sm:w-3 sm:h-3" />
          ) : (
            <Bookmark className="w-2.5 h-2.5 sm:w-3 sm:h-3" />
          )}
        </div>

        {/* Hover overlay with gradient - hidden on touch devices */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-black/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 hidden sm:flex items-end justify-center pb-3">
          <span className="flex items-center gap-1.5 text-white text-xs font-medium bg-white/20 backdrop-blur-sm px-3 py-1.5 rounded-full">
            <ExternalLink className="w-3 h-3" />
            Open
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-col gap-1 sm:gap-2 p-2.5 sm:p-3.5">
        {/* Title */}
        <h3 className="text-[11px] sm:text-[13px] font-semibold text-gray-800 leading-snug line-clamp-2 group-hover:text-[#5b9888] transition-colors duration-200">
          {result.title}
        </h3>

        {/* Meta info */}
        <div className="flex items-center gap-1.5 sm:gap-2 text-[10px] sm:text-[11px] text-gray-400">
          <Globe className="w-2.5 h-2.5 sm:w-3 sm:h-3 flex-shrink-0" />
          <span className="truncate">{result.folder || domain}</span>
        </div>
      </div>

      {/* Subtle hover border glow */}
      <div className="absolute inset-0 rounded-lg sm:rounded-xl border-2 border-transparent group-hover:border-[#5b9888]/20 transition-colors duration-300 pointer-events-none" />
    </a>
  );
}
