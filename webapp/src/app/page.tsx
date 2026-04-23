"use client";

import Image from "next/image";
import { useState, useEffect, useCallback, useRef } from "react";
import { Search, RefreshCw, LayoutGrid, X, Bookmark, Hash, Waypoints, Link2, StickyNote, Pencil, Upload, Plus, ArchiveRestore, Trash2 } from "lucide-react";
import SearchResults from "@/components/SearchResults";
import SearchFilters, { SourceFilter } from "@/components/SearchFilters";
import { SearchResult } from "@/components/SearchResultCard";
import LeafIcon from "@/components/icons/LeafIcon";
import BrowseSection from "@/components/BrowseSection";
import CanvasView from "@/components/CanvasView";

const ALL_SUGGESTIONS = [
  "Dashboard UI", "Landing Page", "Login Form", "Contact Form",
  "Pricing Table", "Hero Section", "Navigation Menu", "Card Design",
  "Dark Mode", "Mobile App", "Onboarding Flow", "Settings Page",
  "Finance App", "Fintech", "E-commerce", "Portfolio",
  "SaaS Product", "Analytics", "Minimal Design", "Typography",
  "Color Palette", "Icon Set", "Illustration", "Data Table",
  "Search UI", "Profile Page", "Checkout Flow", "Empty State",
  "Error Page", "Loading State", "Notification", "Modal",
];

function getRandomSuggestions(count = 4): string[] {
  const shuffled = [...ALL_SUGGESTIONS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

function displayName(path: string) {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001";

type ThemeMedia = { type: "video"; src: string } | { type: "image"; src: string };

const THEMES: ThemeMedia[] = [
  { type: "video", src: "/videos/leaf-animation.mp4" },
];

const CROSSFADE_SECS = 1.5;

const NOTE_COLORS = [
  { bg: '#a8f0c6', text: '#1a5c3a' },
  { bg: '#fde68a', text: '#78350f' },
  { bg: '#bfdbfe', text: '#1e3a8a' },
  { bg: '#fecaca', text: '#7f1d1d' },
  { bg: '#e9d5ff', text: '#4c1d95' },
];

type NoteColor = typeof NOTE_COLORS[number];
type Note = { id: string; title: string; body: string; createdAt: string; color: NoteColor; x: number; y: number; image?: string };

function getDefaultPosition(index: number): { x: number; y: number } {
  const cols = 4;
  return { x: 20 + (index % cols) * 222, y: 20 + Math.floor(index / cols) * 202 };
}

function compressImage(file: File): Promise<string> {
  return new Promise((resolve) => {
    const img = new globalThis.Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const MAX = 560;
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.78));
    };
    img.src = url;
  });
}

type ActiveView = "search" | "browse" | "canvas" | "save";
type MentionType = "folder" | "board" | null;
interface ActiveScope { type: "folder" | "board"; value: string }

export default function Home() {
  const [activeView, setActiveView] = useState<ActiveView>("search");
  const [searchQuery, setSearchQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [themeIndex, setThemeIndex] = useState(0);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [folders, setFolders] = useState<string[]>([]);
  const [boards, setBoards] = useState<string[]>([]);
  const [selectedFolder, setSelectedFolder] = useState("");
  const [selectedBoard, setSelectedBoard] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>(() => getRandomSuggestions(4));
  const [suggestionsVisible, setSuggestionsVisible] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Save tab state
  const [savePopoverOpen, setSavePopoverOpen] = useState(false);
  const [savePanelMode, setSavePanelMode] = useState<"link" | "note" | null>(null);
  const [saveUrl, setSaveUrl] = useState("");
  const [saveLoading, setSaveLoading] = useState(false);
  const [saveResult, setSaveResult] = useState<{ success: boolean; title?: string; error?: string } | null>(null);
  const [noteTitle, setNoteTitle] = useState("");
  const [noteBody, setNoteBody] = useState("");
  const [notes, setNotes] = useState<Note[]>([]);
  const [editingNote, setEditingNote] = useState<Note | null>(null);
  const [selectedNoteColor, setSelectedNoteColor] = useState<NoteColor>(NOTE_COLORS[1]);
  const [noteImage, setNoteImage] = useState<string | null>(null);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [saveSubView, setSaveSubView] = useState<'notes' | 'links'>('notes');
  const [omLinks, setOmLinks] = useState<Array<{ id: string; url: string; title: string; created_at: string }>>([]);
  const [omLinksLoading, setOmLinksLoading] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [archivedNotes, setArchivedNotes] = useState<Note[]>([]);
  const [archivedLinks, setArchivedLinks] = useState<Array<{ id: string; url: string; title: string; created_at: string }>>([]);
  const [showNotesArchive, setShowNotesArchive] = useState(false);
  const [showLinksArchive, setShowLinksArchive] = useState(false);

  // Mention / scope state
  const [mentionType, setMentionType] = useState<MentionType>(null);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionOpen, setMentionOpen] = useState(false);
  const [activeScope, setActiveScope] = useState<ActiveScope | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const videoBRef = useRef<HTMLVideoElement>(null);
  const [videoOpacity, setVideoOpacity] = useState({ a: 1, b: 0 });
  const activeVideoRef = useRef<"a" | "b">("a");
  const crossfadingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const mentionContainerRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<{ id: string; startPX: number; startPY: number; origX: number; origY: number; currentX: number; currentY: number; hasDragged: boolean } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const userName = "TEJA";

  useEffect(() => {
    const fetchFilters = async () => {
      try {
        const foldersRes = await fetch(`${BACKEND_URL}/folders`);
        if (foldersRes.ok) setFolders((await foldersRes.json()).folders || []);
        const boardsRes = await fetch(`${BACKEND_URL}/boards`);
        if (boardsRes.ok) setBoards((await boardsRes.json()).boards || []);
      } catch (error) {
        console.error("Error fetching filters:", error);
      }
    };
    fetchFilters();
  }, []);

  // Load sticky notes from Supabase (via backend), fall back to localStorage
  useEffect(() => {
    const mapNote = (n: { id: string; title: string | null; body: string | null; created_at: string; color_bg: string; color_text: string; pos_x: number | null; pos_y: number | null; image_data: string | null }, i: number): Note => ({
      id: n.id,
      title: n.title ?? '',
      body: n.body ?? '',
      createdAt: n.created_at,
      color: { bg: n.color_bg, text: n.color_text },
      x: n.pos_x ?? getDefaultPosition(i).x,
      y: n.pos_y ?? getDefaultPosition(i).y,
      ...(n.image_data ? { image: n.image_data } : {}),
    });

    const init = async () => {
      try {
        const [res, archivedRes] = await Promise.all([
          fetch(`${BACKEND_URL}/notes`),
          fetch(`${BACKEND_URL}/archived-notes`),
        ]);
        if (res.ok) {
          const data = await res.json();
          const fromServer: Note[] = (data.notes || []).map(mapNote);

          // One-time migration: push any localStorage notes not yet in Supabase
          const serverIds = new Set(fromServer.map((n) => n.id));
          try {
            const stored = localStorage.getItem("om-sticky-notes");
            if (stored) {
              const local = (JSON.parse(stored) as Array<{ id: string; title: string; body: string; createdAt: string; color?: NoteColor }>)
                .filter(n => !serverIds.has(n.id));
              for (let i = 0; i < local.length; i++) {
                const note = local[i];
                const color = note.color ?? NOTE_COLORS[i % NOTE_COLORS.length];
                const pos = getDefaultPosition(fromServer.length + i);
                const x = (note as Note).x ?? pos.x;
                const y = (note as Note).y ?? pos.y;
                await fetch(`${BACKEND_URL}/notes`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ ...note, color, x, y }),
                });
                fromServer.unshift({ ...note, color, x, y });
              }
              if (local.length > 0) localStorage.removeItem("om-sticky-notes");
            }
          } catch {}

          setNotes(fromServer);
          if (archivedRes.ok) {
            const archivedData = await archivedRes.json();
            setArchivedNotes((archivedData.notes || []).map(mapNote));
          }
          return;
        }
      } catch {}

      // Fallback: localStorage (offline / backend down)
      try {
        const stored = localStorage.getItem("om-sticky-notes");
        if (stored) {
          const parsed = JSON.parse(stored);
          setNotes(parsed.map((n: Note & { color?: NoteColor }, i: number) => ({
            ...n,
            color: n.color ?? NOTE_COLORS[i % NOTE_COLORS.length],
            x: n.x ?? getDefaultPosition(i).x,
            y: n.y ?? getDefaultPosition(i).y,
          })));
        }
      } catch {}
    };
    init();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Detect mobile breakpoint
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // Fetch OM saved links + archived links when that sub-view is opened
  useEffect(() => {
    if (saveSubView !== 'links') return;
    setOmLinksLoading(true);
    const loadLinks = async () => {
      try {
        const r = await fetch(`${BACKEND_URL}/om-links`);
        if (r.ok) setOmLinks((await r.json()).links || []);
      } catch {}
      try {
        const r = await fetch(`${BACKEND_URL}/archived-links`);
        if (r.ok) setArchivedLinks((await r.json()).links || []);
      } catch {}
      setOmLinksLoading(false);
    };
    loadLinks();
  }, [saveSubView]);

  // Paste image when note modal is open
  useEffect(() => {
    if (savePanelMode !== 'note') return;
    const handlePaste = async (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items ?? []);
      const imgItem = items.find(it => it.type.startsWith('image/'));
      if (!imgItem) return;
      const file = imgItem.getAsFile();
      if (!file) return;
      const dataUrl = await compressImage(file);
      setNoteImage(dataUrl);
    };
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [savePanelMode]);

  // Close mention dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (mentionContainerRef.current && !mentionContainerRef.current.contains(e.target as Node)) {
        setMentionOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const switchTheme = (idx: number) => {
    setThemeIndex(idx);
  };

  // Crossfade loop: when the active video nears its end, fade in the other one from the start
  useEffect(() => {
    const a = videoRef.current;
    const b = videoBRef.current;
    if (!a || !b || THEMES[themeIndex].type !== "video") return;

    activeVideoRef.current = "a";
    crossfadingRef.current = false;
    setVideoOpacity({ a: 1, b: 0 });
    a.load();
    a.play().catch(() => {});

    const check = () => {
      if (crossfadingRef.current) return;
      const curr = activeVideoRef.current === "a" ? a : b;
      const next = activeVideoRef.current === "a" ? b : a;
      if (!curr.duration || curr.duration - curr.currentTime > CROSSFADE_SECS) return;

      crossfadingRef.current = true;
      next.currentTime = 0;
      next.play().catch(() => {});

      const newActive = activeVideoRef.current === "a" ? "b" : "a";
      activeVideoRef.current = newActive;
      setVideoOpacity(newActive === "b" ? { a: 0, b: 1 } : { a: 1, b: 0 });

      setTimeout(() => { crossfadingRef.current = false; }, CROSSFADE_SECS * 1000);
    };

    a.addEventListener("timeupdate", check);
    b.addEventListener("timeupdate", check);

    return () => {
      a.removeEventListener("timeupdate", check);
      b.removeEventListener("timeupdate", check);
      a.pause();
      b.pause();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeIndex]);

  // Detect @ or # trigger in current cursor word
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSearchQuery(value);

    const cursor = e.target.selectionStart ?? value.length;
    const before = value.slice(0, cursor);

    const atMatch = before.match(/@(\S*)$/);
    const hashMatch = before.match(/#(\S*)$/);

    if (atMatch) {
      setMentionType("folder");
      setMentionQuery(atMatch[1]);
      setMentionOpen(true);
    } else if (hashMatch) {
      setMentionType("board");
      setMentionQuery(hashMatch[1]);
      setMentionOpen(true);
    } else {
      setMentionOpen(false);
      setMentionType(null);
      setMentionQuery("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setMentionOpen(false);
    }
  };

  // User picks a folder or board from the dropdown
  const handleScopeSelect = (item: string) => {
    // Strip the @... or #... trigger from the query
    const trigger = mentionType === "folder" ? "@" : "#";
    const cleaned = searchQuery.replace(new RegExp(`${trigger}\\S*`), "").trim();
    setSearchQuery(cleaned);

    const type = mentionType!;
    if (type === "folder") {
      setSelectedFolder(item);
      setSelectedBoard("");
      setSourceFilter("chrome");
    } else {
      setSelectedBoard(item);
      setSelectedFolder("");
      setSourceFilter("pinterest");
    }
    setActiveScope({ type, value: item });
    setMentionOpen(false);
    setMentionType(null);
    setMentionQuery("");
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  // Clear the active scope chip
  const clearScope = () => {
    setActiveScope(null);
    setSelectedFolder("");
    setSelectedBoard("");
    setSourceFilter("all");
    inputRef.current?.focus();
  };

  // Filtered mention list
  const mentionList = mentionType === "folder"
    ? folders.filter(f => displayName(f).toLowerCase().includes(mentionQuery.toLowerCase()))
    : boards.filter(b => b.toLowerCase().includes(mentionQuery.toLowerCase()));

  const performSearch = useCallback(
    async (query: string, source: SourceFilter, folder?: string, board?: string) => {
      if (query.length < 2) {
        setResults([]);
        setHasSearched(false);
        return;
      }
      setIsLoading(true);
      setHasSearched(true);
      try {
        const params = new URLSearchParams({ q: query, limit: "100", offset: "0" });
        if (source !== "all") params.set("source", source === "chrome" ? "chrome_bookmarks" : source);
        if (folder) params.set("folder", folder);
        if (board) params.set("board", board);
        const res = await fetch(`${BACKEND_URL}/search?${params.toString()}`);
        if (!res.ok) throw new Error("Search failed");
        const data = await res.json();
        setResults(
          data.results.map(
            (item: { title: string; url: string; folder: string | null; source: string; imageUrl: string | null }, i: number) => ({
              id: `${i}-${item.url}`,
              title: item.title,
              folder: item.folder || "Bookmarks",
              url: item.url,
              source: item.source.includes("chrome") ? "chrome" : "pinterest",
              imageUrl: item.imageUrl || undefined,
            })
          )
        );
      } catch {
        setResults([]);
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchQuery) performSearch(searchQuery, sourceFilter, selectedFolder, selectedBoard);
      else { setResults([]); setHasSearched(false); }
    }, 350);
    return () => clearTimeout(timer);
  }, [searchQuery, sourceFilter, selectedFolder, selectedBoard, performSearch]);

  // When switching to collections, clear search state
  const handleViewSwitch = (view: ActiveView) => {
    setActiveView(view);
    if (view === "browse") {
      setSearchQuery("");
      setResults([]);
      setHasSearched(false);
      setMentionOpen(false);
    }
    if (view !== "save") { setSaveResult(null); setSavePopoverOpen(false); setSavePanelMode(null); }
  };

  const handleSaveNote = async () => {
    if (!noteBody.trim() && !noteTitle.trim()) return;

    if (editingNote) {
      // ── Edit existing note ──
      const updated: Note = { ...editingNote, title: noteTitle.trim(), body: noteBody.trim(), color: selectedNoteColor, image: noteImage ?? undefined };
      setNotes(prev => prev.map(n => n.id === editingNote.id ? updated : n));
      setEditingNote(null);
      setNoteTitle("");
      setNoteBody("");
      setNoteImage(null);
      setSavePanelMode(null);
      try {
        await fetch(`${BACKEND_URL}/notes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...updated, image: updated.image ?? null }),
        });
      } catch {}
    } else {
      // ── Create new note ──
      const pos = getDefaultPosition(notes.length);
      const newNote: Note = {
        id: Date.now().toString(),
        title: noteTitle.trim(),
        body: noteBody.trim(),
        createdAt: new Date().toISOString(),
        color: selectedNoteColor,
        x: pos.x,
        y: pos.y,
        ...(noteImage ? { image: noteImage } : {}),
      };
      setNotes(prev => [newNote, ...prev]);
      setNoteTitle("");
      setNoteBody("");
      setNoteImage(null);
      setSavePanelMode(null);
      try {
        const r = await fetch(`${BACKEND_URL}/notes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...newNote, image: newNote.image ?? null }),
        });
        if (!r.ok) throw new Error('backend error');
      } catch {
        localStorage.setItem("om-sticky-notes", JSON.stringify([newNote, ...notes]));
      }
    }
  };

  const deleteNote = async (id: string) => {
    const note = notes.find(n => n.id === id);
    if (note) setArchivedNotes(prev => [note, ...prev]);
    setNotes(prev => prev.filter(n => n.id !== id));
    try {
      await fetch(`${BACKEND_URL}/notes/${id}`, { method: 'DELETE' });
    } catch {}
  };

  const restoreNote = async (note: Note) => {
    setArchivedNotes(prev => prev.filter(n => n.id !== note.id));
    setNotes(prev => [note, ...prev]);
    try {
      await fetch(`${BACKEND_URL}/restore-note/${note.id}`, { method: 'POST' });
    } catch {}
  };

  const permanentlyDeleteNote = async (id: string) => {
    setArchivedNotes(prev => prev.filter(n => n.id !== id));
    try {
      await fetch(`${BACKEND_URL}/notes/${id}/permanent`, { method: 'DELETE' });
    } catch {}
  };

  const onNoteDragStart = (e: React.PointerEvent<HTMLDivElement>, note: Note) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.cursor = 'grabbing';
    dragStateRef.current = { id: note.id, startPX: e.clientX, startPY: e.clientY, origX: note.x, origY: note.y, currentX: note.x, currentY: note.y, hasDragged: false };
  };

  const onNoteDragMove = (e: React.PointerEvent<HTMLDivElement>, noteId: string) => {
    const d = dragStateRef.current;
    if (!d || d.id !== noteId) return;
    const dx = e.clientX - d.startPX;
    const dy = e.clientY - d.startPY;
    const newX = Math.max(0, d.origX + dx);
    const newY = Math.max(0, d.origY + dy);
    d.currentX = newX;
    d.currentY = newY;
    if (!d.hasDragged && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) d.hasDragged = true;
    if (d.hasDragged) setNotes(prev => prev.map(n => n.id === noteId ? { ...n, x: newX, y: newY } : n));
  };

  const onNoteDragEnd = (e: React.PointerEvent<HTMLDivElement>, noteId: string) => {
    const d = dragStateRef.current;
    if (!d || d.id !== noteId) return;
    const { hasDragged, currentX, currentY } = d;
    dragStateRef.current = null;
    document.body.style.cursor = '';
    if (hasDragged) {
      setNotes(prev => prev.map(n => n.id === noteId ? { ...n, x: currentX, y: currentY } : n));
      const base = notes.find(n => n.id === noteId);
      if (base) {
        fetch(`${BACKEND_URL}/notes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...base, x: currentX, y: currentY }),
        }).catch(() => {});
      }
    }
  };

  const handleSaveLink = async () => {
    if (!saveUrl.trim() || saveLoading) return;
    setSaveLoading(true);
    setSaveResult(null);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 40000);
      let res: Response;
      try {
        res = await fetch(`${BACKEND_URL}/save-link`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: saveUrl.trim() }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      const data = await res.json();
      if (res.ok) {
        setSaveResult({ success: true, title: data.title });
        const savedUrl = saveUrl.trim();
        setSaveUrl("");
        // Optimistically prepend to local list — no refetch needed
        setOmLinks(prev => [{
          id: Date.now().toString(),
          url: data.url || savedUrl,
          title: data.title || savedUrl,
          created_at: new Date().toISOString(),
        }, ...prev]);
        setTimeout(() => setSaveResult(null), 2500);
      } else {
        setSaveResult({ success: false, error: data.error || "Failed to save" });
      }
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      setSaveResult({ success: false, error: isTimeout ? "Server is waking up — please try again in a moment" : "Network error — check your connection" });
    } finally {
      setSaveLoading(false);
    }
  };

  return (
    <div className="relative w-full h-[100dvh] overflow-hidden bg-[#ebfdff]">

      {/* Background — video or image depending on active theme */}
      {THEMES[themeIndex].type === "video" ? (
        <>
          <video
            ref={videoRef}
            className="absolute inset-0 w-full h-full object-cover md:object-fill"
            muted playsInline
            style={{ opacity: videoOpacity.a, transition: `opacity ${CROSSFADE_SECS}s ease-in-out` }}
          >
            <source src={THEMES[themeIndex].src} type="video/mp4" />
          </video>
          <video
            ref={videoBRef}
            className="absolute inset-0 w-full h-full object-cover md:object-fill"
            muted playsInline
            style={{ opacity: videoOpacity.b, transition: `opacity ${CROSSFADE_SECS}s ease-in-out` }}
          >
            <source src={THEMES[themeIndex].src} type="video/mp4" />
          </video>
        </>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={THEMES[themeIndex].src}
          alt=""
          className="absolute inset-0 w-full h-full object-cover md:object-fill"
        />
      )}

      {/* Top Gradient */}
      <div className="hidden sm:block absolute top-[-36px] left-0 right-0 h-[142px] z-10 pointer-events-none">
        <Image src="/images/top-gradient.png" alt="" fill className="object-cover" priority />
      </div>
      <div className="sm:hidden absolute top-0 left-0 right-0 h-20 bg-gradient-to-b from-[#ebfdff]/80 to-transparent z-10 pointer-events-none" />


      {/* ══════════════════════════════════════════
          SEARCH VIEW
          ══════════════════════════════════════════ */}
      <div
        className={`absolute inset-0 transition-all duration-500 ease-[cubic-bezier(0.4,0,0.2,1)] ${
          activeView === "search" ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
      >
        {/* Headline */}
        <div
          className={`absolute left-1/2 -translate-x-1/2 top-[65px] sm:top-[130px] flex flex-col items-center justify-center p-2 sm:p-[10px] z-10 transition-all duration-500 ease-out ${
            hasSearched ? "opacity-0 -translate-y-8 pointer-events-none" : "opacity-100 translate-y-0"
          }`}
        >
          <div className="flex items-center justify-center gap-2 sm:gap-[10px]">
            <h1 className="gradient-text font-semibold text-xl sm:text-[36px] text-center whitespace-nowrap" style={{ fontFamily: "var(--font-baloo-2), sans-serif" }}>
              Find what inspires you
            </h1>
            <LeafIcon className="w-5 h-5 sm:w-[30px] sm:h-[30px]" />
          </div>
        </div>

        {/* Search Bar */}
        <div
          ref={mentionContainerRef}
          className={`absolute left-1/2 -translate-x-1/2 z-30 px-4 sm:px-0 transition-all duration-500 ease-[cubic-bezier(0.4,0,0.2,1)] pointer-events-none ${
            hasSearched
              ? "top-2 sm:top-[12px] w-full sm:w-[90%] max-w-[928px]"
              : "top-[120px] sm:top-[200px] w-full sm:w-[95%] max-w-[836px]"
          }`}
        >
          <form onSubmit={(e) => { e.preventDefault(); performSearch(searchQuery, sourceFilter, selectedFolder, selectedBoard); }} className="w-full pointer-events-auto">
            <div className={`w-full flex items-center bg-white/[0.38] border-4 border-solid border-[#5b9888] rounded-[13px] transition-all duration-500 ease-out ${hasSearched ? "px-3 sm:px-[10px] py-1.5 sm:py-[5px]" : "px-3 sm:px-[14px] py-2 sm:py-[8px]"}`}>
              <div className="flex items-center gap-2 sm:gap-[10px] flex-1 min-w-0">
                <Search className="w-4 h-4 text-[#646464] flex-shrink-0" />

                {/* Active scope chip — folder or board */}
                {activeScope && (
                  <div className="flex items-center gap-1 bg-[#5b9888]/15 border border-[#5b9888]/30 rounded-full px-2 py-0.5 flex-shrink-0">
                    {activeScope.type === "folder"
                      ? <Bookmark className="w-2.5 h-2.5 text-[#3d7a64]" />
                      : <Hash className="w-2.5 h-2.5 text-[#3d7a64]" />
                    }
                    <span className="text-[11px] font-medium text-[#3d7a64] max-w-[120px] truncate">
                      {displayName(activeScope.value)}
                    </span>
                    <button
                      type="button"
                      onClick={clearScope}
                      className="text-[#3d7a64]/60 hover:text-[#3d7a64] transition-colors"
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </div>
                )}

                <input
                  ref={inputRef}
                  type="text"
                  value={searchQuery}
                  onChange={handleInputChange}
                  onKeyDown={handleKeyDown}
                  placeholder={activeScope ? "Search within..." : "Search... or @ folders, # boards"}
                  className={`flex-1 min-w-0 bg-transparent outline-none placeholder:text-[#3a3a3a]/60 text-[#3a3a3a] transition-all duration-300 ${hasSearched ? "text-sm sm:text-[14px] leading-5 sm:leading-[20px]" : "text-base sm:text-[16px] leading-6 sm:leading-[24px]"}`}
                  style={{ fontFamily: "var(--font-geist), sans-serif" }}
                />
              </div>
            </div>
          </form>

          {/* Mention dropdown */}
          {mentionOpen && mentionList.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-2 bg-white/90 backdrop-blur-md rounded-xl shadow-lg border border-[#5b9888]/20 overflow-hidden z-30 max-h-52 overflow-y-auto custom-scrollbar pointer-events-auto">
              <div className="px-3 py-1.5 border-b border-[#5b9888]/10">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-[#3a3a3a]/40">
                  {mentionType === "folder" ? "Bookmark Folders" : "Pinterest Boards"}
                </p>
              </div>
              {mentionList.map((item) => (
                <button
                  key={item}
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); handleScopeSelect(item); }}
                  className="w-full text-left px-3 py-2 flex items-center gap-2.5 hover:bg-[#5b9888]/8 transition-colors duration-100 group"
                >
                  {mentionType === "folder"
                    ? <Bookmark className="w-3 h-3 text-[#5b9888]/50 group-hover:text-[#5b9888] flex-shrink-0 transition-colors" />
                    : <Hash className="w-3 h-3 text-[#5b9888]/50 group-hover:text-[#5b9888] flex-shrink-0 transition-colors" />
                  }
                  <span className="text-sm text-[#3a3a3a]/80 group-hover:text-[#3a3a3a] truncate transition-colors">
                    {displayName(item)}
                  </span>
                  {item !== displayName(item) && (
                    <span className="text-[10px] text-[#3a3a3a]/30 truncate ml-auto flex-shrink-0">
                      {item}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* No matches hint */}
          {mentionOpen && mentionList.length === 0 && mentionQuery.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-2 bg-white/90 backdrop-blur-md rounded-xl shadow-lg border border-[#5b9888]/20 z-30 px-4 py-3">
              <p className="text-xs text-[#3a3a3a]/40">
                No {mentionType === "folder" ? "folders" : "boards"} matching &quot;{mentionQuery}&quot;
              </p>
            </div>
          )}

          {/* Suggestion chips */}
          <div className={`flex flex-col items-center gap-2 mt-3 transition-all duration-500 ease-out pointer-events-auto ${hasSearched ? "opacity-0 pointer-events-none" : "opacity-100"}`}>
            <div className={`flex items-center justify-center gap-2 flex-wrap transition-all duration-300 ease-in-out ${suggestionsVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1"}`}>
              {suggestions.map((s) => (
                <button key={s} onClick={() => { setSearchQuery(s); performSearch(s, sourceFilter, selectedFolder, selectedBoard); }}
                  className="flex items-center px-3 py-1.5 rounded-full bg-white/50 backdrop-blur-sm border border-[#5b9888]/20 text-[11px] sm:text-xs text-[#3a3a3a]/70 hover:bg-white/80 hover:text-[#5b9888] hover:border-[#5b9888]/50 transition-all duration-200 whitespace-nowrap shadow-sm">
                  {s}
                </button>
              ))}
              <button
                onClick={() => {
                  if (isRefreshing) return;
                  setIsRefreshing(true); setSuggestionsVisible(false);
                  setTimeout(() => { setSuggestions(getRandomSuggestions(4)); setSuggestionsVisible(true); setIsRefreshing(false); }, 300);
                }}
                className="p-1.5 rounded-full bg-white/50 backdrop-blur-sm border border-[#5b9888]/20 text-[#3a3a3a]/40 hover:text-[#5b9888] hover:bg-white/80 hover:border-[#5b9888]/50 transition-all duration-200 shadow-sm"
              >
                <RefreshCw className={`w-3 h-3 sm:w-3.5 sm:h-3.5 transition-transform duration-300 ${isRefreshing ? "rotate-180" : "rotate-0"}`} />
              </button>
            </div>
          </div>
        </div>

        {/* Search Results overlay */}
        <div
          className={`absolute inset-x-0 bottom-0 z-20 px-3 sm:px-4 md:px-0 transition-all duration-500 ease-[cubic-bezier(0.4,0,0.2,1)] ${
            hasSearched ? "top-[56px] sm:top-[60px] opacity-100 translate-y-0" : "top-full opacity-0 pointer-events-none"
          }`}
        >
          <div className="w-full md:w-[95%] max-w-[1200px] mx-auto flex flex-col gap-3 sm:gap-4 h-full">
            <div className="relative z-20 flex-shrink-0">
              <SearchFilters
                activeSource={sourceFilter}
                onSourceChange={(s) => { setSourceFilter(s); if (s !== "chrome") { setSelectedFolder(""); if (activeScope?.type === "folder") setActiveScope(null); } if (s !== "pinterest") { setSelectedBoard(""); if (activeScope?.type === "board") setActiveScope(null); } }}
                resultCount={results.length}
                folders={folders}
                boards={boards}
                selectedFolder={selectedFolder}
                selectedBoard={selectedBoard}
                onFolderChange={setSelectedFolder}
                onBoardChange={setSelectedBoard}
              />
            </div>
            <div className="relative z-10 flex-1 overflow-y-auto custom-scrollbar pb-4">
              <SearchResults results={results} isLoading={isLoading} />
            </div>
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════
          COLLECTIONS VIEW
          ══════════════════════════════════════════ */}
      <div
        className={`absolute inset-0 z-10 transition-all duration-500 ease-[cubic-bezier(0.4,0,0.2,1)] ${
          activeView === "browse" ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
      >
        {/* Frosted glass panel */}
        <div className="absolute inset-0 bg-[#ebfdff]/80 backdrop-blur-sm" />

        {/* Collections content */}
        <div className="relative z-10 h-full flex flex-col pt-4 sm:pt-16 pb-4 px-4 sm:px-6 md:px-8 overflow-hidden">
          <div className="flex-1 min-h-0 w-full max-w-[1200px] mx-auto overflow-y-auto custom-scrollbar">
            <BrowseSection folders={folders} boards={boards} constrained />
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════
          CANVAS VIEW
          ══════════════════════════════════════════ */}
      <div
        className={`absolute inset-0 z-10 transition-all duration-500 ease-[cubic-bezier(0.4,0,0.2,1)] ${
          activeView === "canvas" ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
      >
        <CanvasView folders={folders} boards={boards} active={activeView === "canvas"} />
      </div>

      {/* ══════════════════════════════════════════
          SAVE VIEW — dotted canvas + sticky notes
          ══════════════════════════════════════════ */}
      <div
        className={`absolute inset-0 z-10 transition-all duration-500 ease-[cubic-bezier(0.4,0,0.2,1)] ${
          activeView === "save" ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
      >
        {/* Dotted grid background */}
        <div
          className="absolute inset-0"
          style={{
            backgroundColor: '#f2f9f7',
            backgroundImage: 'radial-gradient(circle, rgba(91,152,136,0.25) 1px, transparent 1px)',
            backgroundSize: '24px 24px',
          }}
        />

        {/* ── NOTES canvas ── */}
        <div className={`relative z-10 h-full flex flex-col ${saveSubView !== 'notes' ? 'hidden' : ''}`}>
          {/* Header bar */}
          <div className="flex-shrink-0 flex items-center justify-between px-5 py-3 z-20" style={{ borderBottom: '1px solid rgba(91,152,136,0.12)', background: 'rgba(242,249,247,0.85)', backdropFilter: 'blur(8px)' }}>
            <p className="text-sm font-semibold text-[#1a1a1a]" style={{ fontFamily: "var(--font-geist), sans-serif" }}>Notes</p>
            <button
              onClick={() => setShowNotesArchive(v => !v)}
              className="flex items-center gap-1.5 text-xs font-medium transition-all"
              style={{ color: showNotesArchive ? '#5b9888' : 'rgba(58,58,58,0.4)', fontFamily: "var(--font-geist), sans-serif" }}
            >
              {showNotesArchive ? <X className="w-4 h-4" /> : <ArchiveRestore className="w-4 h-4" />}
              <span>{showNotesArchive ? 'Close' : 'Archive'}</span>
              {!showNotesArchive && archivedNotes.length > 0 && <span className="text-[10px] bg-[#5b9888] text-white rounded-full px-1.5 py-0.5 leading-none">{archivedNotes.length}</span>}
            </button>
          </div>

          <div className="flex-1 overflow-auto custom-scrollbar relative">

          {/* Notes archive panel */}
          {showNotesArchive && (
            <div className="absolute inset-0 z-10 overflow-y-auto custom-scrollbar" style={{ background: 'rgba(242,249,247,0.97)', backdropFilter: 'blur(8px)' }}>
              <div className="pt-4 pb-28 px-4 max-w-2xl mx-auto">
                {archivedNotes.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-20 select-none pointer-events-none">
                    <ArchiveRestore className="w-8 h-8 text-[#5b9888]/20 mb-2" />
                    <p className="text-sm text-[#3a3a3a]/25">No archived notes</p>
                  </div>
                ) : (
                  <div style={{ columns: 2, columnGap: 12 }}>
                    {archivedNotes.map(note => (
                      <div key={note.id} className="rounded-[10px] mb-3" style={{ breakInside: 'avoid', background: note.color?.bg ?? '#fde68a', padding: 12, opacity: 0.8 }}>
                        {note.title && <p className="text-sm font-semibold leading-snug break-words mb-1" style={{ color: note.color?.text ?? '#78350f' }}>{note.title}</p>}
                        {note.body && <p className="text-xs whitespace-pre-wrap leading-relaxed opacity-80 break-words" style={{ color: note.color?.text ?? '#78350f' }}>{note.body}</p>}
                        <div className="flex gap-2 mt-3">
                          <button onClick={() => restoreNote(note)} className="flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-md transition-colors" style={{ background: 'rgba(0,0,0,0.08)', color: note.color?.text ?? '#78350f' }}>
                            <ArchiveRestore className="w-3 h-3" /> Restore
                          </button>
                          <button onClick={() => permanentlyDeleteNote(note.id)} className="flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-md transition-colors" style={{ background: 'rgba(0,0,0,0.08)', color: note.color?.text ?? '#78350f' }}>
                            <Trash2 className="w-3 h-3" /> Delete
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
          {notes.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center select-none pointer-events-none">
              <StickyNote className="w-10 h-10 text-[#5b9888]/20 mb-3" />
              <p className="text-sm text-[#3a3a3a]/25 font-medium">Hit + to add a note</p>
            </div>
          ) : isMobile ? (
            /* ── Mobile: 2-column grid, LIFO, no drag ── */
            <div style={{ columns: 2, columnGap: 12, padding: 16, paddingBottom: 128 }}>
              {notes.map((note) => (
                <div
                  key={note.id}
                  className="relative group rounded-[10px]"
                  style={{ breakInside: 'avoid', marginBottom: 12, background: note.color?.bg ?? '#fde68a', padding: 14, boxShadow: '0 2px 10px rgba(0,0,0,0.08)' }}
                  onDoubleClick={() => { setEditingNote(note); setNoteTitle(note.title); setNoteBody(note.body); setSelectedNoteColor(note.color); setNoteImage(note.image ?? null); setSavePanelMode("note"); }}
                >
                  <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity rounded-lg" style={{ padding: '3px 5px', background: note.image ? 'rgba(0,0,0,0.32)' : 'transparent' }}>
                    <button onClick={() => { setEditingNote(note); setNoteTitle(note.title); setNoteBody(note.body); setSelectedNoteColor(note.color); setNoteImage(note.image ?? null); setSavePanelMode("note"); }} className="opacity-70 hover:opacity-100 transition-opacity" style={{ color: note.image ? 'white' : (note.color?.text ?? '#78350f') }}>
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => deleteNote(note.id)} className="opacity-70 hover:opacity-100 transition-opacity" style={{ color: note.image ? 'white' : (note.color?.text ?? '#78350f') }}>
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {note.image && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={note.image} alt="" className="w-full rounded-md object-cover mb-1 cursor-zoom-in" style={{ maxHeight: 100 }} onClick={() => setLightboxImage(note.image!)} />
                  )}
                  {note.title && <p className="text-sm font-semibold pr-5 leading-snug break-words" style={{ color: note.color?.text ?? '#78350f' }}>{note.title}</p>}
                  {note.body && <p className="text-xs whitespace-pre-wrap leading-relaxed opacity-80 mt-1 break-words" style={{ color: note.color?.text ?? '#78350f' }}>{note.body}</p>}
                  <p className="text-[10px] opacity-40 mt-3" style={{ color: note.color?.text ?? '#78350f' }}>
                    {new Date(note.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            /* ── Desktop: freely positionable, draggable ── */
            <div className="relative" style={{ minWidth: '100%', minHeight: 'calc(100% + 200px)' }}>
              {notes.map((note) => (
                <div
                  key={note.id}
                  className="absolute group select-none"
                  style={{ left: note.x, top: note.y, width: 200, background: note.color?.bg ?? '#fde68a', borderRadius: 10, padding: 14, boxShadow: '0 2px 12px rgba(0,0,0,0.10)', cursor: 'grab', touchAction: 'none' }}
                  onPointerDown={(e) => onNoteDragStart(e, note)}
                  onPointerMove={(e) => onNoteDragMove(e, note.id)}
                  onPointerUp={(e) => onNoteDragEnd(e, note.id)}
                  onDoubleClick={() => { setEditingNote(note); setNoteTitle(note.title); setNoteBody(note.body); setSelectedNoteColor(note.color); setNoteImage(note.image ?? null); setSavePanelMode("note"); }}
                >
                  <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity rounded-lg" style={{ padding: '3px 5px', background: note.image ? 'rgba(0,0,0,0.32)' : 'transparent' }}>
                    <button onPointerDown={(e) => e.stopPropagation()} onClick={() => { setEditingNote(note); setNoteTitle(note.title); setNoteBody(note.body); setSelectedNoteColor(note.color); setNoteImage(note.image ?? null); setSavePanelMode("note"); }} className="opacity-70 hover:opacity-100 transition-opacity" style={{ color: note.image ? 'white' : (note.color?.text ?? '#78350f') }}>
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button onPointerDown={(e) => e.stopPropagation()} onClick={() => deleteNote(note.id)} className="opacity-70 hover:opacity-100 transition-opacity" style={{ color: note.image ? 'white' : (note.color?.text ?? '#78350f') }}>
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {note.image && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={note.image} alt="" className="w-full rounded-md object-cover mb-1" style={{ maxHeight: 120, cursor: 'zoom-in' }} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); setLightboxImage(note.image!); }} />
                  )}
                  {note.title && <p className="text-sm font-semibold pr-5 leading-snug break-words" style={{ color: note.color?.text ?? '#78350f' }}>{note.title}</p>}
                  {note.body && <p className="text-xs whitespace-pre-wrap leading-relaxed opacity-80 mt-1 break-words" style={{ color: note.color?.text ?? '#78350f' }}>{note.body}</p>}
                  <p className="text-[10px] opacity-40 mt-3" style={{ color: note.color?.text ?? '#78350f' }}>
                    {new Date(note.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  </p>
                </div>
              ))}
            </div>
          )}
          </div>{/* end inner scroll */}
        </div>

        {/* ── LINKS panel ── */}
        {saveSubView === 'links' && (
          <div className="relative z-10 h-full flex flex-col">
            {/* Header bar */}
            <div className="flex-shrink-0 flex items-center justify-between px-5 py-3 z-20" style={{ borderBottom: '1px solid rgba(91,152,136,0.12)', background: 'rgba(242,249,247,0.85)', backdropFilter: 'blur(8px)' }}>
              <p className="text-sm font-semibold text-[#1a1a1a]" style={{ fontFamily: "var(--font-geist), sans-serif" }}>Saved Links</p>
              <button
                onClick={() => setShowLinksArchive(v => !v)}
                className="flex items-center gap-1.5 text-xs font-medium transition-all"
                style={{ color: showLinksArchive ? '#5b9888' : 'rgba(58,58,58,0.4)', fontFamily: "var(--font-geist), sans-serif" }}
              >
                {showLinksArchive ? <X className="w-4 h-4" /> : <ArchiveRestore className="w-4 h-4" />}
                <span>{showLinksArchive ? 'Close' : 'Archive'}</span>
                {!showLinksArchive && archivedLinks.length > 0 && <span className="text-[10px] bg-[#5b9888] text-white rounded-full px-1.5 py-0.5 leading-none">{archivedLinks.length}</span>}
              </button>
            </div>

            <div className="pt-4 px-4">
            {/* Links archive panel */}
            {showLinksArchive && (
              <div className="absolute inset-0 z-10 overflow-y-auto custom-scrollbar" style={{ background: 'rgba(242,249,247,0.97)', backdropFilter: 'blur(8px)' }}>
                <div className="pt-4 pb-28 px-5 max-w-[600px] mx-auto">
                  {archivedLinks.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-20 select-none pointer-events-none">
                      <ArchiveRestore className="w-8 h-8 text-[#5b9888]/20 mb-2" />
                      <p className="text-sm text-[#3a3a3a]/25">No archived links</p>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {archivedLinks.map(link => {
                        let domain = '';
                        try { domain = new URL(link.url).hostname.replace('www.', ''); } catch {}
                        return (
                          <div key={link.id} className="flex items-center gap-3 bg-white/70 backdrop-blur-sm rounded-xl px-4 py-3 shadow-sm" style={{ border: '1px solid rgba(91,152,136,0.15)', opacity: 0.8 }}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={`https://www.google.com/s2/favicons?domain=${domain}&sz=32`} alt="" className="w-5 h-5 rounded flex-shrink-0" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-[#1a1a1a] truncate">{link.title || domain}</p>
                              <p className="text-xs text-[#5b9888] truncate">{domain}</p>
                            </div>
                            <div className="flex gap-1 flex-shrink-0">
                              <button
                                onClick={async () => {
                                  setArchivedLinks(prev => prev.filter(l => l.id !== link.id));
                                  setOmLinks(prev => [link, ...prev]);
                                  try {
                                    await fetch(`${BACKEND_URL}/restore-link`, {
                                      method: 'POST',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ url: link.url }),
                                    });
                                  } catch {}
                                }}
                                className="flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-md bg-[#5b9888]/10 text-[#3d7a64] hover:bg-[#5b9888]/20 transition-colors"
                              >
                                <ArchiveRestore className="w-3 h-3" /> Restore
                              </button>
                              <button
                                onClick={async () => {
                                  setArchivedLinks(prev => prev.filter(l => l.id !== link.id));
                                  try {
                                    await fetch(`${BACKEND_URL}/om-link/permanent?url=${encodeURIComponent(link.url)}`, { method: 'DELETE' });
                                  } catch {}
                                }}
                                className="flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-md bg-red-50 text-red-400 hover:bg-red-100 transition-colors"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Add link input */}
            <div className="flex gap-2 mb-4 max-w-[600px] mx-auto">
              <input
                type="url"
                value={saveUrl}
                onChange={(e) => { setSaveUrl(e.target.value); setSaveResult(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSaveLink(); }}
                placeholder="Paste a URL to save..."
                className="flex-1 rounded-xl px-4 py-2.5 text-sm text-[#1a1a1a] placeholder:text-[#3a3a3a]/30 outline-none bg-white/80"
                style={{ border: '1.5px solid rgba(91,152,136,0.25)', fontFamily: "var(--font-geist), sans-serif" }}
              />
              <button
                onClick={handleSaveLink}
                disabled={!saveUrl.trim() || saveLoading}
                className="px-4 py-2.5 rounded-xl bg-[#5b9888] text-white text-sm font-medium hover:bg-[#4a8070] transition-colors disabled:opacity-40 flex items-center gap-1.5"
                style={{ fontFamily: "var(--font-geist), sans-serif" }}
              >
                {saveLoading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
                {saveLoading ? '' : 'Save'}
              </button>
            </div>
            {saveResult && (
              <p className={`text-xs px-1 mb-3 max-w-[600px] mx-auto ${saveResult.success ? 'text-[#3d7a64]' : 'text-red-500'}`}>
                {saveResult.success ? `Saved: "${saveResult.title}"` : saveResult.error}
              </p>
            )}
            {omLinksLoading ? (
              <div className="h-full flex items-center justify-center">
                <RefreshCw className="w-5 h-5 text-[#5b9888]/40 animate-spin" />
              </div>
            ) : omLinks.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center select-none pointer-events-none">
                <Link2 className="w-10 h-10 text-[#5b9888]/20 mb-3" />
                <p className="text-sm text-[#3a3a3a]/25 font-medium">No saved links yet</p>
              </div>
            ) : (
              <div className="flex flex-col gap-2 max-w-[600px] mx-auto">
                {omLinks.map(link => {
                  let domain = '';
                  try { domain = new URL(link.url).hostname.replace('www.', ''); } catch {}
                  return (
                    <div
                      key={link.id}
                      className="flex items-center gap-3 bg-white/70 backdrop-blur-sm rounded-xl px-4 py-3 shadow-sm"
                      style={{ border: '1px solid rgba(91,152,136,0.15)' }}
                    >
                      {/* Favicon */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`https://www.google.com/s2/favicons?domain=${domain}&sz=32`}
                        alt=""
                        className="w-5 h-5 rounded flex-shrink-0"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-[#1a1a1a] truncate">{link.title || domain}</p>
                        <a
                          href={link.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-[#5b9888] truncate block hover:underline"
                        >
                          {domain}
                        </a>
                      </div>
                      <button
                        onClick={async () => {
                          setArchivedLinks(prev => [link, ...prev]);
                          setOmLinks(prev => prev.filter(l => l.id !== link.id));
                          try {
                            await fetch(`${BACKEND_URL}/om-link?url=${encodeURIComponent(link.url)}`, { method: 'DELETE' });
                          } catch {}
                        }}
                        className="flex-shrink-0 opacity-30 hover:opacity-70 transition-opacity text-[#1a1a1a]"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            </div>{/* end inner scroll */}
          </div>
        )}

        {/* ── Note compose modal ── */}
        {savePanelMode === "note" && (() => {
          const noteColor = selectedNoteColor;
          const closeModal = () => { setSavePanelMode(null); setEditingNote(null); setNoteTitle(""); setNoteBody(""); setNoteImage(null); };
          const saveOrClose = () => { if (noteTitle.trim() || noteBody.trim() || noteImage) handleSaveNote(); else closeModal(); };
          return (
            <div className="absolute inset-0 z-20 flex items-center justify-center p-6" onClick={(e) => { if (e.target === e.currentTarget) saveOrClose(); }}>
              <div
                className="w-full max-w-[420px] rounded-2xl shadow-2xl p-6 flex flex-col gap-3"
                style={{ background: noteColor.bg, transition: 'background 0.2s ease' }}
              >

                {/* Image preview (shown only when an image is attached) */}
                {noteImage && (
                  <div className="relative rounded-xl overflow-hidden">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={noteImage} alt="" className="w-full object-cover rounded-xl" style={{ maxHeight: 180 }} />
                    <button
                      type="button"
                      onClick={() => setNoteImage(null)}
                      className="absolute top-1.5 right-1.5 rounded-full p-0.5 flex items-center justify-center"
                      style={{ background: 'rgba(0,0,0,0.45)', color: 'white' }}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (file) { const url = await compressImage(file); setNoteImage(url); }
                    e.target.value = '';
                  }}
                />

                <input
                  autoFocus
                  type="text"
                  value={noteTitle}
                  onChange={(e) => setNoteTitle(e.target.value)}
                  placeholder="Title"
                  className="w-full bg-transparent outline-none text-base font-semibold placeholder:opacity-40"
                  style={{ color: noteColor.text, fontFamily: "var(--font-geist), sans-serif" }}
                />
                <textarea
                  value={noteBody}
                  onChange={(e) => setNoteBody(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && e.metaKey) saveOrClose(); if (e.key === "Escape") closeModal(); }}
                  placeholder="Type anything..."
                  rows={4}
                  className="w-full bg-transparent outline-none text-sm resize-none placeholder:opacity-40 leading-relaxed"
                  style={{ color: noteColor.text, fontFamily: "var(--font-geist), sans-serif" }}
                />
                {/* Color picker + image icon */}
                <div className="flex items-center gap-2.5">
                  {NOTE_COLORS.map((c, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setSelectedNoteColor(c)}
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: '50%',
                        background: c.bg,
                        border: `2.5px solid ${selectedNoteColor.bg === c.bg ? noteColor.text : 'rgba(0,0,0,0.12)'}`,
                        cursor: 'pointer',
                        transform: selectedNoteColor.bg === c.bg ? 'scale(1.25)' : 'scale(1)',
                        transition: 'transform 0.15s ease, border-color 0.15s ease',
                        flexShrink: 0,
                        outline: 'none',
                      }}
                    />
                  ))}
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="ml-auto transition-opacity hover:opacity-80"
                    style={{ color: noteColor.text, opacity: noteImage ? 1 : 0.4 }}
                    title="Attach image"
                  >
                    <Upload className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

      </div>

      {/* ── Image lightbox ── */}
      {lightboxImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-6"
          style={{ background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(6px)' }}
          onClick={() => setLightboxImage(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightboxImage}
            alt=""
            className="max-w-full max-h-full rounded-xl shadow-2xl object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            onClick={() => setLightboxImage(null)}
            className="absolute top-4 right-4 rounded-full p-1.5 flex items-center justify-center"
            style={{ background: 'rgba(255,255,255,0.15)', color: 'white' }}
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      )}

      {/* ── Bottom dock — liquid glass pill ── */}
      {(() => {
        const VIEWS: ActiveView[] = ["search", "browse", "canvas", "save"];
        const ICONS = { search: Search, browse: LayoutGrid, canvas: Waypoints, save: Plus };
        const LABELS = { search: "Search", browse: "Collections", canvas: "Canvas", save: "Save" };
        const BTN = 44;   // button width & height px
        const PAD = 6;    // container padding px
        const GAP = 4;    // gap between buttons px
        const activeIdx = VIEWS.indexOf(activeView);
        // Indicator left = pad + index*(btn+gap)
        const indicatorLeft = PAD + activeIdx * (BTN + GAP);
        return (
          <div className="absolute left-1/2 -translate-x-1/2 z-40 pointer-events-auto select-none" style={{ bottom: "calc(20px + env(safe-area-inset-bottom))" }}>

            {/* Save popover — floats above the dock, centered */}
            {savePopoverOpen && (
              <>
                <div className="fixed inset-0 z-0" onClick={() => setSavePopoverOpen(false)} />
                <div
                  className="absolute z-10 overflow-hidden"
                  style={{
                    bottom: 'calc(100% + 10px)',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    background: 'rgba(22,22,22,0.92)',
                    backdropFilter: 'blur(20px)',
                    WebkitBackdropFilter: 'blur(20px)',
                    borderRadius: 14,
                    border: '1px solid rgba(255,255,255,0.1)',
                    boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
                    minWidth: 172,
                  }}
                >
                  <button
                    onClick={() => { setSavePopoverOpen(false); setActiveView("save"); setSaveSubView('links'); }}
                    className="w-full flex items-center gap-3 px-4 py-3 text-white/80 hover:text-white transition-colors text-sm"
                    style={{ fontFamily: "var(--font-geist), sans-serif" }}
                  >
                    <Link2 className="w-4 h-4 opacity-70" />
                    <span>Links</span>
                  </button>
                  <div className="h-px" style={{ background: 'rgba(255,255,255,0.08)' }} />
                  <button
                    onClick={() => { setSavePopoverOpen(false); setActiveView("save"); setSaveSubView('notes'); setNoteTitle(""); setNoteBody(""); setNoteImage(null); setSelectedNoteColor(NOTE_COLORS[notes.length % NOTE_COLORS.length]); setSavePanelMode("note"); }}
                    className="w-full flex items-center gap-3 px-4 py-3 text-white/80 hover:text-white transition-colors text-sm"
                    style={{ fontFamily: "var(--font-geist), sans-serif" }}
                  >
                    <StickyNote className="w-4 h-4 opacity-70" />
                    <span>Notes</span>
                  </button>
                </div>
              </>
            )}
            {/* Outer glass container */}
            <div
              className="relative flex items-center"
              style={{
                padding: PAD,
                gap: GAP,
                borderRadius: 22,
                // Dark-neutral base — visible on ANY background (light or dark)
                background: "linear-gradient(160deg, rgba(10,10,10,0.35) 0%, rgba(10,10,10,0.28) 100%)",
                backdropFilter: "blur(40px) saturate(160%)",
                WebkitBackdropFilter: "blur(40px) saturate(160%)",
                border: "1px solid rgba(255,255,255,0.18)",
                boxShadow: [
                  "inset 0 1.5px 0 rgba(255,255,255,0.22)",  // top specular — light catching glass edge
                  "inset 0 -1px 0 rgba(0,0,0,0.3)",          // bottom rim shadow
                  "0 8px 32px rgba(0,0,0,0.28)",              // lift shadow
                  "0 2px 8px rgba(0,0,0,0.18)",               // close shadow
                ].join(","),
              }}
            >
              {/* Sliding glass indicator — smooth ease, no bounce */}
              <div
                aria-hidden
                style={{
                  position: "absolute",
                  top: PAD,
                  left: indicatorLeft,
                  width: BTN,
                  height: BTN,
                  borderRadius: 14,
                  background: "linear-gradient(160deg, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0.10) 100%)",
                  backdropFilter: "blur(8px)",
                  WebkitBackdropFilter: "blur(8px)",
                  border: "1px solid rgba(255,255,255,0.28)",
                  boxShadow: [
                    "inset 0 1.5px 0 rgba(255,255,255,0.55)",  // strong specular on the chip
                    "inset 0 -1px 0 rgba(0,0,0,0.12)",
                    "0 4px 16px rgba(0,0,0,0.2)",
                  ].join(","),
                  // Smooth ease — no bounce, fluid slide
                  transition: "left 0.38s cubic-bezier(0.65, 0, 0.35, 1)",
                  pointerEvents: "none",
                }}
              />

              {/* Buttons */}
              {VIEWS.map((view) => {
                const Icon = ICONS[view];
                const isActive = activeView === view;
                return (
                  <button
                    key={view}
                    onClick={() => {
                      if (view === "save") {
                        setSavePopoverOpen(prev => !prev);
                      } else {
                        handleViewSwitch(view);
                        setSavePopoverOpen(false);
                      }
                    }}
                    aria-label={LABELS[view]}
                    style={{
                      position: "relative",
                      zIndex: 1,
                      width: BTN,
                      height: BTN,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      borderRadius: 14,
                      background: "transparent",
                      border: "none",
                      cursor: "pointer",
                      color: isActive ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.45)",
                      transition: "color 0.25s ease, transform 0.12s ease",
                      WebkitTapHighlightColor: "transparent",
                    }}
                    onMouseDown={(e) => { (e.currentTarget as HTMLButtonElement).style.transform = "scale(0.88)"; }}
                    onMouseUp={(e) => { (e.currentTarget as HTMLButtonElement).style.transform = "scale(1)"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.transform = "scale(1)"; }}
                  >
                    <Icon size={20} strokeWidth={isActive ? 2.2 : 1.8} />
                  </button>
                );
              })}
            </div>
          </div>
        );
      })()}

    </div>
  );
}
