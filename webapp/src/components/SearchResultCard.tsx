import Image from "next/image";
import { useState } from "react";
import { Pin } from "lucide-react";

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

  // Category label: use folder name, fallback to domain
  const categoryLabel = result.folder && result.folder !== "Bookmarks"
    ? result.folder.split("/").pop() || result.folder
    : domain;

  return (
    <a
      href={result.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex flex-col bg-white rounded-2xl border border-gray-100 shadow-sm hover:shadow-md transition-all duration-300 hover:-translate-y-0.5 overflow-hidden"
    >
      {/* Card header: category label + optional pin icon */}
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <span className="text-[10px] sm:text-[11px] font-medium text-gray-400 uppercase tracking-wider truncate max-w-[80%]">
          {categoryLabel}
        </span>
        {isPinterest && (
          <Pin className="w-3 h-3 text-[#E60023]/60 flex-shrink-0" />
        )}
      </div>

      {/* Contained image area with padding */}
      <div className="px-3 pb-3">
        <div className="relative w-full aspect-[4/3] rounded-xl overflow-hidden bg-gray-50">
          {hasPinterestImage ? (
            <Image
              src={result.imageUrl!}
              alt={result.title}
              fill
              className="object-cover"
              unoptimized
            />
          ) : (
            <>
              {/* Placeholder shown while screenshot loads or on error */}
              <div
                className={`absolute inset-0 flex items-center justify-center bg-gradient-to-br from-[#f8fffe] to-[#f0f9f6] transition-opacity duration-300 ${
                  screenshotLoaded && !screenshotError ? "opacity-0" : "opacity-100"
                }`}
              >
                {faviconUrl ? (
                  <div className="flex flex-col items-center gap-2">
                    <div className="w-12 h-12 sm:w-16 sm:h-16 rounded-xl bg-white shadow-sm flex items-center justify-center p-2">
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

              {/* Screenshot loads in background */}
              {screenshotUrl && !screenshotError && (
                <Image
                  src={screenshotUrl}
                  alt={result.title}
                  fill
                  className={`object-cover transition-opacity duration-500 ${
                    screenshotLoaded ? "opacity-100" : "opacity-0"
                  }`}
                  unoptimized
                  onLoad={() => setScreenshotLoaded(true)}
                  onError={() => setScreenshotError(true)}
                />
              )}
            </>
          )}
        </div>
      </div>

      {/* Title and domain */}
      <div className="px-3 pb-3 flex flex-col gap-1">
        <h3 className="text-[12px] sm:text-[13px] font-semibold text-gray-800 leading-snug line-clamp-2 group-hover:text-[#3d7a64] transition-colors duration-200">
          {result.title}
        </h3>
        <span className="text-[10px] sm:text-[11px] text-gray-400 truncate">{domain}</span>
      </div>
    </a>
  );
}
