// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimelineView } from "./TimelineView";
import type { Marker } from "./types";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const markers: Marker[] = [
  { key: "first", recordedAtMs: 2_000, source: "manual" },
  { key: "second", recordedAtMs: 8_000, source: "manual" },
];

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("TimelineView marker selection", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function renderTimeline(onDeleteMarker = vi.fn()) {
    act(() => {
      root.render(
        <TimelineView
          startMs={0}
          endMs={10_000}
          markers={markers}
          video={null}
          playheadMs={null}
          onMoveMarker={vi.fn()}
          onDeleteMarker={onDeleteMarker}
          onSeek={vi.fn()}
        />,
      );
    });
    return onDeleteMarker;
  }

  it.each(["Delete", "Backspace"])("deletes the selected marker with %s", (key) => {
    const onDeleteMarker = renderTimeline();
    const marker = container.querySelector<HTMLButtonElement>("[aria-label='第 1 個時間針']")!;

    act(() => marker.click());
    expect(marker.classList.contains("is-selected")).toBe(true);
    expect(marker.getAttribute("aria-pressed")).toBe("true");

    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    act(() => document.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
    expect(onDeleteMarker).toHaveBeenCalledOnce();
    expect(onDeleteMarker).toHaveBeenCalledWith("first");
    expect(marker.getAttribute("aria-pressed")).toBe("false");
  });

  it("does not delete while editing an input", () => {
    const onDeleteMarker = renderTimeline();
    const marker = container.querySelector<HTMLButtonElement>("[aria-label='第 1 個時間針']")!;
    const input = document.createElement("input");
    document.body.append(input);

    act(() => marker.click());
    input.focus();
    const event = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
    act(() => input.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(false);
    expect(onDeleteMarker).not.toHaveBeenCalled();
    expect(marker.getAttribute("aria-pressed")).toBe("true");
    input.remove();
  });
});
