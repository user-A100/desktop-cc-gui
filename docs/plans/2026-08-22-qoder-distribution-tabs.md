# Qoder Distribution Tabs Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the Qoder Global/CN settings-card stack with one accessible, smoothly switching distribution Tab view.

**Architecture:** Keep the existing `qoder` parent page and all distribution-aware configuration, auth, Doctor, and persistence code intact. Add local presentation state in `VendorSettingsPanel`; the selected Tab is Global by default and synchronizes only with the existing Qoder settings deep-link input.

**Tech Stack:** React, TypeScript, Vitest, existing vendor settings CSS tokens.

---

### Task 1: Specify and test selected distribution behavior

**Files:**
- Modify: `src/features/vendors/components/VendorSettingsPanel.test.tsx`

**Step 1:** Assert the default Qoder page exposes `Qoder Global` as the selected Tab and does not render CN inputs.

**Step 2:** Assert the Qoder CN deep link selects the CN Tab and exposes only CN controls.

**Step 3:** Assert clicking the CN Tab switches visible controls without mutating Global configuration.

**Step 4:** Run `pnpm vitest run src/features/vendors/components/VendorSettingsPanel.test.tsx` and confirm the new assertions initially fail.

### Task 2: Implement the Tab presentation state

**Files:**
- Modify: `src/features/vendors/components/VendorSettingsPanel.tsx`

**Step 1:** Replace scroll-to-card refs with a local `activeQoderDistribution` state seeded from the deep-link distribution or Global.

**Step 2:** Render a semantic `tablist` and one active distribution card; retain the existing distribution-specific save, auth, custom-path, and Doctor paths unchanged.

**Step 3:** Ensure a later Qoder deep link switches the selected Tab without scrolling or catalog IPC.

**Step 4:** Rerun the focused Vitest file and confirm it passes.

### Task 3: Add token-based Tab styling and verify

**Files:**
- Modify: `src/styles/settings.part1.vendor-panels.css`
- Modify: `openspec/changes/add-qoder-dual-distribution/{design,tasks}.md`

**Step 1:** Add Qoder-scoped Tab styles using existing settings tokens, 160ms opacity/transform entry, responsive layout, and `prefers-reduced-motion` fallback.

**Step 2:** Update D4 and the Qoder UI specification wording from stacked cards to isolated Tab panels; record the task as complete after implementation.

**Step 3:** Run the focused test, `pnpm typecheck`, `openspec validate add-qoder-dual-distribution --strict --no-interactive`, and `git diff --check`.

**Step 4:** Do not commit: the user requested that existing worktree changes remain untouched.
