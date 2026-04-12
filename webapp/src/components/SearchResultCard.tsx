import Image from "next/image";
import { useState, useRef, useEffect } from "react";

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
  revealDelay?: number; // ms stagger for scroll reveal
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

function cleanPinterestTitle(title: string): string {
  // Strip the auto-generated "This may contain: an image of ..." prefix Pinterest adds
  return title.replace(/^this may contain:?\s*/i, "").trim();
}

export default function SearchResultCard({ result, revealDelay = 0 }: SearchResultCardProps) {
  const isPinterest = result.source === "pinterest";
  const domain = getDomainFromUrl(result.url);
  const displayTitle = isPinterest ? cleanPinterestTitle(result.title) : result.title;
  const [screenshotLoaded, setScreenshotLoaded] = useState(false);
  const [screenshotError, setScreenshotError] = useState(false);
  const [pinImgError, setPinImgError] = useState(false);

  // Scroll reveal
  const cardRef = useRef<HTMLAnchorElement>(null);
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setRevealed(true); observer.disconnect(); } },
      { threshold: 0.08, rootMargin: "0px 0px -30px 0px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const hasPinterestImage = isPinterest && result.imageUrl && !result.imageUrl.includes("favicon") && !pinImgError;
  const screenshotUrl = !isPinterest ? getScreenshotUrl(result.url) : null;
  const faviconUrl = getFaviconUrl(result.url);

  const categoryLabel = result.folder && result.folder !== "Bookmarks"
    ? result.folder.split("/").pop() || result.folder
    : domain;

  return (
    <a
      ref={cardRef}
      href={result.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex flex-col bg-[#f4f4f4] rounded-2xl overflow-hidden"
      style={{
        opacity: revealed ? 1 : 0,
        transform: revealed ? "translateY(0px)" : "translateY(22px)",
        transition: `opacity 0.6s cubic-bezier(0.22, 1, 0.36, 1) ${revealDelay}ms, transform 0.6s cubic-bezier(0.22, 1, 0.36, 1) ${revealDelay}ms, box-shadow 500ms ease-out`,
        boxShadow: "0 0 0 rgba(0,0,0,0)",
      }}
      onMouseEnter={e => (e.currentTarget.style.boxShadow = "0 12px 40px rgba(0,0,0,0.08), 0 3px 10px rgba(0,0,0,0.04)")}
      onMouseLeave={e => (e.currentTarget.style.boxShadow = "0 0 0 rgba(0,0,0,0)")}
    >
      {/* Image container — landscape for screenshots, portrait for Pinterest pins */}
      <div className="px-2.5 pt-2.5 pb-0">
        <div className="relative w-full aspect-video rounded-xl overflow-hidden bg-gray-200">

          {/* Image */}
          {hasPinterestImage ? (
            <Image
              src={result.imageUrl!}
              alt={result.title}
              fill
              className="object-cover transition-all duration-300 group-hover:scale-[1.02]"
              unoptimized
              onError={() => setPinImgError(true)}
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

      {/* Title + meta */}
      <div className="px-3 pt-2.5 pb-3 flex flex-col gap-1">
        <h3 className="text-[12px] sm:text-[13px] font-semibold text-gray-700 leading-snug line-clamp-2">
          {displayTitle}
        </h3>
        <div className="flex items-center justify-between gap-1">
          {!isPinterest && (
            <span className="text-[10px] text-gray-400 truncate">{domain}</span>
          )}
          {isPinterest && (
            <span className="w-1.5 h-1.5 rounded-full bg-[#E60023]/40 shrink-0" />
          )}
          <span className="text-[10px] font-medium text-gray-400/70 uppercase tracking-wider truncate text-right flex-1">
            {categoryLabel}
          </span>
        </div>
      </div>
    </a>
  );
}
