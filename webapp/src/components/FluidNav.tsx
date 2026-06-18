"use client";

import { useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useProximityHover } from "@/hooks/use-proximity-hover";

const spring = {
  fast: { type: "spring" as const, duration: 0.08, bounce: 0 },
  moderate: { type: "spring" as const, duration: 0.16, bounce: 0.08 },
};

export interface FluidNavItem {
  key: string;
  label: string;
  icon?: React.ReactNode;
}

interface FluidNavProps {
  items: FluidNavItem[];
  selectedKey: string;
  onSelect: (key: string) => void;
  /** "vertical" for sidebar list, "horizontal" for tab strip */
  orientation?: "vertical" | "horizontal";
  className?: string;
  /** Tailwind classes for each item row/pill */
  itemClassName?: string;
  /** Color for the selected item text */
  selectedColor?: string;
  /** BG class for the selected indicator */
  selectedBg?: string;
  /** BG class for the hover indicator */
  hoverBg?: string;
}

export function FluidNav({
  items,
  selectedKey,
  onSelect,
  orientation = "vertical",
  className = "",
  itemClassName = "",
  selectedColor = "#3d7a64",
  selectedBg = "bg-white shadow-sm",
  hoverBg = "bg-black/[0.04]",
}: FluidNavProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const itemEls = useRef<Map<number, HTMLElement>>(new Map());

  const axis = orientation === "horizontal" ? "x" : "y";

  const {
    activeIndex,
    itemRects,
    sessionRef,
    handlers,
    registerItem,
    measureItems,
  } = useProximityHover(containerRef, { axis });

  useEffect(() => {
    measureItems();
  }, [items, measureItems]);

  const selectedIndex = items.findIndex((i) => i.key === selectedKey);
  const selectedRect = selectedIndex >= 0 ? itemRects[selectedIndex] : null;
  const activeRect = activeIndex !== null ? itemRects[activeIndex] : null;
  const isHoveringOther = activeIndex !== null && activeIndex !== selectedIndex;

  const direction = orientation === "horizontal" ? "flex-row" : "flex-col";

  return (
    <div
      ref={containerRef}
      className={`relative flex ${direction} gap-0.5 ${className}`}
      onMouseMove={handlers.onMouseMove}
      onMouseEnter={handlers.onMouseEnter}
      onMouseLeave={handlers.onMouseLeave}
    >
      {/* Selected indicator */}
      <AnimatePresence>
        {selectedRect && (
          <motion.div
            className={`absolute rounded-lg pointer-events-none ${selectedBg}`}
            initial={false}
            animate={{
              top: selectedRect.top,
              left: selectedRect.left,
              width: selectedRect.width,
              height: selectedRect.height,
              opacity: isHoveringOther ? 0.85 : 1,
            }}
            exit={{ opacity: 0, transition: spring.moderate }}
            transition={{ ...spring.moderate, opacity: { duration: 0.08 } }}
          />
        )}
      </AnimatePresence>

      {/* Hover indicator */}
      <AnimatePresence>
        {activeRect && (
          <motion.div
            key={sessionRef.current}
            className={`absolute rounded-lg pointer-events-none ${hoverBg}`}
            initial={{
              opacity: 0,
              top: selectedRect?.top ?? activeRect.top,
              left: selectedRect?.left ?? activeRect.left,
              width: selectedRect?.width ?? activeRect.width,
              height: selectedRect?.height ?? activeRect.height,
            }}
            animate={{
              opacity: 1,
              top: activeRect.top,
              left: activeRect.left,
              width: activeRect.width,
              height: activeRect.height,
            }}
            exit={{ opacity: 0, transition: spring.fast }}
            transition={{ ...spring.fast, opacity: { duration: 0.08 } }}
          />
        )}
      </AnimatePresence>

      {items.map((item, index) => {
        const isSelected = item.key === selectedKey;
        const isActive = activeIndex === index;

        return (
          <div
            key={item.key}
            ref={(el) => registerItem(index, el)}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(item.key)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(item.key);
              }
            }}
            className={`relative z-10 flex items-center gap-1.5 cursor-pointer rounded-lg outline-none select-none ${itemClassName}`}
          >
            {item.icon && (
              <span
                style={{
                  color: isSelected || isActive ? selectedColor : "#3a3a3a66",
                  transition: "color 0.1s",
                }}
              >
                {item.icon}
              </span>
            )}
            <span
              style={{
                color: isSelected ? selectedColor : isActive ? "#3a3a3a" : "#3a3a3a99",
                fontWeight: isSelected ? 500 : 400,
                transition: "color 0.1s",
              }}
            >
              {item.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
