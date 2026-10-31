"use client";

import Image from "next/image";
import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import type { SearchResult } from "./SearchResultCard";

export default function XPostFeed({ result }: { result: SearchResult }) {
  const [imageFailed, setImageFailed] = useState(false);
  const author = result.author || "Saved post";
  const content = result.description || result.title;
  const text = result.author && content.startsWith(`${result.author} `)
    ? content.slice(result.author.length).trimStart() : content;
  return (
    <article className="rounded-2xl border border-[#5b9888]/15 bg-white/85 p-5 shadow-sm sm:p-6">
      <div className="mb-4 flex items-center gap-3">
        <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#edf5f2] text-lg">𝕏</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-[#303c37]">{author}</p>
          <p className="text-xs text-[#65746d]">Saved to X bookmarks</p>
        </div>
        <a href={result.url} target="_blank" rel="noopener noreferrer" aria-label={`Open post by ${author} on X`} className="rounded-lg p-2 text-[#65746d] hover:bg-[#edf5f2] focus-visible:outline-2 focus-visible:outline-[#5b9888]">
          <ArrowUpRight className="h-4 w-4" />
        </a>
      </div>
      <p className="whitespace-pre-wrap break-words text-[15px] leading-7 text-[#303c37]">{text}</p>
      {result.imageUrl && !imageFailed && (
        <a href={result.url} target="_blank" rel="noopener noreferrer" className="mt-4 block overflow-hidden rounded-xl bg-[#edf2ef]">
          <Image src={result.imageUrl} alt="Media from saved X post" width={1000} height={1000} unoptimized onError={() => setImageFailed(true)} className="max-h-[680px] w-full h-auto object-contain" />
        </a>
      )}
    </article>
  );
}
