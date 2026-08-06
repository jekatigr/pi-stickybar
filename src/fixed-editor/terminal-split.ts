import { deleteAllKittyImages, isKeyRelease, type KeyId, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { FixedEditorClusterRender } from "./cluster.ts";

export interface TerminalLike {
  columns: number;
  rows: number;
  kittyProtocolActive?: boolean;
  write(data: string): void;
}

interface TerminalSplitCompositorOptions {
  tui: any;
  terminal: TerminalLike;
  renderCluster: (width: number, terminalRows: number) => FixedEditorClusterRender;
  getShowHardwareCursor?: () => boolean;
  mouseScroll?: boolean;
  onCopySelection?: (text: string) => void;
  /** Returns absolute root-line offsets to jump between (e.g. user prompt boundaries). */
  getMessageBoundaries?: (width: number) => number[];
  /** Key identifier (per pi-tui's matchesKey) for jumping to the previous user prompt. `null` disables it. Defaults to "ctrl+alt+up". */
  previousMessageKey?: KeyId | null;
  /** Key identifier for jumping to the next user prompt. `null` disables it. Defaults to "ctrl+alt+down". */
  nextMessageKey?: KeyId | null;
}

interface PatchedRenderable {
  render(width: number): string[];
}

interface RenderPatch {
  target: PatchedRenderable;
  originalRender: (width: number) => string[];
}

interface RenderPassCluster {
  width: number;
  terminalRows: number;
  cluster: FixedEditorClusterRender;
}

type CompositeLineAt = (
  baseLine: string,
  overlayLine: string,
  startCol: number,
  overlayWidth: number,
  totalWidth: number,
) => string;

interface SgrMousePacket {
  code: number;
  col: number;
  row: number;
  final: "M" | "m";
}

interface SelectionPoint {
  line: number;
  col: number;
}

type SelectionArea = "root" | "cluster";

interface SelectionLocation {
  area: SelectionArea;
  point: SelectionPoint;
}

interface DisposeOptions {
  resetExtendedKeyboardModes?: boolean;
}

type ExtendedKeyboardMode = "kitty" | "modifyOtherKeys";

const CONTEXT_MENU_MOUSE_REPORTING_PAUSE_MS = 1200;
const CONTEXT_MENU_SELECTION_RESTORE_WINDOW_MS = 5000;
const CONTEXT_MENU_CLIPBOARD_RESTORE_INTERVAL_MS = 100;
const DOUBLE_CLICK_MS = 500;
export function beginSynchronizedOutput(): string {
  return "\x1b[?2026h";
}

export function endSynchronizedOutput(): string {
  return "\x1b[?2026l";
}

export function setScrollRegion(top: number, bottom: number): string {
  return `\x1b[${top};${bottom}r`;
}

export function resetScrollRegion(): string {
  return "\x1b[r";
}

export function moveCursor(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

function clearLine(): string {
  return "\x1b[2K";
}

function hideCursor(): string {
  return "\x1b[?25l";
}

function showCursor(): string {
  return "\x1b[?25h";
}

function enterAlternateScreen(): string {
  return "\x1b[?1049h";
}

function exitAlternateScreen(): string {
  return "\x1b[?1049l";
}

function enableAlternateScrollMode(): string {
  return "\x1b[?1007h";
}

function disableAlternateScrollMode(): string {
  return "\x1b[?1007l";
}

function disableAutoWrap(): string {
  return "\x1b[?7l";
}

function enableAutoWrap(): string {
  return "\x1b[?7h";
}

function enableMouseReporting(): string {
  return "\x1b[?1002h\x1b[?1006h";
}

function disableMouseReporting(): string {
  return "\x1b[?1006l\x1b[?1002l\x1b[?1000l";
}

function enableExtendedKeyboardMode(mode: ExtendedKeyboardMode): string {
  return mode === "kitty" ? "\x1b[>7u" : "\x1b[>4;2m";
}

function disableExtendedKeyboardMode(mode: ExtendedKeyboardMode): string {
  return mode === "kitty" ? "\x1b[<u" : "\x1b[>4;0m";
}

function resetExtendedKeyboardModes(): string {
  return "\x1b[<999u\x1b[>4;0m";
}

export function emergencyTerminalModeReset(): string {
  return beginSynchronizedOutput()
    + resetScrollRegion()
    + disableMouseReporting()
    + enableAlternateScrollMode()
    + exitAlternateScreen()
    + resetExtendedKeyboardModes()
    + endSynchronizedOutput();
}

function parseKeyboardScrollDelta(data: string): number {
  if (isKeyRelease(data)) return 0;

  if (matchesKey(data, "pageUp")) return 10;
  if (matchesKey(data, "pageDown")) return -10;
  return 0;
}

function parseSgrMousePackets(data: string): SgrMousePacket[] | null {
  const pattern = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
  const packets: SgrMousePacket[] = [];
  let offset = 0;

  for (const match of data.matchAll(pattern)) {
    if (match.index !== offset) return null;
    offset = match.index + match[0].length;
    packets.push({
      code: Number(match[1]),
      col: Number(match[2]),
      row: Number(match[3]),
      final: match[4] as "M" | "m",
    });
  }

  return packets.length > 0 && offset === data.length ? packets : null;
}

function mouseBaseButton(code: number): number {
  return code & ~(4 | 8 | 16 | 32);
}

function mouseScrollDelta(packet: SgrMousePacket): number {
  if (packet.final !== "M") return 0;
  const baseButton = mouseBaseButton(packet.code);
  if (baseButton === 64) return 3;
  if (baseButton === 65) return -3;
  return 0;
}

function isLeftPress(packet: SgrMousePacket): boolean {
  return packet.final === "M" && mouseBaseButton(packet.code) === 0 && (packet.code & 32) === 0;
}

function isLeftDrag(packet: SgrMousePacket): boolean {
  return packet.final === "M" && mouseBaseButton(packet.code) === 0 && (packet.code & 32) !== 0;
}

function isRightPress(packet: SgrMousePacket): boolean {
  return packet.final === "M" && mouseBaseButton(packet.code) === 2 && (packet.code & 32) === 0;
}

function isMouseRelease(packet: SgrMousePacket): boolean {
  return packet.final === "m";
}

function stripOscSequences(line: string): string {
  return line.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
}

function stripAnsi(line: string): string {
  return stripOscSequences(line).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function sliceColumns(text: string, startCol: number, endCol: number): string {
  let col = 0;
  let result = "";
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const width = Math.max(0, visibleWidth(segment));
    if (col >= startCol && col < endCol) {
      result += segment;
    }
    col += width;
  }
  return result;
}

function compareSelectionPoints(a: SelectionPoint, b: SelectionPoint): number {
  return a.line === b.line ? a.col - b.col : a.line - b.line;
}

function bindPrototypeMethod<T extends object, K extends string>(target: T, name: K): ((...args: any[]) => any) | null {
  let current: object | null = target;
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor && typeof descriptor.value === "function") {
      return descriptor.value.bind(target);
    }
    current = Object.getPrototypeOf(current);
  }
  return null;
}

function descriptorForRows(terminal: TerminalLike): PropertyDescriptor | undefined {
  let target: object | null = terminal;
  while (target) {
    const descriptor = Object.getOwnPropertyDescriptor(target, "rows");
    if (descriptor) return descriptor;
    target = Object.getPrototypeOf(target);
  }

  return undefined;
}

function readRows(terminal: TerminalLike, descriptor: PropertyDescriptor | undefined): number {
  if (descriptor?.get) {
    const value = descriptor.get.call(terminal);
    return typeof value === "number" && Number.isFinite(value) ? value : 24;
  }

  const value = Reflect.get(terminal, "rows");
  return typeof value === "number" && Number.isFinite(value) ? value : 24;
}

function sanitizeLine(line: string, width: number): string {
  return visibleWidth(line) > width ? truncateToWidth(line, width, "", true) : line;
}

function sanitizeOverlayBaseLine(line: string, width: number): string {
  return sanitizeLine(stripOscSequences(line), width);
}

function normalizeOverlayCompositionLine(line: string): string {
  return line.includes("\t") ? line.replace(/\t/g, "   ") : line;
}

export function buildFixedClusterPaint(
  cluster: FixedEditorClusterRender,
  terminalRows: number,
  width: number,
  showHardwareCursor: boolean,
): string {
  if (cluster.lines.length === 0) return "";

  const startRow = Math.max(1, terminalRows - cluster.lines.length + 1);
  let buffer = resetScrollRegion();

  for (let i = 0; i < cluster.lines.length; i++) {
    buffer += moveCursor(startRow + i, 1);
    buffer += clearLine();
    buffer += sanitizeLine(cluster.lines[i] ?? "", width);
  }

  if (cluster.cursor) {
    // Keep the real terminal cursor parked at the logical editor cursor even
    // when it is visually hidden. macOS IME candidate windows anchor to the
    // terminal cursor position, so skipping the move when PI_HARDWARE_CURSOR is
    // off leaves the candidate window at a stale/offset location.
    buffer += moveCursor(startRow + cluster.cursor.row, Math.max(1, cluster.cursor.col + 1));
    buffer += showHardwareCursor ? showCursor() : hideCursor();
  } else {
    buffer += hideCursor();
  }

  return buffer;
}

export class TerminalSplitCompositor {
  private readonly tui: any;
  private readonly terminal: TerminalLike;
  private readonly renderCluster: (width: number, terminalRows: number) => FixedEditorClusterRender;
  private readonly getShowHardwareCursor: () => boolean;
  private readonly mouseScroll: boolean;
  private readonly onCopySelection: ((text: string) => void) | null;
  private readonly getMessageBoundaries: ((width: number) => number[]) | null;
  private readonly previousMessageKey: KeyId | null;
  private readonly nextMessageKey: KeyId | null;
  private extendedKeyboardMode: ExtendedKeyboardMode | null = null;
  private readonly rowsDescriptor: PropertyDescriptor | undefined;
  private readonly originalWrite: (data: string) => void;
  private readonly originalDoRender: (() => void) | null;
  private readonly originalRender: ((width: number) => string[]) | null;
  private originalCompositeLineAt: CompositeLineAt | null = null;
  private readonly patchedRenders: RenderPatch[] = [];
  private removeInputListener: (() => void) | null = null;
  private emergencyCleanup: (() => void) | null = null;
  private mouseReportingResumeTimer: ReturnType<typeof setTimeout> | null = null;
  private clipboardRestoreTimer: ReturnType<typeof setTimeout> | null = null;
  private installed = false;
  private disposed = false;
  private writing = false;
  private renderPassActive = false;
  private renderPassCluster: RenderPassCluster | null = null;
  private renderingCluster = false;
  private renderingScrollableRoot = false;
  private checkingOverlay = false;
  private scrollOffset = 0;
  private maxScrollOffset = 0;
  private lastRootLineCount = 0;
  private rootLines: string[] = [];
  private visibleRootStart = 0;
  private visibleScrollableRows = 0;
  private visibleRootLines: string[] = [];
  private visibleClusterLines: string[] = [];
  private selectionArea: SelectionArea | null = null;
  private selectionAnchor: SelectionPoint | null = null;
  private selectionFocus: SelectionPoint | null = null;
  private selectionDragging = false;
  private preserveSelectionFocusOnRelease = false;
  private lastLeftPress: { area: SelectionArea; line: number; at: number } | null = null;
  private pendingImageCleanup = false;
  private overlayViewportActive = false;

  constructor(options: TerminalSplitCompositorOptions) {
    this.tui = options.tui;
    this.terminal = options.terminal;
    this.renderCluster = options.renderCluster;
    this.getShowHardwareCursor = options.getShowHardwareCursor ?? (() => false);
    this.mouseScroll = options.mouseScroll !== false;
    this.onCopySelection = options.onCopySelection ?? null;
    this.getMessageBoundaries = options.getMessageBoundaries ?? null;
    this.previousMessageKey = options.previousMessageKey === undefined ? "ctrl+alt+up" : options.previousMessageKey;
    this.nextMessageKey = options.nextMessageKey === undefined ? "ctrl+alt+down" : options.nextMessageKey;
    this.rowsDescriptor = descriptorForRows(options.terminal);
    this.originalWrite = options.terminal.write.bind(options.terminal);
    // ctx.ui is a stable Proxy in newer Pi releases. Capturing
    // `options.tui.doRender.bind(options.tui)` would capture the proxy
    // forwarding function; after we patch doRender it forwards back to our
    // patch forever. Capture the prototype implementations instead.
    this.originalDoRender = bindPrototypeMethod(options.tui, "doRender");
    this.originalRender = bindPrototypeMethod(options.tui, "render");
  }

  install(): void {
    if (this.installed) return;
    if (typeof this.terminal.write !== "function") {
      throw new Error("[stickybar] Fixed editor compositor expected terminal.write(data) to exist");
    }

    this.originalWrite(
      beginSynchronizedOutput()
      + enterAlternateScreen()
      + this.enableAlternateScreenKeyboardMode()
      + disableAlternateScrollMode()
      + this.mouseReportingStateGuard()
      + endSynchronizedOutput(),
    );
    this.emergencyCleanup = () => {
      if (!this.disposed) {
        this.restoreTerminalStateForExit();
      }
    };
    process.once("exit", this.emergencyCleanup);

    Object.defineProperty(this.terminal, "rows", {
      configurable: true,
      get: () => this.getScrollableRows(),
    });

    if (this.originalRender) {
      this.tui.render = (width: number) => this.renderScrollableRoot(width);
    }

    if (typeof this.tui.addInputListener === "function") {
      this.removeInputListener = this.tui.addInputListener((data: string) => this.handleInput(data));
    }

    this.terminal.write = (data: string) => this.write(data);
    if (this.originalDoRender) {
      this.tui.doRender = () => {
        this.renderPassActive = true;
        this.renderPassCluster = null;
        try {
          this.originalDoRender?.();
          this.requestRepaint();
        } finally {
          this.renderPassActive = false;
          this.renderPassCluster = null;
        }
      };
    }
    const originalCompositeLineAt = bindPrototypeMethod(this.tui, "compositeLineAt");
    if (originalCompositeLineAt) {
      this.originalCompositeLineAt = originalCompositeLineAt as CompositeLineAt;
      this.tui.compositeLineAt = (
        baseLine: string,
        overlayLine: string,
        startCol: number,
        overlayWidth: number,
        totalWidth: number,
      ) => this.originalCompositeLineAt?.(
        normalizeOverlayCompositionLine(baseLine),
        normalizeOverlayCompositionLine(overlayLine),
        startCol,
        overlayWidth,
        totalWidth,
      ) ?? "";
    }
    this.installed = true;
  }

  hideRenderable(target: PatchedRenderable): void {
    if (this.patchedRenders.some((patch) => patch.target === target)) return;
    const originalRender = target.render.bind(target);
    this.patchedRenders.push({ target, originalRender });
    target.render = () => [];
  }

  renderHidden(target: PatchedRenderable, width: number): string[] {
    const patch = this.patchedRenders.find((candidate) => candidate.target === target);
    const render = patch?.originalRender ?? target.render.bind(target);
    return render(width);
  }

  jumpToPreviousRootTarget(targetLines: readonly number[]): boolean {
    return this.jumpToRootTarget(targetLines, "previous");
  }

  jumpToNextRootTarget(targetLines: readonly number[]): boolean {
    return this.jumpToRootTarget(targetLines, "next");
  }

  jumpToRootBottom(): boolean {
    return this.jumpToRootOffset(0);
  }

  jumpToRootTop(): boolean {
    return this.jumpToRootOffset(this.maxScrollOffset);
  }

  private getMessageBoundariesForCurrentWidth(): number[] {
    if (!this.getMessageBoundaries) return [];
    const width = Math.max(1, this.terminal.columns || 80);
    try {
      return this.getMessageBoundaries(width);
    } catch {
      return [];
    }
  }

  private jumpToRootOffset(offset: number): boolean {
    if (this.disposed || this.hasVisibleOverlay() || this.scrollOffset === offset) return false;
    this.clearSelection();
    this.lastLeftPress = null;
    this.scrollOffset = offset;
    this.pendingImageCleanup = true;
    this.updateVisibleRootWindow();
    this.requestRender();
    return true;
  }

  private jumpToRootTarget(targetLines: readonly number[], direction: "previous" | "next"): boolean {
    if (this.disposed || targetLines.length === 0 || this.hasVisibleOverlay()) return false;

    const start = this.visibleRootStart;
    const candidates = direction === "previous"
      ? targetLines.filter((line) => line < start).sort((a, b) => b - a)
      : targetLines.filter((line) => line > start).sort((a, b) => a - b);

    for (const target of candidates) {
      const nextOffset = Math.max(0, Math.min(
        this.lastRootLineCount - Math.max(1, this.visibleScrollableRows) - target,
        this.maxScrollOffset,
      ));
      if (nextOffset === this.scrollOffset) continue;

      this.clearSelection();
      this.lastLeftPress = null;
      this.scrollOffset = nextOffset;
      this.pendingImageCleanup = true;
      this.updateVisibleRootWindow();
      this.requestRender();
      return true;
    }

    return false;
  }

  requestRepaint(): void {
    if (this.disposed || this.hasVisibleOverlay()) return;
    const rawRows = this.getRawRows();
    const width = Math.max(1, this.terminal.columns || 80);
    const cluster = this.getCluster(width, rawRows);
    if (cluster.lines.length === 0) return;

    this.originalWrite(
      beginSynchronizedOutput()
      + disableAutoWrap()
      + buildFixedClusterPaint(this.decorateCluster(cluster), rawRows, width, this.getShowHardwareCursor())
      + enableAutoWrap()
      + this.mouseReportingStateGuard()
      + endSynchronizedOutput(),
    );
  }

  dispose(options: DisposeOptions = {}): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const patch of this.patchedRenders.splice(0)) {
      patch.target.render = patch.originalRender;
    }

    this.removeInputListener?.();
    this.removeInputListener = null;
    if (this.emergencyCleanup) {
      process.removeListener("exit", this.emergencyCleanup);
      this.emergencyCleanup = null;
    }
    if (this.mouseReportingResumeTimer) {
      clearTimeout(this.mouseReportingResumeTimer);
      this.mouseReportingResumeTimer = null;
    }
    if (this.clipboardRestoreTimer) {
      clearTimeout(this.clipboardRestoreTimer);
      this.clipboardRestoreTimer = null;
    }

    this.terminal.write = this.originalWrite;
    if (this.originalDoRender) {
      this.tui.doRender = this.originalDoRender;
    }
    if (this.originalRender) {
      this.tui.render = this.originalRender;
    }
    if (this.originalCompositeLineAt) {
      this.tui.compositeLineAt = this.originalCompositeLineAt;
      this.originalCompositeLineAt = null;
    }
    if (this.rowsDescriptor) {
      Object.defineProperty(this.terminal, "rows", this.rowsDescriptor);
    } else {
      Reflect.deleteProperty(this.terminal, "rows");
    }

    this.restoreTerminalState(options);
  }

  private getRawRows(): number {
    return Math.max(2, readRows(this.terminal, this.rowsDescriptor));
  }

  private getScrollableRows(): number {
    if (this.disposed || this.writing || this.renderingCluster || this.checkingOverlay || this.hasVisibleOverlay()) {
      return this.getRawRows();
    }

    const rawRows = this.getRawRows();
    const width = Math.max(1, this.terminal.columns || 80);
    const cluster = this.getCluster(width, rawRows);
    return Math.max(1, rawRows - cluster.lines.length);
  }

  private renderScrollableRoot(width: number): string[] {
    if (!this.originalRender || this.disposed || this.renderingScrollableRoot) {
      return this.originalRender?.(width) ?? [];
    }

    if (this.hasVisibleOverlay()) {
      // Pi owns the full terminal while an overlay is visible. Add virtual blank
      // rows equal to the overlay's height, so covered bottom content can move above
      // it without allowing the user to scroll into extra empty space.
      this.renderingScrollableRoot = true;
      try {
        const overlayWidth = Math.max(1, width);
        const allLines = this.originalRender(width);
        const termHeight = this.getRawRows();
        const virtualLength = allLines.length + this.overlayPaddingRows(overlayWidth, termHeight);
        this.rootLines = allLines;
        this.lastRootLineCount = allLines.length;
        this.maxScrollOffset = Math.max(0, virtualLength - termHeight);

        // Open with trailing padding already in view, lifting bottom content above
        // a bottom-anchored overlay. Normal mouse scrolling can still reveal earlier
        // transcript content without exposing extra blank space.
        if (!this.overlayViewportActive) {
          this.scrollOffset = this.maxScrollOffset;
          this.overlayViewportActive = true;
        }
        this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, this.maxScrollOffset));

        const sliced: string[] = [];
        for (let row = 0; row < termHeight; row++) {
          sliced.push(allLines[this.scrollOffset + row] ?? "\x1b[2K");
        }
        return sliced.map((line) => sanitizeOverlayBaseLine(line, overlayWidth));
      } finally {
        this.renderingScrollableRoot = false;
      }
    }

    // Closing an overlay always restores the regular fixed-editor bottom position.
    if (this.overlayViewportActive) {
      this.overlayViewportActive = false;
      this.scrollOffset = 0;
      this.pendingImageCleanup = true;
    }

    this.renderingScrollableRoot = true;
    try {
      const start = this.refreshRootWindow(width);
      return this.visibleRootLines.map((line, index) => {
        return this.renderSelectionHighlight(line, start + index, "root");
      });
    } finally {
      this.renderingScrollableRoot = false;
    }
  }

  private refreshRootWindow(width: number): number {
    if (!this.originalRender) return this.updateVisibleRootWindow();

    const rawRows = this.getRawRows();
    const renderWidth = Math.max(1, width);
    const cluster = this.getCluster(renderWidth, rawRows);
    const scrollableRows = Math.max(1, rawRows - cluster.lines.length);
    const lines = this.originalRender(renderWidth);
    this.rootLines = lines;
    if (this.scrollOffset > 0 && this.lastRootLineCount > 0 && lines.length > this.lastRootLineCount) {
      this.scrollOffset += lines.length - this.lastRootLineCount;
    }
    this.lastRootLineCount = lines.length;
    const previousMaxScrollOffset = this.maxScrollOffset;
    this.maxScrollOffset = Math.max(0, lines.length - scrollableRows);
    const nextScrollOffset = Math.max(0, Math.min(this.scrollOffset, this.maxScrollOffset));
    if (nextScrollOffset !== this.scrollOffset || this.maxScrollOffset !== previousMaxScrollOffset) {
      this.pendingImageCleanup = true;
    }
    this.scrollOffset = nextScrollOffset;

    return this.updateVisibleRootWindow(scrollableRows);
  }

  // Recomputes scroll bounds (max offset / clamped offset) from the *already cached*
  // `rootLines` without re-invoking the underlying app's full-tree render. `rootLines`
  // is kept fresh by `refreshRootWindow`, which runs on every real render pass
  // (`renderScrollableRoot`, driven by pi's own throttled render scheduler) - content
  // never changes purely as a result of scrolling, so reusing it here is safe and
  // avoids paying an O(transcript size) cost on every mouse-wheel/keyboard scroll tick.
  private syncScrollBounds(width: number): { cluster: FixedEditorClusterRender; scrollableRows: number } {
    const rawRows = this.getRawRows();
    const cluster = this.getCluster(width, rawRows);
    const scrollableRows = Math.max(1, rawRows - cluster.lines.length);
    const previousMaxScrollOffset = this.maxScrollOffset;
    this.maxScrollOffset = Math.max(0, this.rootLines.length - scrollableRows);
    const nextScrollOffset = Math.max(0, Math.min(this.scrollOffset, this.maxScrollOffset));
    if (nextScrollOffset !== this.scrollOffset || this.maxScrollOffset !== previousMaxScrollOffset) {
      this.pendingImageCleanup = true;
    }
    this.scrollOffset = nextScrollOffset;
    return { cluster, scrollableRows };
  }

  private handleInput(data: string): { consume?: boolean; data?: string } | undefined {
    if (this.disposed) return undefined;

    // When an overlay (e.g. an ask-user question / select list) is visible we still
    // want the mouse wheel to scroll the transcript behind it, but we must not steal
    // clicks/drags/keyboard input the overlay relies on. So: handle wheel-scroll only,
    // and let everything else fall through to the overlay untouched.
    const overlayVisible = this.hasVisibleOverlay();

    const mousePackets = this.mouseScroll ? parseSgrMousePackets(data) : null;
    if (mousePackets) {
      if (overlayVisible) {
        // Coalesce every scroll packet in this batch into a single scrollBy call so a
        // fast wheel/trackpad burst repaints once instead of once per packet.
        let scrollDelta = 0;
        for (const packet of mousePackets) scrollDelta += mouseScrollDelta(packet);
        if (scrollDelta !== 0) this.scrollBy(scrollDelta);
        // Consume only if we acted on a scroll event; otherwise pass through to the overlay.
        return scrollDelta !== 0 ? { consume: true } : undefined;
      }
      // Sum consecutive scroll packets into one repaint, but keep any click/drag/release
      // packets interleaved in the same batch handled individually and in order.
      let pendingScrollDelta = 0;
      for (const packet of mousePackets) {
        const delta = mouseScrollDelta(packet);
        if (delta !== 0) {
          pendingScrollDelta += delta;
          continue;
        }
        if (pendingScrollDelta !== 0) {
          this.selectionDragging = false;
          this.scrollBy(pendingScrollDelta);
          pendingScrollDelta = 0;
        }
        this.handleMousePacket(packet);
      }
      if (pendingScrollDelta !== 0) {
        this.selectionDragging = false;
        this.scrollBy(pendingScrollDelta);
      }
      return { consume: true };
    }

    // Keyboard scroll defers to overlays, which may bind the same keys.
    if (overlayVisible) return undefined;

    if (!isKeyRelease(data) && matchesKey(data, "home")) {
      this.jumpToRootTop();
      return { consume: true };
    }
    if (!isKeyRelease(data) && matchesKey(data, "end")) {
      this.jumpToRootBottom();
      return { consume: true };
    }
    if (this.previousMessageKey && !isKeyRelease(data) && matchesKey(data, this.previousMessageKey)) {
      // Once there's no earlier user prompt left, land on the very start of the thread.
      if (!this.jumpToPreviousRootTarget(this.getMessageBoundariesForCurrentWidth())) this.jumpToRootTop();
      return { consume: true };
    }
    if (this.nextMessageKey && !isKeyRelease(data) && matchesKey(data, this.nextMessageKey)) {
      // Once there's no later user prompt left, land on the very end of the thread.
      if (!this.jumpToNextRootTarget(this.getMessageBoundariesForCurrentWidth())) this.jumpToRootBottom();
      return { consume: true };
    }

    const keyboardDelta = parseKeyboardScrollDelta(data);
    if (keyboardDelta === 0) return undefined;
    this.scrollBy(keyboardDelta);
    return { consume: true };
  }

  private handleMousePacket(packet: SgrMousePacket): void {
    const delta = mouseScrollDelta(packet);
    if (delta !== 0) {
      this.selectionDragging = false;
      this.scrollBy(delta);
      return;
    }

    // Non-scroll packets (clicks/drags) need up-to-date visible-window bounds for
    // hit-testing, but must not pay the cost of re-rendering the entire transcript
    // (which `refreshRootWindow` does via the underlying app render). Reuse the
    // already-cached root lines and just resync the cheap viewport bookkeeping.
    const { scrollableRows } = this.syncScrollBounds(Math.max(1, this.terminal.columns || 80));
    this.updateVisibleRootWindow(scrollableRows);
    const location = this.selectionLocationForPacket(packet);

    if (isRightPress(packet)) {
      this.selectionDragging = false;
      this.preserveSelectionFocusOnRelease = false;
      const selectedText = this.isLocationInsideSelection(location) ? this.getSelectedText() : "";
      if (selectedText) {
        this.onCopySelection?.(selectedText);
        this.lastLeftPress = null;
        this.pauseMouseReportingForContextMenu(selectedText);
        return;
      }

      this.clearSelection();
      this.lastLeftPress = null;
      this.pauseMouseReportingForContextMenu();
      return;
    }

    if (this.scrollSelectionAtViewportEdge(packet)) return;
    if (this.selectionDragging && isMouseRelease(packet)) {
      this.finishSelection(packet, location);
      return;
    }

    if (!location) return;

    if (isLeftPress(packet)) {
      this.startSelection(location);
      return;
    }

    if (this.selectionDragging && isLeftDrag(packet) && location.area === this.selectionArea) {
      this.lastLeftPress = null;
      this.preserveSelectionFocusOnRelease = false;
      this.selectionFocus = location.point;
      this.requestRender();
      return;
    }
  }

  private updateVisibleRootWindow(scrollableRows = this.visibleScrollableRows): number {
    const rows = Math.max(1, scrollableRows);
    const start = Math.max(0, this.rootLines.length - rows - this.scrollOffset);
    const visibleLines = this.rootLines.slice(start, start + rows);
    while (visibleLines.length < rows) {
      visibleLines.push("");
    }

    this.visibleRootStart = start;
    this.visibleScrollableRows = rows;
    this.visibleRootLines = visibleLines;
    return start;
  }

  private finishSelection(packet: SgrMousePacket, location: SelectionLocation | null): void {
    if (!this.preserveSelectionFocusOnRelease) {
      this.selectionFocus = location?.area === this.selectionArea
        ? location.point
        : this.clampedSelectionPointForPacket(packet, this.selectionArea);
    }

    this.preserveSelectionFocusOnRelease = false;
    this.selectionDragging = false;
    const selectedText = this.getSelectedText();
    if (selectedText) {
      this.lastLeftPress = null;
      this.onCopySelection?.(selectedText);
    } else {
      this.clearSelection();
    }
    this.requestRender();
  }

    private startSelection(location: SelectionLocation): void {
    const now = Date.now();
    const line = location.point.line;
    if (
      this.lastLeftPress
      && this.lastLeftPress.area === location.area
      && this.lastLeftPress.line === line
      && now - this.lastLeftPress.at <= DOUBLE_CLICK_MS
    ) {
      this.selectionArea = location.area;
      this.selectionAnchor = { line, col: 0 };
      this.selectionFocus = { line, col: this.selectionLineWidth(location.area, line) };
      this.selectionDragging = true;
      this.preserveSelectionFocusOnRelease = true;
      this.lastLeftPress = null;
      this.requestRender();
      return;
    }

    this.selectionArea = location.area;
    this.selectionAnchor = location.point;
    this.selectionFocus = location.point;
    this.selectionDragging = true;
    this.preserveSelectionFocusOnRelease = false;
    this.lastLeftPress = { area: location.area, line, at: now };
    this.requestRender();
  }

  private selectionLocationForPacket(packet: SgrMousePacket): SelectionLocation | null {
    if (packet.row < 1) return null;

    const col = Math.max(0, packet.col - 1);
    if (packet.row <= this.visibleScrollableRows) {
      return {
        area: "root",
        point: { line: this.visibleRootStart + packet.row - 1, col },
      };
    }

    const clusterLine = packet.row - this.visibleScrollableRows - 1;
    if (clusterLine >= this.visibleClusterLines.length) return null;

    return {
      area: "cluster",
      point: { line: clusterLine, col },
    };
  }

  private scrollSelectionAtViewportEdge(packet: SgrMousePacket): boolean {
    if (!this.selectionDragging || this.selectionArea !== "root" || !isLeftDrag(packet)) return false;

    const delta = packet.row <= 1 ? 1 : packet.row >= this.visibleScrollableRows ? -1 : 0;
    if (delta === 0) return false;

    const nextOffset = Math.max(0, Math.min(this.scrollOffset + delta, this.maxScrollOffset));
    if (nextOffset === this.scrollOffset) return false;

    this.lastLeftPress = null;
    this.preserveSelectionFocusOnRelease = true;
    this.scrollOffset = nextOffset;
    this.pendingImageCleanup = true;
    const start = this.updateVisibleRootWindow();
    const edgeLine = delta > 0 ? start : start + Math.max(0, this.visibleScrollableRows - 1);
    this.selectionFocus = {
      line: edgeLine,
      col: Math.max(0, packet.col - 1),
    };
    this.requestRender();
    return true;
  }

  private clampedSelectionPointForPacket(packet: SgrMousePacket, area: SelectionArea | null): SelectionPoint {
    if (area === "cluster") {
      return {
        line: Math.max(0, Math.min(packet.row - this.visibleScrollableRows - 1, this.visibleClusterLines.length - 1)),
        col: Math.max(0, packet.col - 1),
      };
    }

    const row = Math.max(1, Math.min(packet.row, this.visibleScrollableRows));
    return {
      line: this.visibleRootStart + row - 1,
      col: Math.max(0, packet.col - 1),
    };
  }

  private renderSelectionHighlight(line: string, lineIndex: number, area: SelectionArea): string {
    const range = this.getSelectionRangeForLine(lineIndex, area);
    if (!range) return line;

    const plain = stripAnsi(line);
    const startCol = Math.max(0, Math.min(range.startCol, visibleWidth(plain)));
    const endCol = Math.max(startCol, Math.min(range.endCol, visibleWidth(plain)));
    if (startCol === endCol) return line;

    const before = sliceColumns(plain, 0, startCol);
    const selected = sliceColumns(plain, startCol, endCol);
    const after = sliceColumns(plain, endCol, Number.POSITIVE_INFINITY);
    return `${before}\x1b[7m${selected}\x1b[27m${after}`;
  }

  private selectionLineWidth(area: SelectionArea, lineIndex: number): number {
    const lines = area === "root" ? this.visibleRootLines : this.visibleClusterLines;
    const firstLine = area === "root" ? this.visibleRootStart : 0;
    return visibleWidth(stripAnsi(lines[lineIndex - firstLine] ?? ""));
  }

  private getSelectedText(): string {
    if (!this.selectionArea || !this.selectionAnchor || !this.selectionFocus) return "";

    const start = compareSelectionPoints(this.selectionAnchor, this.selectionFocus) <= 0
      ? this.selectionAnchor
      : this.selectionFocus;
    const end = start === this.selectionAnchor ? this.selectionFocus : this.selectionAnchor;
    if (start.line === end.line && start.col === end.col) return "";

    const lines = this.selectionArea === "root" ? this.rootLines : this.visibleClusterLines;
    const selected: string[] = [];
    for (let lineIndex = start.line; lineIndex <= end.line; lineIndex++) {
      const line = stripAnsi(lines[lineIndex] ?? "");
      const startCol = lineIndex === start.line ? start.col : 0;
      const endCol = lineIndex === end.line ? end.col : Number.POSITIVE_INFINITY;
      selected.push(sliceColumns(line, startCol, endCol));
    }

    return selected.join("\n").replace(/[ \t]+$/gm, "").trimEnd();
  }

  private getSelectionRangeForLine(lineIndex: number, area: SelectionArea): { startCol: number; endCol: number } | null {
    if (this.selectionArea !== area || !this.selectionAnchor || !this.selectionFocus) return null;

    const start = compareSelectionPoints(this.selectionAnchor, this.selectionFocus) <= 0
      ? this.selectionAnchor
      : this.selectionFocus;
    const end = start === this.selectionAnchor ? this.selectionFocus : this.selectionAnchor;
    if (lineIndex < start.line || lineIndex > end.line) return null;

    return {
      startCol: lineIndex === start.line ? start.col : 0,
      endCol: lineIndex === end.line ? end.col : Number.POSITIVE_INFINITY,
    };
  }

  private isLocationInsideSelection(location: SelectionLocation | null): boolean {
    if (!location || location.area !== this.selectionArea) return false;
    const range = this.getSelectionRangeForLine(location.point.line, location.area);
    return Boolean(range && location.point.col >= range.startCol && location.point.col < range.endCol);
  }

  private scrollBy(delta: number): void {
    const width = Math.max(1, this.terminal.columns || 80);

    if (this.hasVisibleOverlay()) {
      // Overlay uses a forward viewport start, unlike the normal bottom-relative
      // offset. Invert the wheel delta so scrolling feels identical in both modes.
      const nextOverlayOffset = Math.max(0, Math.min(this.scrollOffset - delta, this.maxScrollOffset));
      if (nextOverlayOffset === this.scrollOffset) return;
      this.clearSelection();
      this.lastLeftPress = null;
      this.scrollOffset = nextOverlayOffset;
      this.pendingImageCleanup = true;
      this.requestRender();
      return;
    }

    const { cluster } = this.syncScrollBounds(width);

    const nextOffset = Math.max(0, Math.min(this.scrollOffset + delta, this.maxScrollOffset));
    if (nextOffset === this.scrollOffset) return;

    this.clearSelection();
    this.lastLeftPress = null;
    this.scrollOffset = nextOffset;
    this.pendingImageCleanup = true;
    this.repaintScrollableViewport(width, cluster);
    this.requestRender();
  }

  private requestRender(): void {
    if (typeof this.tui.requestRender === "function") {
      this.tui.requestRender();
    }
  }

  private repaintScrollableViewport(width: number, cluster: FixedEditorClusterRender): void {
    if (this.disposed || this.writing || this.hasVisibleOverlay()) return;

    const rawRows = this.getRawRows();
    const scrollableRows = Math.max(1, rawRows - cluster.lines.length);
    const start = this.updateVisibleRootWindow(scrollableRows);
    let buffer = beginSynchronizedOutput()
      + this.consumePendingImageCleanup()
      + disableAutoWrap()
      + setScrollRegion(1, scrollableRows)
      + moveCursor(1, 1);

    for (let row = 0; row < scrollableRows; row++) {
      if (row > 0) buffer += "\r\n";
      buffer += clearLine();
      buffer += sanitizeLine(this.renderSelectionHighlight(this.visibleRootLines[row] ?? "", start + row, "root"), width);
    }

    buffer += buildFixedClusterPaint(this.decorateCluster(cluster), rawRows, width, this.getShowHardwareCursor());
    buffer += enableAutoWrap();
    buffer += this.mouseReportingStateGuard();
    buffer += endSynchronizedOutput();
    this.originalWrite(buffer);
  }

  private pauseMouseReportingForContextMenu(textToRestoreToClipboard: string | null = null): void {
    if (this.mouseReportingResumeTimer) {
      clearTimeout(this.mouseReportingResumeTimer);
    }
    if (this.clipboardRestoreTimer) {
      clearTimeout(this.clipboardRestoreTimer);
      this.clipboardRestoreTimer = null;
    }

    this.originalWrite(beginSynchronizedOutput() + disableMouseReporting() + endSynchronizedOutput());
    this.mouseReportingResumeTimer = setTimeout(() => {
      this.mouseReportingResumeTimer = null;
      if (!this.disposed) {
        this.originalWrite(beginSynchronizedOutput() + enableMouseReporting() + endSynchronizedOutput());
      }
    }, CONTEXT_MENU_MOUSE_REPORTING_PAUSE_MS);

    if (typeof this.mouseReportingResumeTimer === "object" && "unref" in this.mouseReportingResumeTimer) {
      this.mouseReportingResumeTimer.unref();
    }

    const restoreClipboard = this.onCopySelection;
    if (!textToRestoreToClipboard || !restoreClipboard) return;

    let remainingRestores = Math.ceil(CONTEXT_MENU_SELECTION_RESTORE_WINDOW_MS / CONTEXT_MENU_CLIPBOARD_RESTORE_INTERVAL_MS);
    const scheduleClipboardRestore = () => {
      this.clipboardRestoreTimer = setTimeout(() => {
        this.clipboardRestoreTimer = null;
        if (this.disposed) return;

        remainingRestores -= 1;
        if (this.getSelectedText() !== textToRestoreToClipboard) return;

        restoreClipboard(textToRestoreToClipboard);
        if (remainingRestores > 0) {
          scheduleClipboardRestore();
        }
      }, CONTEXT_MENU_CLIPBOARD_RESTORE_INTERVAL_MS);

      if (typeof this.clipboardRestoreTimer === "object" && "unref" in this.clipboardRestoreTimer) {
        this.clipboardRestoreTimer.unref();
      }
    };

    scheduleClipboardRestore();
  }

  private clearSelection(): void {
    this.selectionArea = null;
    this.selectionAnchor = null;
    this.selectionFocus = null;
    this.selectionDragging = false;
    this.preserveSelectionFocusOnRelease = false;
  }

  private activeExtendedKeyboardMode(): ExtendedKeyboardMode | null {
    if (this.terminal.kittyProtocolActive === true) return "kitty";
    if (Reflect.get(this.terminal, "_modifyOtherKeysActive") === true) return "modifyOtherKeys";
    return null;
  }

  private enableAlternateScreenKeyboardMode(): string {
    this.extendedKeyboardMode = this.activeExtendedKeyboardMode();
    return this.extendedKeyboardMode ? enableExtendedKeyboardMode(this.extendedKeyboardMode) : "";
  }

  private restoreTerminalState(options: DisposeOptions = {}): void {
    const activeMode = this.extendedKeyboardMode ?? this.activeExtendedKeyboardMode();
    const restoreMainScreenMode = !options.resetExtendedKeyboardModes && this.extendedKeyboardMode === null && activeMode !== null;

    this.originalWrite(
      beginSynchronizedOutput()
      + resetScrollRegion()
      + (this.mouseScroll ? disableMouseReporting() : "")
      + (activeMode ? disableExtendedKeyboardMode(activeMode) : "")
      + enableAlternateScrollMode()
      + exitAlternateScreen()
      + (restoreMainScreenMode && activeMode ? enableExtendedKeyboardMode(activeMode) : "")
      + (options.resetExtendedKeyboardModes ? resetExtendedKeyboardModes() : "")
      + endSynchronizedOutput(),
    );
  }

  private restoreTerminalStateForExit(): void {
    try {
      this.restoreTerminalState({ resetExtendedKeyboardModes: true });
    } catch {
      // Process-exit cleanup cannot report useful errors and must not throw.
    }
  }

  private write(data: string): void {
    if (this.disposed || this.writing) {
      this.originalWrite(data);
      return;
    }

    // When an overlay is visible, terminal.rows returns full height and pi-mono
    // renders to the entire screen. Skip our normal scroll region / cluster logic
    // which would restrict writes to rows 1-85 and clip the overlay content.
    if (this.hasVisibleOverlay()) {
      this.originalWrite(data);
      return;
    }

    this.writing = true;
    try {
      const rawRows = this.getRawRows();
      const width = Math.max(1, this.terminal.columns || 80);
      const cluster = this.getCluster(width, rawRows);
      const reservedRows = cluster.lines.length;

      if (reservedRows === 0 || rawRows <= 2) {
        this.originalWrite(data);
        return;
      }

      const scrollBottom = Math.max(1, rawRows - reservedRows);
      const hardwareCursorRow = typeof this.tui.hardwareCursorRow === "number"
        ? this.tui.hardwareCursorRow
        : typeof this.tui.cursorRow === "number"
          ? this.tui.cursorRow
          : 0;
      const viewportTop = typeof this.tui.previousViewportTop === "number" ? this.tui.previousViewportTop : 0;
      const screenRow = Math.max(1, Math.min(scrollBottom, hardwareCursorRow - viewportTop + 1));
      const buffer = beginSynchronizedOutput()
        + this.consumePendingImageCleanup()
        + disableAutoWrap()
        + setScrollRegion(1, scrollBottom)
        + moveCursor(screenRow, 1)
        + data
        + buildFixedClusterPaint(this.decorateCluster(cluster), rawRows, width, this.getShowHardwareCursor())
        + enableAutoWrap()
        + this.mouseReportingStateGuard()
        + endSynchronizedOutput();

      this.originalWrite(buffer);
    } finally {
      this.writing = false;
    }
  }

  private consumePendingImageCleanup(): string {
    if (!this.pendingImageCleanup) return "";
    this.pendingImageCleanup = false;
    return deleteAllKittyImages();
  }

  private mouseReportingStateGuard(): string {
    return this.mouseScroll && !this.mouseReportingResumeTimer ? enableMouseReporting() : "";
  }

  private getCluster(width: number, terminalRows: number): FixedEditorClusterRender {
    if (
      this.renderPassActive &&
      this.renderPassCluster?.width === width &&
      this.renderPassCluster.terminalRows === terminalRows
    ) {
      return this.renderPassCluster.cluster;
    }

    const cluster = this.withClusterRender(() => this.renderCluster(width, terminalRows));
    this.visibleClusterLines = cluster.lines;
    if (this.renderPassActive) {
      this.renderPassCluster = { width, terminalRows, cluster };
    }
    return cluster;
  }

  private decorateCluster(cluster: FixedEditorClusterRender): FixedEditorClusterRender {
    if (this.selectionArea !== "cluster") return cluster;

    return {
      ...cluster,
      lines: cluster.lines.map((line, index) => this.renderSelectionHighlight(line, index, "cluster")),
    };
  }

  private withClusterRender<T>(render: () => T): T {
    const wasRenderingCluster = this.renderingCluster;
    this.renderingCluster = true;
    try {
      return render();
    } finally {
      this.renderingCluster = wasRenderingCluster;
    }
  }

  private overlayPaddingRows(width: number, terminalRows: number): number {
    const stack = Reflect.get(this.tui, "overlayStack");
    const resolveLayout = Reflect.get(this.tui, "resolveOverlayLayout");
    if (!Array.isArray(stack) || typeof resolveLayout !== "function") return 1;

    let padding = 1;
    for (const entry of stack) {
      if (!entry || entry.hidden === true || !entry.component?.render) continue;
      try {
        const initial = resolveLayout.call(this.tui, entry.options, 0, width, terminalRows);
        let lines = entry.component.render(initial.width);
        if (initial.maxHeight !== undefined && lines.length > initial.maxHeight) {
          lines = lines.slice(0, initial.maxHeight);
        }
        padding = Math.max(padding, Math.min(terminalRows, lines.length));
      } catch {
        // A malformed third-party overlay should not break scrolling.
      }
    }
    return padding;
  }

  private hasVisibleOverlay(): boolean {
    if (this.checkingOverlay) return false;

    this.checkingOverlay = true;
    try {
      if (typeof this.tui.hasOverlay === "function" && this.tui.hasOverlay()) {
        return true;
      }

      const overlayStack = Reflect.get(this.tui, "overlayStack");
      if (!Array.isArray(overlayStack)) {
        return false;
      }

      return overlayStack.some((entry) => entry && entry.hidden !== true);
    } finally {
      this.checkingOverlay = false;
    }
  }
}
