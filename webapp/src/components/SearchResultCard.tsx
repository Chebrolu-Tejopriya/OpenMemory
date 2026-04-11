import Image from "next/image";
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

  const hasPinterestImage = isPinterest && result.imageUrl && !result.imageUrl.includes("favicon");
  const screenshotUrl = !isPinterest ? getScreenshotUrl(result.url) : null;
  const faviconUrl = getFaviconUrl(result.url);

  const categoryLabel = result.folder && result.folder !== "Bookmarks"
    ? result.folder.split("/").pop() || result.folder
    : domain;

  return (
    <a
      href={result.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex flex-col bg-[#f4f4f4] rounded-2xl overflow-hidden transition-all duration-300 hover:shadow-md hover:-translate-y-0.5"
    >
      {/* Top row — category + source dot */}
      <div className="flex items-center justify-between px-3 pt-3 pb-1 min-h-[28px]">
        <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest truncate max-w-[85%]">
          {categoryLabel}
        </span>
        {isPinterest && (
          <span className="w-2 h-2 rounded-full bg-[#E60023]/50 flex-shrink-0" />
        )}
      </div>

      {/* Image container — inset with padding, tall portrait ratio */}
      <div className="px-3 pb-2">
        <div className="relative w-full aspect-square rounded-xl overflow-hidden bg-gray-200">

          {/* Image */}
          {hasPinterestImage ? (
            <Image
              src={result.imageUrl!}
              alt={result.title}
              fill
              className="object-cover transition-all duration-300 group-hover:scale-[1.02]"
              unoptimized
            />
          ) : (
            <>
              {/* Favicon placeholder */}
              <div
                className={`absolute inset-0 flex items-center justify-center bg-gradient-to-br from-[#f8fffe] to-[#eef7f4] transition-opacity duration-300 ${
                  screenshotLoaded && !screenshotError ? "opacity-0" : "opacity-100"
                }`}
              >
                {faviconUrl ? (
                  <div className="flex flex-col items-center gap-2">
                    <div className="w-12 h-12 rounded-xl bg-white shadow-sm flex items-center justify-center p-2.5">
                      <Image
                        src={faviconUrl}
                        alt=""
                        width={40}
                        height={40}
                        className="object-contain w-auto h-auto max-w-full max-h-full"
                        unoptimized
                      />
                    </div>
                    {domain && (
                      <span className="text-[10px] text-gray-400 font-medium">{domain}</span>
                    )}
                  </div>
                ) : (
                  <span className="text-[10px] text-gray-300 font-medium">{domain}</span>
                )}
              </div>

              {/* Screenshot */}
              {screenshotUrl && !screenshotError && (
                <Image
                  src={screenshotUrl}
                  alt={result.title}
                  fill
                  className={`object-cover transition-all duration-500 group-hover:scale-[1.02] ${
                    screenshotLoaded ? "opacity-100" : "opacity-0"
                  }`}
                  unoptimized
                  onLoad={() => setScreenshotLoaded(true)}
                  onError={() => setScreenshotError(true)}
                />
              )}
            </>
          )}

          {/* Hover overlay — blur + Open button */}
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 backdrop-blur-[0px] group-hover:backdrop-blur-[3px] transition-all duration-300 flex items-center justify-center">
            <span className="opacity-0 group-hover:opacity-100 transition-all duration-200 delay-75 bg-white/90 text-gray-700 text-xs font-semibold px-5 py-2 rounded-full shadow-sm tracking-wide">
              Open
            </span>
          </div>
        </div>
      </div>

      {/* Title */}
      <div className="px-3 pb-3 flex flex-col gap-0.5">
        <h3 className="text-[12px] sm:text-[13px] font-semibold text-gray-700 leading-snug line-clamp-2">
          {result.title}
        </h3>
        <span className="text-[10px] text-gray-400 truncate">{domain}</span>
      </div>
    </a>
  );
}
