import { useEffect, type RefObject } from "react";
import {
  ParticleWordmarkEngine,
  type ParticleWordmarkOptions,
} from "../particle/particleWordmarkEngine";

/**
 * Particle wordmark overlay for the home hero — a React port of the
 * First Light (Obsidian plugin) particle effect.
 *
 * The engine rasterizes the existing logo + title DOM into a particle
 * canvas and hides the originals (visibility, so layout is preserved).
 * Rendering nothing itself, it simply takes over the referenced container.
 *
 * The container is the padding-carrying wrapper; the measured content is
 * the `.home-chat-hero` inside it, so the zoom reservation never corrupts
 * the sampling metrics (same split as the original Svelte component).
 *
 * `monochrome: false` keeps the colors sampled from the live DOM, so the
 * particles automatically follow the current theme's text color.
 */
const PARTICLE_OPTIONS: ParticleWordmarkOptions = {
  monochrome: false,
  color: "#6C31E3",
  zoom: 1.6,
  spacing: 2,
  dotSize: 0.5,
  repulsionRadius: 124,
  repulsionStrength: 1.8,
  logoSelector: ".home-chat-engine-mark",
  titleSelector: ".home-chat-title",
  contentSelector: ".home-chat-hero",
};

interface ParticleWordmarkProps {
  containerRef: RefObject<HTMLElement | null>;
  enabled?: boolean;
}

export function ParticleWordmark({
  containerRef,
  enabled = true,
}: ParticleWordmarkProps) {
  useEffect(() => {
    if (!enabled) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const container = containerRef.current;
    if (!container) return;

    const engine = new ParticleWordmarkEngine(container, PARTICLE_OPTIONS);
    let cancelled = false;

    /**
     * Reserves the zoomed layout height synchronously, before the first
     * paint, so the composer panel never gets pushed down after the canvas
     * appears. The wrapper carries the padding; the engine only measures
     * the padding-free `.home-chat-hero` inside it.
     */
    function reserveLayout(): void {
      const content = container.querySelector<HTMLElement>(
        PARTICLE_OPTIONS.contentSelector,
      );
      if (!content) return;
      const height = content.getBoundingClientRect().height;
      if (height <= 0) return;
      const pad = ((PARTICLE_OPTIONS.zoom - 1) * height) / 2;
      container.style.padding = `${pad}px 0`;
    }

    function releaseLayout(): void {
      container.style.padding = "";
    }

    // Wait for web fonts so the title is rasterized with the final typeface.
    // The loading class hides the original wordmark during the async build
    // so it never flashes before the particle canvas takes over.
    void document.fonts.ready.then(async () => {
      if (cancelled) return;
      reserveLayout();
      container.classList.add("home-chat-particle-loading");
      const tookOver = await engine.build();
      container.classList.remove("home-chat-particle-loading");
      if (cancelled) return;
      if (!tookOver) {
        releaseLayout();
        engine.destroy();
      }
    });

    // Re-sample when the theme flips so particle colors stay in sync.
    let refreshTimer: number | null = null;
    const themeObserver = new MutationObserver(() => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void engine.refresh();
      }, 250);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });

    return () => {
      cancelled = true;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      themeObserver.disconnect();
      container.classList.remove("home-chat-particle-loading");
      engine.destroy();
      releaseLayout();
    };
  }, [containerRef, enabled]);

  return null;
}
