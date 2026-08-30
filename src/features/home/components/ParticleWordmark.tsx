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
  containerRef: RefObject<HTMLDivElement | null>;
  enabled?: boolean;
}

export function ParticleWordmark({
  containerRef,
  enabled = true,
}: ParticleWordmarkProps) {
  useEffect(() => {
    if (!enabled) return;
    // jsdom (unit tests) has no matchMedia — treat it as "no preference".
    if (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const container = containerRef.current;
    if (!container) return;
    // Hoisted function declarations below would lose the null narrowing,
    // so capture the container in a fresh const for the closures.
    const root: HTMLElement = container;

    const engine = new ParticleWordmarkEngine(root, PARTICLE_OPTIONS);
    let cancelled = false;

    /**
     * Reserves the zoomed layout height synchronously, before the first
     * paint, so the composer panel never gets pushed down after the canvas
     * appears. The wrapper carries the padding; the engine only measures
     * the padding-free `.home-chat-hero` inside it.
     */
    function reserveLayout(): void {
      const content = root.querySelector<HTMLElement>(
        PARTICLE_OPTIONS.contentSelector,
      );
      if (!content) return;
      const height = content.getBoundingClientRect().height;
      if (height <= 0) return;
      const pad = ((PARTICLE_OPTIONS.zoom - 1) * height) / 2;
      root.style.padding = `${pad}px 0`;
    }

    function releaseLayout(): void {
      root.style.padding = "";
    }

    // Wait for web fonts so the title is rasterized with the final typeface.
    // The loading class hides the original wordmark during the async build
    // so it never flashes before the particle canvas takes over.
    // (jsdom has no FontFaceSet — fall back to building immediately.)
    const fontsReady: Promise<unknown> =
      typeof document.fonts?.ready?.then === "function"
        ? document.fonts.ready
        : Promise.resolve();
    void fontsReady.then(async () => {
      if (cancelled) return;
      reserveLayout();
      root.classList.add("home-chat-particle-loading");
      const tookOver = await engine.build();
      root.classList.remove("home-chat-particle-loading");
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
      root.classList.remove("home-chat-particle-loading");
      engine.destroy();
      releaseLayout();
    };
  }, [containerRef, enabled]);

  return null;
}
